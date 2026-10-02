/**
 * "Ask AI" and "Fix" on the regular test page, next to "Copy prompt".
 * Two pieces are mounted by a small patch in testResultView.tsx: the buttons (inside
 * the Errors chip header) and the panel (right after the chip). They share state here.
 */

import * as React from 'react';
import type { LoadedReport } from '../../loadedReport';
import type { TestCase, TestResult } from '../../types';
import type { InsightsData, InsightTest } from '../../../../src/shared/insightsFormat';
import { extendedTabs } from '../extendedTabs';
import { FixMenu } from '../insights/actions';
import { AgentPanel } from './agentPanel';
import { OpenInIdeButton } from '../ide';

type OpenState = { key: string, action: 'analyze' | 'fix' } | undefined;

let openState: OpenState;
const listeners = new Set<() => void>();
function setOpenState(state: OpenState) {
  openState = state;
  listeners.forEach(l => l());
}
function useOpenState(): OpenState {
  return React.useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => openState);
}

let insightsCache: InsightsData | null | undefined;
function insightsData(): InsightsData | undefined {
  if (insightsCache === undefined) {
    const tab = extendedTabs().find(t => t.format === 'insights');
    try {
      insightsCache = tab ? JSON.parse(tab.content) as InsightsData : null;
    } catch {
      insightsCache = null;
    }
  }
  return insightsCache ?? undefined;
}

function insightFor(test: TestCase): InsightTest {
  const known = insightsData()?.tests.find(t => t.testId === test.testId);
  if (known)
    return known;
  const failed = [...test.results].reverse().find(r => r.status !== 'passed') ?? test.results[test.results.length - 1];
  return {
    testId: test.testId,
    title: test.title,
    titlePath: [...test.path, test.title],
    projectName: test.projectName,
    file: test.location.file,
    line: test.location.line,
    outcome: test.outcome,
    error: failed?.errors[0]?.message,
    network: [],
    console: [],
    attempts: test.results.length,
  };
}

const stateKey = (test: TestCase, result: TestResult) => `${test.testId}#${test.results.indexOf(result)}`;

export const TestPageAgentButtons: React.FC<{ test: TestCase, result: TestResult }> = ({ test, result }) => {
  const key = stateKey(test, result);
  const open = useOpenState();
  const insight = React.useMemo(() => insightFor(test), [test]);
  return <>
    <button className='button' data-testid='test-page-ask-ai' aria-pressed={open?.key === key && open.action === 'analyze'} onClick={() => setOpenState(open?.key === key && open.action === 'analyze' ? undefined : { key, action: 'analyze' })}>Ask AI</button>
    <FixMenu test={insight} data={insightsData()} onAgentFix={() => setOpenState({ key, action: 'fix' })} />
    <OpenInIdeButton file={test.location.file} line={test.location.line} column={test.location.column} />
  </>;
};

export const TestPageAgentPanel: React.FC<{ test: TestCase, result: TestResult, report: LoadedReport }> = ({ test, result, report }) => {
  const key = stateKey(test, result);
  const open = useOpenState();
  const insight = React.useMemo(() => insightFor(test), [test]);
  if (open?.key !== key)
    return null;
  return <div className='test-page-agent'>
    <AgentPanel key={open.action} test={insight} data={insightsData()} report={report} attempt={test.results.indexOf(result)} initialAction={open.action} />
  </div>;
};
