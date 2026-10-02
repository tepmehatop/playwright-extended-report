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
import { readTrace } from '../agent/trace';
import { maskHeaders, toCurl } from '../shared/curl';

import type { Lang } from '../agent/prompts';

import type { HistoryFile, HistoryRun } from './history';
import type { Classification, ConsoleIssue, HistoryOutcome, InsightCluster, InsightsData, InsightTest, NetworkIssue, TestHistory } from '../shared/insightsFormat';
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
  lang: Lang;
  clusters?: InsightCluster[];
  rootDirInRepo?: string;
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
    let page: PageState | undefined;
    const trace = failed?.attachments.find(a => a.name === 'trace' && a.path);
    if (options.traces && trace?.path) {
      try {
        const data = await readTrace(trace.path);
        const unmask = /^(1|true)$/i.test(process.env.EXTENDED_REPORT_UNMASK_SECRETS || '');
        network = data.failedRequests.slice(0, 20).map(r => {
          const headers = maskHeaders(r.requestHeaders ?? [], unmask);
          return {
            method: r.method,
            url: r.url,
            status: r.status,
            statusText: r.statusText,
            failure: r.failure,
            durationMs: r.durationMs,
            startedAt: r.startedAt,
            requestBody: r.requestBody?.slice(0, 4000),
            responseBody: r.responseBody?.slice(0, 4000),
            curl: toCurl({ method: r.method, url: r.url, headers, body: r.requestBody }),
          };
        });
        consoleIssues = data.console.slice(0, 20);
        if (data.dom)
          page = { url: data.dom.url, isBlank: data.dom.isBlank };
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
    item.classification = classify(item, failed?.status, page, options.lang);
    item.clusterId = options.clusters?.find(c => c.testIds.includes(test.id))?.id;
    tests.push(item);
  }

  unstable.sort((a, b) => b.instability - a.instability);
  regressions.sort((a, b) => (b.durationMs / b.baselineMs) - (a.durationMs / a.baselineMs));

  const data: InsightsData = {
    version: 1,
    runId: options.runId,
    generatedAt: new Date().toISOString(),
    language: options.lang,
    clusters: options.clusters,
    paths: options.rootDirInRepo !== undefined ? { rootDirInRepo: options.rootDirInRepo } : undefined,
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

export type PageState = { url: string, isBlank: boolean };

const kText = {
  ru: {
    flakyRetry: (n: number) => `Упал и затем прошёл на ретрае в рамках одного прогона (${n} попыток).`,
    firstError: 'первая ошибка',
    error: 'ошибка',
    intermittent: (f: number, t: number) => `Падает нестабильно между прогонами: упал в ${f} из ${t} прогонов без устойчивой закономерности.`,
    backend: (status: number, what: string) => `Бэкенд вернул ${status} на ${what}; интерфейс не получил данные.`,
    networkProblem: (what: string) => `Проблема сети / связности (${what}).`,
    crash: 'Браузер или страница упали / были закрыты во время теста.',
    pageError: (text: string) => `Приложение выбросило необработанное исключение: ${text}`,
    pageErrorEvidence: 'ошибка страницы',
    thenCheck: (locator: string) => `после этого проверка упала на ${locator}`,
    snapshot: 'Визуальный / ARIA-снапшот отличается от эталона: либо это намеренное изменение UI (обновите эталоны), либо регрессия.',
    blank: (url: string) => `Страница была пустой в момент падения (URL: ${url}), поэтому ни один локатор не мог найти элемент. Смотрите, что произошло до этого: неожиданная навигация, редирект, отправка формы или страница не отрисовалась — а не локатор.`,
    blankEvidence: (url: string) => `страница в момент падения: пустая, ${url}`,
    notFound: (locator: string | undefined, isNew: boolean) => `Элемент не найден${locator ? `: ${locator}` : ''}. Локатор устарел или страница изменилась${isNew ? ' — падение появилось в этом прогоне, проверьте недавние изменения UI' : ''}.`,
    locator: 'локатор',
    wrongValue: (e: string, r: string) => `Приложение выдало другое значение: ожидалось ${e}, получено ${r}.`,
    timeout: 'Таймаут теста: окружение было медленным или приложение зависло. Найдите в таймлайне трейса шаг, на котором всё остановилось.',
    unknown: 'Ни одно правило не подошло; используйте Ask AI или трейс для разбора.',
    noMessage: 'нет текста ошибки',
    newFailure: (n: number) => `новое падение: проходил во всех ${n} предыдущих прогонах`,
    knownFailure: (n: number) => `известное падение: падает ${n} прогонов подряд`,
    flakyHistory: (f: number, t: number) => `история: нестабилен в ${f} из ${t} прогонов`,
    failedHistory: (f: number, t: number, k: number) => `история: падал в ${f} из ${t} прогонов${k ? `, нестабилен в ${k}` : ''}`,
  },
  en: {
    flakyRetry: (n: number) => `Failed and then passed on retry within the same run (${n} attempts).`,
    firstError: 'first error',
    error: 'error',
    intermittent: (f: number, t: number) => `Fails intermittently across runs: ${f} of ${t} runs failed without a stable pattern.`,
    backend: (status: number, what: string) => `Backend returned ${status} for ${what}; the UI could not get its data.`,
    networkProblem: (what: string) => `Network / connectivity problem (${what}).`,
    crash: 'The browser or page crashed / was closed during the test.',
    pageError: (text: string) => `The application threw an uncaught exception: ${text}`,
    pageErrorEvidence: 'page error',
    thenCheck: (locator: string) => `then the check failed on ${locator}`,
    snapshot: 'Visual / ARIA snapshot differs from the baseline: either an intended UI change (update baselines) or a regression.',
    blank: (url: string) => `The page was empty when the test failed (URL: ${url}), so no locator could match. Look at what happened before: an unexpected navigation, redirect, form submit or a page that did not render — not at the locator.`,
    blankEvidence: (url: string) => `page at failure: blank, ${url}`,
    notFound: (locator: string | undefined, isNew: boolean) => `Element not found${locator ? `: ${locator}` : ''}. The locator is outdated or the page changed${isNew ? ' — this started failing in this run, check recent UI changes' : ''}.`,
    locator: 'locator',
    wrongValue: (e: string, r: string) => `The app produced a different value: expected ${e}, received ${r}.`,
    timeout: 'Test timeout: the environment was slow or the app hung. Check the trace timeline for the stalled step.',
    unknown: 'No rule matched; use "Ask AI" or the trace to investigate.',
    noMessage: 'no error message',
    newFailure: (n: number) => `new failure: passed in all ${n} previous run(s)`,
    knownFailure: (n: number) => `known failure: failing ${n} runs in a row`,
    flakyHistory: (f: number, t: number) => `history: flaky in ${f} of ${t} runs`,
    failedHistory: (f: number, t: number, k: number) => `history: failed ${f} of ${t} runs${k ? `, flaky in ${k}` : ''}`,
  },
};

export function classify(test: Pick<InsightTest, 'outcome' | 'error' | 'network' | 'console' | 'history' | 'attempts'>, status?: string, page?: PageState, lang: Lang = 'ru'): Classification {
  const L = kText[lang];
  const error = test.error ?? '';
  const firstLine = error.split('\n').find(l => l.trim())?.trim() ?? '';
  const locator = error.match(/^Locator: (.+)$/m)?.[1];
  const expected = error.match(/^Expected(?: string| pattern)?: (.+)$/m)?.[1];
  const received = error.match(/^Received(?: string)?: (.+)$/m)?.[1];
  const serverErrors = test.network.filter(n => n.status >= 500);
  const failedRequests = test.network.filter(n => n.status === 0 && n.failure);
  const pageErrors = test.console.filter(c => c.kind === 'page-error');
  const h: TestHistory | undefined = test.history;
  const historyNote = h && h.totalRuns > 1 ? describeHistory(h, lang) : undefined;
  const withHistory = (evidence: string[]) => historyNote ? [...evidence, historyNote] : evidence;

  if (test.outcome === 'flaky')
    return { kind: 'flaky', reason: L.flakyRetry(test.attempts), evidence: withHistory([`${L.firstError}: ${firstLine}`]), confidence: 'high' };
  if (h && h.totalRuns >= 3 && isIntermittent(h))
    return { kind: 'flaky', reason: L.intermittent(h.failedRuns, h.totalRuns), evidence: withHistory([`${L.error}: ${firstLine}`]), confidence: 'medium' };
  if (serverErrors.length) {
    const first = serverErrors[0];
    return { kind: 'environment', reason: L.backend(first.status, `${first.method} ${shortUrl(first.url)}`), evidence: withHistory(serverErrors.slice(0, 3).map(n => `${n.method} ${shortUrl(n.url)} → ${n.status}`)), confidence: 'high' };
  }
  if (failedRequests.length || kNetworkErrorText.test(error)) {
    const what = failedRequests[0] ? `${failedRequests[0].method} ${shortUrl(failedRequests[0].url)}: ${failedRequests[0].failure}` : error.match(kNetworkErrorText)?.[0];
    return { kind: 'environment', reason: L.networkProblem(what ?? ''), evidence: withHistory([what ?? firstLine]), confidence: 'high' };
  }
  if (kCrashText.test(error))
    return { kind: 'environment', reason: L.crash, evidence: withHistory([firstLine]), confidence: 'medium' };
  if (pageErrors.length) {
    const text = pageErrors[0].text.split('\n')[0];
    return { kind: 'product-bug', reason: L.pageError(text), evidence: withHistory([`${L.pageErrorEvidence}: ${text}`, ...(locator ? [L.thenCheck(locator)] : [])]), confidence: 'high' };
  }
  if (kSnapshotText.test(error))
    return { kind: 'ui-change', reason: L.snapshot, evidence: withHistory([firstLine]), confidence: 'high' };
  if (kNotFoundText.test(error) && page?.isBlank)
    return { kind: 'unknown', reason: L.blank(page.url), evidence: withHistory([firstLine, L.blankEvidence(page.url)]), confidence: 'medium' };
  if (kNotFoundText.test(error))
    return { kind: 'test-bug', reason: L.notFound(locator, !!h?.isNewFailure), evidence: withHistory([firstLine, ...(locator ? [`${L.locator}: ${locator}`] : [])]), confidence: 'medium' };
  if (expected !== undefined && received !== undefined)
    return { kind: 'product-bug', reason: L.wrongValue(expected, received), evidence: withHistory([firstLine, ...(locator ? [`${L.locator}: ${locator}`] : [])]), confidence: locator ? 'medium' : 'low' };
  if (/Test timeout of \d+ms exceeded/.test(error) || status === 'timedOut')
    return { kind: 'environment', reason: L.timeout, evidence: withHistory([firstLine]), confidence: 'low' };
  return { kind: 'unknown', reason: L.unknown, evidence: withHistory([firstLine || L.noMessage]), confidence: 'low' };
}

function describeHistory(h: TestHistory, lang: Lang): string {
  const L = kText[lang];
  if (h.isNewFailure)
    return L.newFailure(h.totalRuns - 1);
  if (h.failingStreak > 1)
    return L.knownFailure(h.failingStreak);
  const flakyRuns = h.runs.filter(r => r.outcome === 'k').length;
  if (!h.failedRuns && flakyRuns)
    return L.flakyHistory(flakyRuns, h.totalRuns);
  return L.failedHistory(h.failedRuns, h.totalRuns, flakyRuns);
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search.length > 40 ? u.search.slice(0, 40) + '…' : u.search);
  } catch {
    return url;
  }
}
