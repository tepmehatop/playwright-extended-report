/**
 * The test agent behind the "Ask AI" / "Fix" buttons.
 *
 * It is orchestrated by code, not by the model: we read the trace, rebuild the DOM,
 * look for locator candidates, re-run the test and apply edits ourselves; the model
 * only reasons over the collected evidence and answers in plain text. This works with
 * internal models that have weak or no tool calling (GigaChat, small qwen, ...).
 *
 * HTTP API (mounted by `pw-extended-report show --ai` / `agent` / `ai-gateway`):
 *   GET  /api/agent/status
 *   POST /api/agent/jobs        {kind: analyze | debug | fix | apply | revert, ...}
 *   GET  /api/agent/jobs/<id>
 *   GET  /api/ai/status, POST /api/ai/ask   (simple prompt -> answer, kept for custom UIs)
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { buildEvidence, sourceForPath } from './evidence';
import { applyEditBlocks, parseEditBlocks } from './edits';
import { chat, describeLlm } from './llm';
import { analyzePrompt, debugPrompt, fixPrompt, fixRetryMessage, systemPrompt } from './prompts';
import { runSingleTest } from './repo';
import { readTrace } from './trace';

import type http from 'http';
import type { Evidence, ReportTestCase } from './evidence';
import type { ChatMessage, LlmConfig } from './llm';
import type { Repo, RunResult } from './repo';
import type { TraceData } from './trace';
import type { InsightTest } from '../shared/insightsFormat';

export type AgentOptions = {
  llm: LlmConfig;
  /** Report folder served by us: traces are read from disk instead of being uploaded. */
  reportDir?: string;
  /** Tests repository: enables "Run & debug" and applying fixes. */
  repo?: Repo;
  corsOrigin?: string;
};

export type JobKind = 'analyze' | 'debug' | 'fix' | 'apply' | 'revert';

export type JobRequest = {
  kind: JobKind;
  test: ReportTestCase;
  attempt?: number;
  insight?: InsightTest;
  /** Report-relative path of trace.zip, e.g. data/<sha1>.zip */
  tracePath?: string;
  traceBase64?: string;
  errorContext?: string;
  comment?: string;
  /** Previous analysis to build the fix on. */
  analysis?: string;
  /** For apply / revert. */
  fixId?: string;
  /** Error of a fix that did not help, to get a different proposal. */
  previousFixError?: string;
};

export type FixProposal = {
  id: string;
  explanation: string;
  files: { file: string, diff: string, inRepo: boolean }[];
  canApply: boolean;
  applied?: boolean;
  reverted?: boolean;
  verify?: { status: string, error?: string, durationMs?: number };
};

export type JobState = {
  id: string;
  kind: JobKind;
  status: 'running' | 'done' | 'error';
  log: { time: number, text: string }[];
  result?: {
    markdown?: string;
    evidence?: string;
    prompt?: string;
    model?: string;
    fix?: FixProposal;
    rerun?: { status: string, error?: string, durationMs?: number };
  };
  error?: string;
};

type StoredFix = { proposal: FixProposal, edits: { file: string, oldContent: string, newContent: string, inRepo: boolean }[], test: ReportTestCase };

export class AgentService {
  private _options: AgentOptions;
  private _jobs = new Map<string, JobState>();
  private _fixes = new Map<string, StoredFix>();

  constructor(options: AgentOptions) {
    this._options = options;
  }

  status() {
    return {
      enabled: true,
      model: describeLlm(this._options.llm),
      provider: this._options.llm.provider,
      canRun: !!this._options.repo,
      canApply: !!this._options.repo,
      repo: this._options.repo?.dir,
      tracesFromDisk: !!this._options.reportDir,
    };
  }

