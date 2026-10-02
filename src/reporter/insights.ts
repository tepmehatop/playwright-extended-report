/**
 * Builds the data of the "Insights" tab:
 *  1. classification of every failure (product bug / test bug / environment / UI change / flaky),
 *  2. run history (new vs known failures, unstable tests, duration regressions, fixed tests),
 *  4. failed network requests and browser errors taken from the trace.
 * (3 — retry comparison — and 6 — Ask AI / Fix — are UI features working on this data.)
 *
 * Classification is rule based and explains itself through `evidence`; an LLM
 * can refine it via "Ask AI".
 */

import path from 'path';

import { stripAnsiEscapes, toPosixPath } from './compat';
import { appendRun, durationRegression, isIntermittent, loadHistory, saveHistory, testHistory } from './history';
import { readTraceIssues } from './traceInsights';

import type { HistoryFile, HistoryRun } from './history';
import type { Classification, ConsoleIssue, HistoryOutcome, InsightsData, InsightTest, NetworkIssue, TestHistory } from '../shared/insightsFormat';
import type { FullResult, Suite, TestCase } from '@playwright/test/reporter';

export type InsightsOptions = {
  /** History file that must persist between runs. `false` disables history. */
  historyFile: string | false;
  maxRuns: number;
  runId: string;
  runUrl?: string;
  /** Read trace.zip of failed tests for network / console errors. */
  traces: boolean;
  aiEndpoint?: string;
  fixUrlTemplate?: string;
};

export async function buildInsights(suite: Suite, rootDir: string, result: FullResult, options: InsightsOptions): Promise<{ data: InsightsData, history?: HistoryFile }> {
  const allTests = suite.allTests();

  let history: HistoryFile | undefined;
  if (options.historyFile) {
    const run: HistoryRun = {
      runId: options.runId,
      startTime: result.startTime.toISOString(),
      url: options.runUrl,
      stats: { total: 0, failed: 0, flaky: 0 },
      tests: {},
    };
    for (const test of allTests) {
      const outcome = historyOutcome(test);
      run.tests[test.id] = [outcome, Math.round(test.results[test.results.length - 1]?.duration ?? 0)];
      ++run.stats.total;
      if (outcome === 'f')
        ++run.stats.failed;
      if (outcome === 'k')
        ++run.stats.flaky;
    }
    history = appendRun(loadHistory(options.historyFile), run, options.maxRuns);
    saveHistory(options.historyFile, history);
  }

  const tests: InsightTest[] = [];
  const unstable: NonNullable<InsightsData['history']>['unstable'] = [];
  const regressions: NonNullable<InsightsData['history']>['regressions'] = [];
  const fixedTestIds: string[] = [];
  const previousRun = history && history.runs.length > 1 ? history.runs[history.runs.length - 2] : undefined;

  for (const test of allTests) {
    const outcome = test.outcome();
    const h = history ? testHistory(history, test.id) : undefined;
    const [, projectName = '', , ...titles] = test.titlePath();

    if (h) {
      // Unstable = mixes passes with failures, or flaky; a test that always fails is broken, not unstable.
      const outcomes = h.runs.map(r => r.outcome);
      const mixed = outcomes.includes('k') || (outcomes.includes('p') && outcomes.includes('f'));
      if (h.totalRuns >= 3 && mixed)
        unstable.push({ testId: test.id, title: titles.join(' › '), projectName, instability: h.instability, runs: h.runs.map(r => r.outcome) });
      const regression = durationRegression(h);
      if (regression)
        regressions.push({ testId: test.id, title: titles.join(' › '), projectName, ...regression });
      if (outcome === 'expected' && previousRun?.tests[test.id]?.[0] === 'f')
        fixedTestIds.push(test.id);
    }

    if (outcome !== 'unexpected' && outcome !== 'flaky')
      continue;

    const failed = [...test.results].reverse().find(r => r.status !== 'passed' && r.status !== 'skipped') ?? test.results[test.results.length - 1];
    const errorObject = failed?.errors?.[0] ?? failed?.error;
    const error = errorObject?.message ? stripAnsiEscapes(errorObject.message) : failed?.status === 'interrupted' ? 'Test was interrupted.' : undefined;

    let network: NetworkIssue[] = [];
    let consoleIssues: ConsoleIssue[] = [];
    const trace = failed?.attachments.find(a => a.name === 'trace' && a.path);
    if (options.traces && trace?.path) {
      try {
        ({ network, console: consoleIssues } = await readTraceIssues(trace.path));
      } catch {
      }
    }

    const item: InsightTest = {
      testId: test.id,
      title: test.title,
      titlePath: titles,
      projectName,
      file: toPosixPath(path.relative(rootDir, test.location.file)),
      line: test.location.line,
      outcome,
      error,
      errorLocation: errorObject?.location ? `${toPosixPath(path.relative(rootDir, errorObject.location.file))}:${errorObject.location.line}` : undefined,
      network,
      console: consoleIssues,
      history: h,
      attempts: test.results.length,
    };
    item.classification = classify(item, failed?.status);
    tests.push(item);
  }

  unstable.sort((a, b) => b.instability - a.instability);
  regressions.sort((a, b) => (b.durationMs / b.baselineMs) - (a.durationMs / a.baselineMs));

  const data: InsightsData = {
    version: 1,
    runId: options.runId,
    generatedAt: new Date().toISOString(),
    tests,
    history: history ? {
      runs: history.runs.map(r => ({ runId: r.runId, startTime: r.startTime, total: r.stats.total, failed: r.stats.failed, flaky: r.stats.flaky, url: r.url })),
      fixedTestIds,
      unstable: unstable.slice(0, 30),
      regressions: regressions.slice(0, 30),
    } : undefined,
    ai: options.aiEndpoint ? { endpoint: options.aiEndpoint } : undefined,
    fix: options.fixUrlTemplate ? { urlTemplate: options.fixUrlTemplate } : undefined,
  };
  return { data, history };
}

