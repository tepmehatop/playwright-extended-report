/**
 * Data of the built-in "Insights" tab (format: 'insights', content: JSON of InsightsData).
 * Computed by the reporter, rendered by web/src/extended/insights/.
 */

export type FailureKind =
  | 'product-bug'   // the app misbehaves: uncaught JS error, wrong value on the page
  | 'test-bug'      // the test is outdated: locator not found, strict mode, wrong expectation
  | 'environment'   // backend / network / infrastructure: 5xx, connection errors, browser crash
  | 'ui-change'     // visual snapshot mismatch
  | 'flaky'         // passes and fails without code changes (retries or history)
  | 'unknown';

export type Classification = {
  kind: FailureKind;
  /** One sentence explaining why, built from the evidence. */
  reason: string;
  /** Short facts the decision was based on. */
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
};

export type NetworkIssue = {
  method: string;
  url: string;
  /** HTTP status, 0 when the request failed without a response. */
  status: number;
  statusText?: string;
  failure?: string;
  durationMs?: number;
};

export type ConsoleIssue = {
  kind: 'console-error' | 'console-warning' | 'page-error';
  text: string;
  location?: string;
};

/** Outcome of one test in one run: p=passed, f=failed, k=flaky, s=skipped. */
export type HistoryOutcome = 'p' | 'f' | 'k' | 's';

export type TestHistory = {
  /** Oldest first, the current run is the last element. */
  runs: { runId: string, outcome: HistoryOutcome, durationMs: number }[];
  failedRuns: number;
  totalRuns: number;
  /** Failed now, passed in every previous run that has data. */
  isNewFailure: boolean;
  /** Number of consecutive failed runs ending with the current one. */
  failingStreak: number;
  /** Share of runs that were failed or flaky. */
  instability: number;
};

export type InsightTest = {
  testId: string;
  title: string;
  titlePath: string[];
  projectName: string;
  file: string;
  line: number;
  outcome: 'unexpected' | 'flaky' | 'expected' | 'skipped';
  error?: string;
  errorLocation?: string;
  classification?: Classification;
  network: NetworkIssue[];
  console: ConsoleIssue[];
  history?: TestHistory;
  /** Number of attempts (1 + retries). */
  attempts: number;
};

export type DurationRegression = {
  testId: string;
  title: string;
  projectName: string;
  durationMs: number;
  baselineMs: number;
};

export type InsightsData = {
  version: 1;
  runId: string;
  generatedAt: string;
  /** Failed and flaky tests of the current run, plus tests with history signals. */
  tests: InsightTest[];
  history?: {
    runs: { runId: string, startTime: string, total: number, failed: number, flaky: number, url?: string }[];
    /** Tests that passed now but failed in the previous run. */
    fixedTestIds: string[];
    /** Unstable over the history window, even if they passed now. */
    unstable: { testId: string, title: string, projectName: string, instability: number, runs: HistoryOutcome[] }[];
    regressions: DurationRegression[];
  };
  ai?: {
    /** POST endpoint for "Ask AI". Relative URLs are resolved against the report. */
    endpoint?: string;
  };
  fix?: {
    /** URL with {file} {line} {title} {project} {testId} placeholders, e.g. a Jenkins "heal" job. */
    urlTemplate?: string;
  };
};

/** Request body sent by the "Ask AI" button. */
export type AskAiRequest = {
  prompt: string;
  test: Pick<InsightTest, 'testId' | 'title' | 'titlePath' | 'projectName' | 'file' | 'line'>;
};

/** Expected response: Markdown text. */
export type AskAiResponse = {
  markdown: string;
  model?: string;
};