  /** Returns false when the URL is not ours. */
  handle(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    const url = new URL(request.url || '/', 'http://localhost');
    const p = url.pathname;
    if (!p.includes('/api/agent/') && !p.endsWith('/api/ai/status') && !p.endsWith('/api/ai/ask'))
      return false;
    if (this._options.corsOrigin) {
      response.setHeader('Access-Control-Allow-Origin', this._options.corsOrigin);
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return true;
      }
    }
    const reply = (status: number, body: unknown) => {
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(body));
    };
    if (p.endsWith('/api/agent/status') || p.endsWith('/api/ai/status')) {
      reply(200, this.status());
      return true;
    }
    const jobMatch = p.match(/\/api\/agent\/jobs\/([\w-]+)$/);
    if (jobMatch && request.method === 'GET') {
      const job = this._jobs.get(jobMatch[1]);
      reply(job ? 200 : 404, job ?? { error: 'job not found' });
      return true;
    }
    if (request.method !== 'POST') {
      reply(405, { error: 'POST expected' });
      return true;
    }
    readBody(request).then(async body => {
      const json = JSON.parse(body);
      if (p.endsWith('/api/ai/ask')) {
        const answer = await chat(this._options.llm, [{ role: 'system', content: systemPrompt(this._options.llm.language) }, { role: 'user', content: String(json.prompt || '') }], () => 'Mock answer: configure a model to get a real analysis.');
        reply(200, { markdown: answer.content, model: answer.model });
        return;
      }
      if (p.endsWith('/api/agent/jobs')) {
        const job = this.start(json as JobRequest);
        reply(200, { id: job.id });
        return;
      }
      reply(404, { error: 'not found' });
    }).catch(e => reply(400, { error: String(e?.message || e) }));
    return true;
  }

  start(request: JobRequest): JobState {
    const job: JobState = { id: crypto.randomUUID(), kind: request.kind, status: 'running', log: [] };
    this._jobs.set(job.id, job);
    // Keep memory bounded.
    if (this._jobs.size > 200)
      this._jobs.delete(this._jobs.keys().next().value!);
    const log = (text: string) => job.log.push({ time: Date.now(), text });
    this._run(request, job, log).then(() => {
      job.status = 'done';
    }).catch(e => {
      job.status = 'error';
      job.error = String(e?.message || e);
      log(`Error: ${job.error}`);
    });
    return job;
  }

  private async _run(request: JobRequest, job: JobState, log: (text: string) => void) {
    if (!request.test?.results?.length)
      throw new Error('test data is missing');
    switch (request.kind) {
      case 'apply': return this._apply(request, job, log);
      case 'revert': return this._revert(request, job, log);
    }

    const attempt = request.attempt ?? lastFailedAttempt(request.test);
    log('Reading the trace…');
    const trace = await this._loadTrace(request).catch(e => {
      log(`Trace not available: ${e.message}`);
      return undefined;
    });
    if (trace)
      log(`Trace: ${trace.actions.length} actions, ${trace.requests.length} requests, ${trace.console.length} console errors${trace.dom ? `, DOM at failure (${trace.dom.elements.length} elements)` : ''}.`);
    const sources = this._collectSources(request.test, trace);
    if (sources.length)
      log(`Source files: ${sources.map(s => s.path).join(', ')}${this._options.repo ? '' : ' (from the trace)'}.`);

    let rerun: RunResult | undefined;
    let rerunTrace: TraceData | undefined;
    if (request.kind === 'debug') {
      const repo = this._options.repo;
      if (!repo)
        throw new Error('Run & debug needs the tests repository: open the report with `pw-extended-report agent` inside the repo.');
      log('Running the test locally (no retries, trace on)…');
      rerun = await runSingleTest(repo, { file: request.test.location.file, line: request.test.location.line, projectName: request.test.projectName }, log);
      log(`Local run: ${rerun.status}${rerun.durationMs !== undefined ? ` in ${Math.round(rerun.durationMs)}ms` : ''}.`);
      if (rerun.status === 'error' || rerun.status === 'not-found')
        log(rerun.output.split('\n').slice(-8).join('\n'));
      if (rerun.tracePath)
        rerunTrace = await readTrace(rerun.tracePath).catch(() => undefined);
      job.result = { rerun: { status: rerun.status, error: rerun.error, durationMs: rerun.durationMs } };
    }

    const evidence = buildEvidence({
      test: request.test,
      attempt,
      insight: request.insight,
      trace,
      errorContext: request.errorContext,
      comment: request.comment,
      sources: sources.map(s => ({ path: s.path, content: s.content, focusLine: s.focusLine })),
      rerun: rerun ? { status: rerun.status, error: rerun.error, durationMs: rerun.durationMs, trace: rerunTrace, output: rerun.output } : undefined,
    }, this._options.llm.maxContextChars);
    if (evidence.candidates.length)
      log(`Found ${evidence.candidates.length} element(s) similar to the failing locator.`);
    if (evidence.truncated)
      log('Evidence was trimmed to fit the model context (EXTENDED_REPORT_AI_MAX_CHARS).');

    if (request.kind === 'fix')
      return this._fix(request, job, log, evidence, sources);

    const userPrompt = request.kind === 'debug' ? debugPrompt(evidence.markdown) : analyzePrompt(evidence.markdown);
    log(`Asking the model (${describeLlm(this._options.llm)})…`);
    const answer = await chat(this._options.llm, [{ role: 'system', content: systemPrompt(this._options.llm.language) }, { role: 'user', content: userPrompt }], () => mockAnalysis(request, evidence, rerun));
    log('Done.');
    job.result = { ...job.result, markdown: answer.content, evidence: evidence.markdown, prompt: userPrompt, model: answer.model };
  }

  private async _fix(request: JobRequest, job: JobState, log: (text: string) => void, evidence: Evidence, sources: SourceFile[]) {
    const editable = sources.filter(s => s.full);
    if (!editable.length)
      throw new Error('No source code available: neither the repository nor the trace contains the test file.');
    const files = new Map(editable.map(s => [s.path, s.content]));
    const userPrompt = fixPrompt(evidence.markdown, editable.map(s => ({ path: s.path, content: s.content })), request.analysis, request.previousFixError);
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(this._options.llm.language) }, { role: 'user', content: userPrompt }];
    log(`Asking the model for a fix (${describeLlm(this._options.llm)})…`);
    let answer = await chat(this._options.llm, messages, () => mockFix(evidence, editable));
    let { edits, problems } = applyEditBlocks(parseEditBlocks(answer.content), files);
    if (!edits.length && problems.length) {
      log(`The proposed edit did not match the file (${problems.length} problem(s)); asking the model to correct it…`);
      messages.push({ role: 'assistant', content: answer.content }, { role: 'user', content: fixRetryMessage(problems) });
      answer = await chat(this._options.llm, messages, () => mockFix(evidence, editable));
      ({ edits, problems } = applyEditBlocks(parseEditBlocks(answer.content), files));
    }
    const explanation = answer.content.replace(/FILE:[\s\S]*?>{5,9} ?REPLACE/g, '').trim();
    const repo = this._options.repo;
    const stored: StoredFix = {
      proposal: {
        id: crypto.randomUUID(),
        explanation,
        files: edits.map(e => ({ file: e.file, diff: e.diff, inRepo: !!repo && editable.find(s => s.path === e.file)?.inRepo === true })),
        canApply: !!repo && edits.length > 0 && edits.every(e => editable.find(s => s.path === e.file)?.inRepo),
      },
      edits: edits.map(e => ({ file: e.file, oldContent: e.oldContent, newContent: e.newContent, inRepo: !!editable.find(s => s.path === e.file)?.inRepo })),
      test: request.test,
    };
    this._fixes.set(stored.proposal.id, stored);
    if (problems.length)
      log(`Some edits could not be applied:\n${problems.join('\n')}`);
    log(edits.length ? `Proposed changes in ${edits.length} file(s).` : 'The model did not produce an applicable change.');
    job.result = { markdown: explanation, evidence: evidence.markdown, prompt: userPrompt, model: answer.model, fix: stored.proposal };
  }

  private async _apply(request: JobRequest, job: JobState, log: (text: string) => void) {
    const repo = this._options.repo;
    const stored = request.fixId ? this._fixes.get(request.fixId) : undefined;
    if (!repo || !stored)
      throw new Error(!repo ? 'Applying fixes needs the tests repository (`pw-extended-report agent`).' : 'Fix proposal not found (the agent was restarted?). Propose the fix again.');
    if (!stored.proposal.canApply)
      throw new Error('This fix references files that are not in the repository.');
    for (const edit of stored.edits) {
      if (repo.read(edit.file) !== edit.oldContent)
        throw new Error(`${edit.file} changed since the fix was proposed. Propose the fix again.`);
    }
    const backupDir = path.join(repo.dir, '.pw-extended-report', 'backups', stored.proposal.id);
    fs.mkdirSync(backupDir, { recursive: true });
    for (const edit of stored.edits) {
      // .bak so that test runners never pick the backups up.
      fs.writeFileSync(path.join(backupDir, edit.file.replace(/[\\/]/g, '__') + '.bak'), edit.oldContent);
      repo.write(edit.file, edit.newContent);
      log(`Changed ${edit.file} (backup in .pw-extended-report/backups).`);
    }
    stored.proposal.applied = true;
    stored.proposal.reverted = false;
    log('Verifying: running the test…');
    const run = await runSingleTest(repo, { file: stored.test.location.file, line: stored.test.location.line, projectName: stored.test.projectName }, log);
    stored.proposal.verify = { status: run.status, error: run.error, durationMs: run.durationMs };
    log(run.status === 'passed' ? 'The test passes with the fix.' : `The test still fails (${run.status}). You can revert or ask for another fix.`);
    job.result = { fix: stored.proposal };
  }

  private async _revert(request: JobRequest, job: JobState, log: (text: string) => void) {
    const repo = this._options.repo;
    const stored = request.fixId ? this._fixes.get(request.fixId) : undefined;
    if (!repo || !stored?.proposal.applied)
      throw new Error('Nothing to revert.');
    for (const edit of stored.edits) {
      if (repo.read(edit.file) === edit.newContent) {
        repo.write(edit.file, edit.oldContent);
        log(`Reverted ${edit.file}.`);
      } else {
        log(`${edit.file} was changed after the fix; not reverted (backup in .pw-extended-report/backups/${stored.proposal.id}).`);
      }
    }
    stored.proposal.applied = false;
    stored.proposal.reverted = true;
    job.result = { fix: stored.proposal };
  }

  private async _loadTrace(request: JobRequest): Promise<TraceData | undefined> {
    if (request.tracePath && this._options.reportDir) {
      const file = path.resolve(this._options.reportDir, request.tracePath.replace(/^\.?\//, ''));
      if (!file.startsWith(path.resolve(this._options.reportDir) + path.sep))
        throw new Error('trace path outside of the report');
      if (fs.existsSync(file))
        return readTrace(file);
    }
    if (request.traceBase64)
      return readTrace(Buffer.from(request.traceBase64, 'base64'));
    return undefined;
  }

  /** Test file + page objects from the failing stack: from the repo when available, else from the trace. */
  private _collectSources(test: ReportTestCase, trace: TraceData | undefined): SourceFile[] {
    const repo = this._options.repo;
    const failingStep = trace ? [...trace.steps].reverse().find(s => s.error && s.stack.length) : undefined;
    const focus = new Map<string, number>();
    for (const frame of failingStep?.stack ?? [])
      if (!focus.has(frame.file))
        focus.set(frame.file, frame.line);
    const candidates = [...(failingStep?.stack.map(f => f.file) ?? []), ...(trace?.sourcePaths ?? [])];
    const unique = [...new Set(candidates)].filter(f => !/node_modules|playwright\.config/.test(f)).slice(0, 4);
    if (!unique.length)
      unique.push(test.location.file);

    const result: SourceFile[] = [];
    for (const file of unique) {
      const focusLine = focus.get(file) ?? (file.endsWith(test.location.file) ? test.location.line : undefined);
      const inRepo = repo?.find(file);
      if (repo && inRepo) {
        result.push({ path: inRepo, content: repo.read(inRepo), focusLine, inRepo: true, full: true });
        continue;
      }
      const fromTrace = sourceForPath(trace, file);
      if (fromTrace !== undefined)
        result.push({ path: displayPath(file, test.location.file), content: fromTrace, focusLine, inRepo: false, full: true });
    }
    return result;
  }
}

type SourceFile = { path: string, content: string, focusLine?: number, inRepo: boolean, full: boolean };

function displayPath(absolute: string, testRelative: string): string {
  const normalized = absolute.replace(/\\/g, '/');
  if (normalized.endsWith('/' + testRelative))
    return testRelative;
  return normalized.split('/').slice(-3).join('/');
}

function lastFailedAttempt(test: ReportTestCase): number {
  for (let i = test.results.length - 1; i >= 0; i--) {
    if (test.results[i].status !== 'passed' && test.results[i].status !== 'skipped')
      return i;
  }
  return test.results.length - 1;
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 120 * 1024 * 1024) {
        reject(new Error('request too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    request.on('error', reject);
  });
}

// ---------- mock answers (demo / tests): built from the evidence, clearly labelled ----------

function mockAnalysis(request: JobRequest, evidence: Evidence, rerun: RunResult | undefined): string {
  const c = request.insight?.classification;
  const verdict = c ? { 'product-bug': 'PRODUCT BUG', 'test-bug': 'TEST BUG', 'environment': 'ENVIRONMENT', 'ui-change': 'UI CHANGE', 'flaky': 'FLAKY', 'unknown': 'UNKNOWN' }[c.kind] : 'UNKNOWN';
  const lines = [
    '> **Mock answer** — no model configured (`--ai-mock`). The structure and the evidence are real; the reasoning is a template.',
    '',
    '## Verdict',
    `**${verdict}** — ${c?.reason ?? 'see evidence'}. Confidence: ${c?.confidence ?? 'low'}.`,
  ];
  if (request.comment)
    lines.push('', `Engineer's hint taken into account: _${request.comment}_`);
  if (rerun) {
    lines.push('', '## Re-run result', `The test was re-run locally: **${rerun.status}**.${rerun.status === 'passed' ? ' The failure did not reproduce: suspect environment, data or timing.' : ' The failure reproduces.'}`);
  }
  lines.push('', '## What happened', evidence.failingLocator ? `The test waited for \`${evidence.failingLocator}\` and it never matched.` : 'See the error below.');
  if (evidence.candidates.length) {
    lines.push('', '## Evidence', 'Elements present on the page at the moment of failure that look like the target:', ...evidence.candidates.map(cand => `- \`${cand.element}\` (${cand.reason})`));
    lines.push('', '## How to fix', `Update the locator, e.g. \`${evidence.candidates[0].code}\`.`);
  } else {
    lines.push('', '## How to fix', 'Open the trace at the failing step and compare the expected state with the DOM.');
  }
  lines.push('', '## How to verify', '`npx playwright test <file>:<line> --retries=0 --trace=on`');
  return lines.join('\n');
}

function mockFix(evidence: Evidence, files: SourceFile[]): string {
  const candidate = evidence.candidates[0];
  const locator = evidence.failingLocator;
  if (candidate && locator) {
    for (const file of files) {
      // Prefer the line where the test actually failed, then any line using the locator.
      const lines = file.content.split('\n');
      const matches = (l: string) => l.includes(locator) || l.includes(locator.replace(/'/g, '"'));
      const focused = file.focusLine !== undefined && lines[file.focusLine - 1] && matches(lines[file.focusLine - 1]) ? lines[file.focusLine - 1] : undefined;
      const line = focused ?? lines.find(matches);
      if (line) {
        const replacement = line.replace(new RegExp(`(page\\.)?${escapeRegExp(locator)}`), candidate.code);
        return [
          '## Explanation',
          `**Mock fix** (no model configured): \`${locator}\` is not on the page; the closest element is \`${candidate.element}\`, so the locator is replaced with \`${candidate.code}\`.`,
          '',
          `FILE: ${file.path}`,
          '<<<<<<< SEARCH',
          line,
          '=======',
          replacement,
          '>>>>>>> REPLACE',
        ].join('\n');
      }
    }
  }
  return '## Explanation\n**Mock fix**: no safe automatic change found for this failure (no similar element on the page).';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