function historyOutcome(test: TestCase): HistoryOutcome {
  switch (test.outcome()) {
    case 'expected': return 'p';
    case 'flaky': return 'k';
    case 'skipped': return 's';
    default: return 'f';
  }
}

const kNetworkErrorText = /net::ERR_[A-Z_]+|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|getaddrinfo|NS_ERROR_[A-Z_]+/;
const kCrashText = /Target (page, context or browser )?(has been )?closed|Browser has been closed|Page crashed|browser has disconnected/i;
const kNotFoundText = /element\(s\) not found|resolved to 0 elements|waiting for (locator|getBy|selector)|strict mode violation|element is not attached|element is outside of the viewport/i;
const kSnapshotText = /toHaveScreenshot|Screenshot comparison failed|pixels \(ratio|snapshot doesn't exist|toMatchSnapshot|toMatchAriaSnapshot/;

export function classify(test: Pick<InsightTest, 'outcome' | 'error' | 'network' | 'console' | 'history' | 'attempts'>, status?: string): Classification {
  const error = test.error ?? '';
  const firstLine = error.split('\n').find(l => l.trim())?.trim() ?? '';
  const locator = error.match(/^Locator: (.+)$/m)?.[1];
  const expected = error.match(/^Expected(?: string| pattern)?: (.+)$/m)?.[1];
  const received = error.match(/^Received(?: string)?: (.+)$/m)?.[1];
  const serverErrors = test.network.filter(n => n.status >= 500);
  const failedRequests = test.network.filter(n => n.status === 0 && n.failure);
  const pageErrors = test.console.filter(c => c.kind === 'page-error');
  const h: TestHistory | undefined = test.history;
  const historyNote = h && h.totalRuns > 1 ? describeHistory(h) : undefined;
  const withHistory = (evidence: string[]) => historyNote ? [...evidence, historyNote] : evidence;

  if (test.outcome === 'flaky') {
    return {
      kind: 'flaky',
      reason: `Failed and then passed on retry within the same run (${test.attempts} attempts).`,
      evidence: withHistory([`first error: ${firstLine}`]),
      confidence: 'high',
    };
  }
  if (h && h.totalRuns >= 3 && isIntermittent(h)) {
    return {
      kind: 'flaky',
      reason: `Fails intermittently across runs: ${h.failedRuns} of ${h.totalRuns} runs failed without a stable pattern.`,
      evidence: withHistory([`error: ${firstLine}`]),
      confidence: 'medium',
    };
  }
  if (serverErrors.length) {
    const first = serverErrors[0];
    return {
      kind: 'environment',
      reason: `Backend returned ${first.status} for ${first.method} ${shortUrl(first.url)}; the UI could not get its data.`,
      evidence: withHistory(serverErrors.slice(0, 3).map(n => `${n.method} ${shortUrl(n.url)} → ${n.status}`)),
      confidence: 'high',
    };
  }
  if (failedRequests.length || kNetworkErrorText.test(error)) {
    const what = failedRequests[0] ? `${failedRequests[0].method} ${shortUrl(failedRequests[0].url)}: ${failedRequests[0].failure}` : error.match(kNetworkErrorText)?.[0];
    return {
      kind: 'environment',
      reason: `Network / connectivity problem (${what}).`,
      evidence: withHistory([what ?? firstLine]),
      confidence: 'high',
    };
  }
  if (kCrashText.test(error)) {
    return { kind: 'environment', reason: 'The browser or page crashed / was closed during the test.', evidence: withHistory([firstLine]), confidence: 'medium' };
  }
  if (pageErrors.length) {
    const text = pageErrors[0].text.split('\n')[0];
    return {
      kind: 'product-bug',
      reason: `The application threw an uncaught exception: ${text}`,
      evidence: withHistory([`page error: ${text}`, ...(locator ? [`then the check failed on ${locator}`] : [])]),
      confidence: 'high',
    };
  }
  if (kSnapshotText.test(error)) {
    return { kind: 'ui-change', reason: 'Visual / ARIA snapshot differs from the baseline: either an intended UI change (update baselines) or a regression.', evidence: withHistory([firstLine]), confidence: 'high' };
  }
  if (kNotFoundText.test(error)) {
    const isNew = h?.isNewFailure;
    return {
      kind: 'test-bug',
      reason: `Element not found${locator ? `: ${locator}` : ''}. The locator is outdated or the page changed${isNew ? ' — this started failing in this run, check recent UI changes' : ''}.`,
      evidence: withHistory([firstLine, ...(locator ? [`locator: ${locator}`] : [])]),
      confidence: 'medium',
    };
  }
  if (expected !== undefined && received !== undefined) {
    return {
      kind: 'product-bug',
      reason: `The app produced a different value: expected ${expected}, received ${received}.`,
      evidence: withHistory([firstLine, ...(locator ? [`locator: ${locator}`] : [])]),
      confidence: locator ? 'medium' : 'low',
    };
  }
  if (/Test timeout of \d+ms exceeded/.test(error) || status === 'timedOut') {
    return { kind: 'environment', reason: 'Test timeout: the environment was slow or the app hung. Check the trace timeline for the stalled step.', evidence: withHistory([firstLine]), confidence: 'low' };
  }
  return { kind: 'unknown', reason: 'No rule matched; use "Ask AI" or the trace to investigate.', evidence: withHistory([firstLine || 'no error message']), confidence: 'low' };
}

function describeHistory(h: TestHistory): string {
  if (h.isNewFailure)
    return `new failure: passed in all ${h.totalRuns - 1} previous run(s)`;
  if (h.failingStreak > 1)
    return `known failure: failing ${h.failingStreak} runs in a row`;
  const flakyRuns = h.runs.filter(r => r.outcome === 'k').length;
  if (!h.failedRuns && flakyRuns)
    return `history: flaky in ${flakyRuns} of ${h.totalRuns} runs`;
  return `history: failed ${h.failedRuns} of ${h.totalRuns} runs${flakyRuns ? `, flaky in ${flakyRuns}` : ''}`;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search.length > 40 ? u.search.slice(0, 40) + '…' : u.search);
  } catch {
    return url;
  }
}
