/**
 * Run history: a small JSON file with the outcome and duration of every test
 * for the last N runs. It must survive between CI builds (see docs/INSIGHTS.md),
 * a copy is also written into the report folder so it can be archived.
 */

import fs from 'fs';
import path from 'path';

import type { DurationRegression, HistoryOutcome, TestHistory } from '../shared/insightsFormat';

export type HistoryRun = {
  runId: string;
  startTime: string;
  url?: string;
  stats: { total: number, failed: number, flaky: number };
  /** testId -> [outcome, durationMs] */
  tests: Record<string, [HistoryOutcome, number]>;
};

export type HistoryFile = {
  version: 1;
  runs: HistoryRun[];
};

export function loadHistory(file: string): HistoryFile {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as HistoryFile;
    if (data?.version === 1 && Array.isArray(data.runs))
      return data;
  } catch {
  }
  return { version: 1, runs: [] };
}

export function saveHistory(file: string, history: HistoryFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(history));
}

export function appendRun(history: HistoryFile, run: HistoryRun, maxRuns: number): HistoryFile {
  // Re-running the same build id replaces its entry instead of adding a duplicate.
  const runs = history.runs.filter(r => r.runId !== run.runId);
  runs.push(run);
  return { version: 1, runs: runs.slice(-maxRuns) };
}

export function testHistory(history: HistoryFile, testId: string): TestHistory | undefined {
  const runs = history.runs
      .filter(r => r.tests[testId])
      .map(r => ({ runId: r.runId, outcome: r.tests[testId][0], durationMs: r.tests[testId][1] }));
  if (!runs.length)
    return undefined;
  const executed = runs.filter(r => r.outcome !== 's');
  const failedRuns = executed.filter(r => r.outcome === 'f').length;
  const unstableRuns = executed.filter(r => r.outcome === 'f' || r.outcome === 'k').length;
  const current = runs[runs.length - 1];
  const previous = executed.slice(0, -1);
  let failingStreak = 0;
  for (let i = executed.length - 1; i >= 0 && executed[i].outcome === 'f'; i--)
    ++failingStreak;
  return {
    runs,
    failedRuns,
    totalRuns: executed.length,
    isNewFailure: current.outcome === 'f' && previous.length > 0 && previous.every(r => r.outcome === 'p'),
    failingStreak,
    instability: executed.length ? unstableRuns / executed.length : 0,
  };
}

/** Pass -> fail -> pass (or the reverse) at least twice: fails without a pattern. */
export function isIntermittent(h: TestHistory): boolean {
  const outcomes = h.runs.map(r => r.outcome).filter(o => o !== 's').map(o => o === 'p' ? 'p' : 'f');
  let switches = 0;
  for (let i = 1; i < outcomes.length; i++) {
    if (outcomes[i] !== outcomes[i - 1])
      ++switches;
  }
  return switches >= 2 || h.runs.some(r => r.outcome === 'k');
}

export function durationRegression(h: TestHistory, minRuns = 3): { durationMs: number, baselineMs: number } | undefined {
  const current = h.runs[h.runs.length - 1];
  if (current.outcome !== 'p')
    return undefined;
  const previous = h.runs.slice(0, -1).filter(r => r.outcome === 'p').map(r => r.durationMs).sort((a, b) => a - b);
  if (previous.length < minRuns)
    return undefined;
  const baselineMs = previous[Math.floor(previous.length / 2)];
  if (current.durationMs > baselineMs * 2 && current.durationMs - baselineMs > 500)
    return { durationMs: current.durationMs, baselineMs };
  return undefined;
}

export type { DurationRegression };
