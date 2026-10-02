/**
 * Groups failed tests by a normalized error signature, so that one broken
 * locator / backend outage shows up as one row instead of 40 failed tests.
 *
 * Output:
 *  - a Markdown tab for the report,
 *  - a structured `clusters` list, also written into report-summary.json
 *    so that an LLM / log-analysis skill can consume it without parsing HTML.
 */

import path from 'path';

import { stripAnsiEscapes, toPosixPath } from './compat';

import type { FullConfig, Suite, TestCase, TestError } from '@playwright/test/reporter';

export type FailureCategory =
  | 'Timeout'
  | 'Assertion'
  | 'Locator'
  | 'Network'
  | 'Browser crash'
  | 'Snapshot'
  | 'Other';

export type FailedTestInfo = {
  testId: string;
  title: string;
  titlePath: string[];
  projectName: string;
  file: string;
  line: number;
  outcome: 'unexpected' | 'flaky';
  status: string;
  retries: number;
  error: string;
  errorLocation?: string;
  attachments: { name: string, contentType: string, path?: string }[];
};

export type FailureCluster = {
  id: number;
  signature: string;
  category: FailureCategory;
  /** Full text of the first error in the cluster, ANSI stripped. */
  sampleError: string;
  tests: FailedTestInfo[];
  projects: string[];
  /** The most common `file:line` where the error was thrown. */
  topLocation?: string;
};

export function collectFailedTests(config: FullConfig, suite: Suite, rootDir: string): FailedTestInfo[] {
  const result: FailedTestInfo[] = [];
  for (const test of suite.allTests()) {
    const outcome = test.outcome();
    if (outcome !== 'unexpected' && outcome !== 'flaky')
      continue;
    // The last failed attempt carries the most relevant error.
    const failedResults = test.results.filter(r => r.status !== 'passed' && r.status !== 'skipped');
    const failed = failedResults[failedResults.length - 1] ?? test.results[test.results.length - 1];
    const error: TestError | undefined = failed?.errors[0] ?? failed?.error;
    const [, projectName = '', , ...titles] = test.titlePath();
    result.push({
      testId: test.id,
      title: test.title,
      titlePath: titles,
      projectName,
      file: toPosixPath(path.relative(rootDir, test.location.file)),
      line: test.location.line,
      outcome,
      status: failed?.status ?? 'failed',
      retries: Math.max(0, test.results.length - 1),
      error: errorText(error, failed?.status),
      errorLocation: error?.location ? `${toPosixPath(path.relative(rootDir, error.location.file))}:${error.location.line}` : undefined,
      attachments: (failed?.attachments ?? []).map(a => ({ name: a.name, contentType: a.contentType, path: a.path })),
    });
  }
  return result;
}

function errorText(error: TestError | undefined, status: string | undefined): string {
  const text = error?.message ?? error?.value;
  if (text)
    return stripAnsiEscapes(text);
  if (status === 'interrupted')
    return 'Test was interrupted.';
  if (status === 'passed')
    return 'Expected to fail, but passed.';
  return 'Unknown error';
}

/** Lines that identify *what* failed; values that vary between runs are dropped. */
const kSignatureLinePrefixes = ['Locator:', 'Expected:', 'Expected pattern:', 'Expected string:', 'Call log:'];

export function errorSignature(error: string): string {
  const lines = error.split('\n').map(l => l.trim()).filter(Boolean);
  const head = lines[0] ?? '';
  const details = lines.slice(1)
      .filter(l => kSignatureLinePrefixes.some(p => l.startsWith(p)) && !l.startsWith('Call log:'))
      .slice(0, 2);
  return [head, ...details].map(normalizeLine).join(' | ');
}

