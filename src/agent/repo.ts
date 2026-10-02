/**
 * Access to the tests repository: locating files (paths in traces come from
 * the CI agent and do not match the local checkout) and running a single test.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const kIgnoredDirs = new Set(['node_modules', '.git', 'test-results', 'playwright-report', 'extended-report', 'blob-report', 'dist', '.pw-extended-report']);

export class Repo {
  readonly dir: string;
  readonly configFile?: string;
  private _files: string[] | undefined;

  constructor(dir: string, configFile?: string) {
    this.dir = path.resolve(dir);
    this.configFile = configFile ? path.resolve(this.dir, configFile) : undefined;
  }

  /** Repo-relative POSIX path of the file matching `anyPath` (absolute CI path or relative), if any. */
  find(anyPath: string): string | undefined {
    const normalized = anyPath.replace(/\\/g, '/');
    const direct = path.isAbsolute(anyPath) ? anyPath : path.join(this.dir, anyPath);
    if (this.isInside(direct) && fs.existsSync(direct) && fs.statSync(direct).isFile())
      return this.relative(direct);
    const segments = normalized.split('/').filter(Boolean);
    const files = this._index();
    // Longest matching tail wins: ci/workspace/proj/tests/a.spec.ts -> tests/a.spec.ts
    for (let k = segments.length; k >= 1; k--) {
      const tail = '/' + segments.slice(-k).join('/');
      const matches = files.filter(f => ('/' + f).endsWith(tail));
      if (matches.length === 1)
        return matches[0];
      if (matches.length > 1 && k === segments.length)
        return matches[0];
    }
    return undefined;
  }

  read(relativePath: string): string {
    return fs.readFileSync(this.absolute(relativePath), 'utf-8');
  }

  write(relativePath: string, content: string) {
    fs.writeFileSync(this.absolute(relativePath), content);
  }

  absolute(relativePath: string): string {
    const file = path.resolve(this.dir, relativePath);
    if (!this.isInside(file))
      throw new Error(`refusing to touch a file outside the repository: ${relativePath}`);
    if (file.split(path.sep).some(segment => segment === 'node_modules' || segment === '.git'))
      throw new Error(`refusing to touch ${relativePath}`);
    return file;
  }

  relative(absolutePath: string): string {
    return path.relative(this.dir, absolutePath).split(path.sep).join('/');
  }

  private isInside(file: string): boolean {
    const relative = path.relative(this.dir, path.resolve(file));
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  private _index(): string[] {
    if (this._files)
      return this._files;
    const files: string[] = [];
    const walk = (dir: string) => {
      if (files.length > 30000)
        return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!kIgnoredDirs.has(entry.name) && !entry.name.startsWith('.'))
            walk(path.join(dir, entry.name));
        } else if (/\.(m?[jt]sx?|cjs|cts|mts)$/.test(entry.name)) {
          files.push(this.relative(path.join(dir, entry.name)));
        }
      }
    };
    walk(this.dir);
    this._files = files;
    return files;
  }
}

function stripAnsi(text: string | undefined): string | undefined {
  return text?.replace(/\u001b\[[0-9;]*m/g, '');
}

export type RunResult = {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted' | 'not-found' | 'error';
  error?: string;
  durationMs?: number;
  tracePath?: string;
  /** Last lines of the runner output, for diagnostics. */
  output: string;
};

export type TestRef = { file: string, line: number, projectName?: string, title?: string };

/** Runs one test (see runTests). */
export async function runSingleTest(repo: Repo, test: TestRef, onLog: (line: string) => void, timeoutMs = 5 * 60_000): Promise<RunResult> {
  const [result] = (await runTests(repo, [test], onLog, timeoutMs)).tests;
  return result;
}

/**
 * Runs tests with the repository's own Playwright: no retries, trace on, JSON reporter
 * (so that the project's reporters, including this one, do not overwrite reports).
 * One result per requested test, in the same order.
 */
export async function runTests(repo: Repo, tests: TestRef[], onLog: (line: string) => void, timeoutMs = 10 * 60_000): Promise<{ tests: RunResult[], output: string }> {
  const fail = (error: string, output = ''): { tests: RunResult[], output: string } => ({ tests: tests.map(() => ({ status: 'error', error, output })), output });
  let cli: string;
  try {
    cli = require.resolve('@playwright/test/cli', { paths: [repo.dir] });
  } catch {
    try {
      cli = require.resolve('playwright/cli', { paths: [repo.dir] });
    } catch {
      return fail(`@playwright/test is not installed in ${repo.dir}`);
    }
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-extended-run-'));
  const jsonFile = path.join(outDir, 'result.json');
  const filters = tests.map(t => `${repo.find(t.file) ?? t.file}:${t.line}`);
  const projects = [...new Set(tests.map(t => t.projectName).filter(Boolean))] as string[];
  const args = [cli, 'test', ...new Set(filters), '--retries=0', '--trace=on', '--workers=1', '--reporter=json', `--output=${path.join(outDir, 'results')}`];
  for (const project of projects)
    args.push(`--project=${project}`);
  if (repo.configFile)
    args.push('-c', repo.configFile);
  onLog(`$ npx playwright ${args.slice(1).join(' ')}`);

  const started = Date.now();
  const { stdout, stderr, code } = await new Promise<{ stdout: string, stderr: string, code: number | null }>(resolve => {
    const child = spawn(process.execPath, args, {
      cwd: repo.dir,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: jsonFile, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonFile, CI: process.env.CI ?? '1', PW_TEST_HTML_REPORT_OPEN: 'never', PLAYWRIGHT_HTML_OPEN: 'never' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => {
      err += d;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', exitCode => {
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, code: exitCode });
    });
  });
  const output = (stderr + '\n' + stdout).split('\n').slice(-40).join('\n');

  let report: any;
  try {
    report = JSON.parse(fs.existsSync(jsonFile) ? fs.readFileSync(jsonFile, 'utf-8') : stdout);
  } catch {
    return fail(`Could not read the run result (exit code ${code}).`, output);
  }
  const specs: { file: string, line: number, projectName: string, result: any }[] = [];
  const visit = (suite: any) => {
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || [])
        specs.push({ file: spec.file, line: spec.line, projectName: t.projectName, result: (t.results || [])[t.results.length - 1] });
    }
    for (const child of suite.suites || [])
      visit(child);
  };
  for (const suite of report.suites || [])
    visit(suite);
  const topError = report.errors?.[0]?.message;
  const results: RunResult[] = tests.map((t, i) => {
    const filter = filters[i].replace(/:\d+$/, '');
    const spec = specs.find(s => s.line === t.line && (filter.endsWith(s.file) || s.file.endsWith(path.basename(filter))) && (!t.projectName || s.projectName === t.projectName));
    if (!spec?.result)
      return { status: topError ? 'error' : 'not-found', error: stripAnsi(topError) ?? `No test found at ${filters[i]}`, output, durationMs: Date.now() - started };
    const trace = (spec.result.attachments || []).find((a: any) => a.name === 'trace' && a.path);
    return {
      status: spec.result.status,
      error: stripAnsi(spec.result.errors?.map((e: any) => e.message).join('\n\n') || spec.result.error?.message),
      durationMs: spec.result.duration,
      tracePath: trace?.path,
      output,
    };
  });
  return { tests: results, output };
}