function normalizeLine(line: string): string {
  return line
      .replace(/https?:\/\/[^\s'"`)]+/g, m => m.replace(/[?#].*$/, ''))
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
      .replace(/\b[0-9a-f]{16,}\b/gi, '<hash>')
      .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<date>')
      .replace(/\d+(\.\d+)?\s*ms\b/g, '<n>ms')
      .replace(/\b\d+\b/g, '<n>')
      .replace(/\s+/g, ' ')
      .slice(0, 300);
}

export function categorize(error: string): FailureCategory {
  const e = error.toLowerCase();
  if (/tohavescreenshot|snapshot|screenshot comparison|pixels? \(ratio/.test(e))
    return 'Snapshot';
  if (/target (page, context or browser )?(has been )?closed|browser has been closed|page crashed|crash/.test(e))
    return 'Browser crash';
  if (/net::err_|econnrefused|econnreset|enotfound|socket hang up|getaddrinfo|status code 5\d\d|\b5\d\d\b.*(error|status)|ns_error_/.test(e))
    return 'Network';
  if (/strict mode violation|element\(s\) not found|resolved to \d+ elements|waiting for locator|locator\./.test(e) && !/^error: expect/.test(e.split('\n')[0]))
    return 'Locator';
  if (/^error: expect|expect\(|tobe|toequal|tohave|tocontain|tomatch/.test(e))
    return 'Assertion';
  if (/timeout|timed out|exceeded/.test(e))
    return 'Timeout';
  return 'Other';
}

export function clusterFailures(failed: FailedTestInfo[]): FailureCluster[] {
  const bySignature = new Map<string, FailedTestInfo[]>();
  for (const test of failed) {
    const signature = errorSignature(test.error);
    let list = bySignature.get(signature);
    if (!list) {
      list = [];
      bySignature.set(signature, list);
    }
    list.push(test);
  }
  const clusters = [...bySignature.entries()].map(([signature, tests]) => {
    const locations = new Map<string, number>();
    for (const t of tests) {
      if (t.errorLocation)
        locations.set(t.errorLocation, (locations.get(t.errorLocation) ?? 0) + 1);
    }
    const topLocation = [...locations.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      id: 0,
      signature,
      category: categorize(tests[0].error),
      sampleError: tests[0].error,
      tests,
      projects: [...new Set(tests.map(t => t.projectName).filter(Boolean))],
      topLocation,
    };
  });
  clusters.sort((a, b) => b.tests.length - a.tests.length || a.signature.localeCompare(b.signature));
  clusters.forEach((c, i) => c.id = i + 1);
  return clusters;
}

export type RunStats = { total: number, expected: number, unexpected: number, flaky: number, skipped: number };

export function renderClustersMarkdown(clusters: FailureCluster[], stats: RunStats): string {
  const executed = stats.total - stats.skipped;
  const percent = (n: number) => executed ? `${(n * 100 / executed).toFixed(1)}%` : '0%';
  const lines: string[] = [];
  lines.push(`| Total | Passed | Failed | Flaky | Skipped | Failure rate |`);
  lines.push(`|---|---|---|---|---|---|`);
  lines.push(`| ${stats.total} | ${stats.expected} | ${stats.unexpected} | ${stats.flaky} | ${stats.skipped} | **${percent(stats.unexpected)}** |`);
  lines.push('');

  if (!clusters.length) {
    lines.push('No failed or flaky tests in this run.');
    return lines.join('\n');
  }

  const failedCount = clusters.reduce((a, c) => a + c.tests.length, 0);
  lines.push(`**${failedCount}** failed / flaky tests grouped into **${clusters.length}** distinct error(s). Groups are sorted by size: fixing the top one fixes the most tests.`);
  lines.push('');
  lines.push(`| # | Category | Error | Tests | Projects |`);
  lines.push(`|---|---|---|---|---|`);
  for (const c of clusters)
    lines.push(`| [${c.id}](#group-${c.id}) | ${c.category} | ${inlineCode(errorTitle(c.sampleError), 120)} | ${c.tests.length} | ${c.projects.join(', ') || '—'} |`);
  lines.push('');

  for (const c of clusters) {
    lines.push(`<h3 id="group-${c.id}">${c.id}. ${escapeHtml(errorTitle(c.sampleError).slice(0, 160))}</h3>`);
    lines.push('');
    const meta = [`**${c.category}**`, `${c.tests.length} test(s)`];
    if (c.topLocation)
      meta.push(`thrown at ${inlineCode(c.topLocation, 200)}`);
    lines.push(meta.join(' · '));
    lines.push('');
    lines.push('<details><summary>Error</summary>');
    lines.push('');
    lines.push('```text');
    lines.push(truncateLines(c.sampleError, 40).replace(/```/g, '\'\'\''));
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('');
    for (const t of c.tests) {
      const title = [...t.titlePath].join(' › ') || t.title;
      const tags = [t.projectName, `${t.file}:${t.line}`, t.outcome === 'flaky' ? 'flaky' : t.status, t.retries ? `retries: ${t.retries}` : ''].filter(Boolean);
      lines.push(`- [${escapeMarkdownLinkText(title)}](#?testId=${encodeURIComponent(t.testId)}) — ${tags.join(' · ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function errorTitle(text: string): string {
  const first = text.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  return first.replace(/^Error:\s*/, '');
}

function truncateLines(text: string, max: number): string {
  const lines = text.split('\n');
  return lines.length > max ? [...lines.slice(0, max), `... (${lines.length - max} more lines)`].join('\n') : text;
}

function inlineCode(text: string, max: number): string {
  const t = text.length > max ? text.slice(0, max) + '…' : text;
  return '`' + t.replace(/`/g, '\'').replace(/\|/g, '\\|') + '`';
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/([\[\]\\|])/g, '\\$1');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
