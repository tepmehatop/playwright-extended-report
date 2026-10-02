import * as React from 'react';
import { clsx } from '@web/uiUtils';
import { msToString } from '@isomorphic/formatUtils';
import { stripAnsiEscapes } from '@isomorphic/stringUtils';
import { statusIcon } from '../../statusIcon';
import { formatUrl } from '../../utils';
import type { LoadedReport } from '../../loadedReport';
import type { TestCase, TestFile, TestResult, TestStep } from '../../types';

/** Loads full test data (results, steps, attachments) from the report zip. */
export function useTestCase(report: LoadedReport | undefined, testId: string): TestCase | undefined | 'not-found' {
  const [test, setTest] = React.useState<TestCase | undefined | 'not-found'>();
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const file = report?.json().files.find(f => f.tests.some(t => t.testId === testId));
      if (!report || !file) {
        setTest('not-found');
        return;
      }
      const data = await report.entry(`${file.fileId}.json`) as TestFile;
      if (!cancelled)
        setTest(data.tests.find(t => t.testId === testId) ?? 'not-found');
    })();
    return () => {
      cancelled = true;
    };
  }, [report, testId]);
  return test;
}

type FlatStep = { title: string, duration: number, error?: string, depth: number };

function flattenSteps(steps: TestStep[], depth = 0, out: FlatStep[] = []): FlatStep[] {
  for (const step of steps) {
    out.push({ title: step.title + (step.subtitle ? ` ${step.subtitle}` : ''), duration: step.duration, error: step.error, depth });
    // Two levels of nesting keep the comparison readable.
    if (step.steps.length && depth < 2)
      flattenSteps(step.steps, depth + 1, out);
  }
  return out;
}

/**
 * Side-by-side view of the failed attempt and the most relevant other attempt
 * (a passed retry for flaky tests, otherwise the previous attempt).
 */
export const AttemptsCompare: React.FC<{ testId: string, report: LoadedReport | undefined }> = ({ testId, report }) => {
  const test = useTestCase(report, testId);
  if (!test)
    return <div className='insights-note'>Loading…</div>;
  if (test === 'not-found' || test.results.length < 2)
    return <div className='insights-note'>Only one attempt was recorded for this test.</div>;

  const failedIndex = test.results.map((r, i) => ({ r, i })).filter(e => e.r.status !== 'passed' && e.r.status !== 'skipped').map(e => e.i).pop() ?? 0;
  const passedIndex = test.results.findIndex(r => r.status === 'passed');
  const otherIndex = passedIndex !== -1 ? passedIndex : (failedIndex > 0 ? failedIndex - 1 : 1);
  const left = test.results[failedIndex];
  const right = test.results[otherIndex];
  const leftSteps = flattenSteps(left.steps);
  const rightSteps = flattenSteps(right.steps);
  const divergence = firstDivergence(leftSteps, rightSteps);

  return <div className='attempts-compare' data-testid='attempts-compare'>
    <div className='attempts-summary'>
      {passedIndex !== -1
        ? <>Attempt #{failedIndex + 1} failed, attempt #{passedIndex + 1} passed. {divergence !== -1 ? `They diverge at step ${divergence + 1}: "${leftSteps[divergence]?.title ?? rightSteps[divergence]?.title}".` : 'Steps are identical; compare timings and screenshots.'}</>
        : <>All attempts failed. {sameErrors(left, right) ? 'With the same error: a stable failure, not flakiness.' : 'With different errors: look for unstable steps.'}</>}
    </div>
    <div className='attempts-columns'>
      <AttemptColumn test={test} result={left} index={failedIndex} steps={leftSteps} other={rightSteps} divergence={divergence} />
      <AttemptColumn test={test} result={right} index={otherIndex} steps={rightSteps} other={leftSteps} divergence={divergence} />
    </div>
  </div>;
};

const AttemptColumn: React.FC<{ test: TestCase, result: TestResult, index: number, steps: FlatStep[], other: FlatStep[], divergence: number }> = ({ test, result, index, steps, other, divergence }) => {
  const screenshots = result.attachments.filter(a => a.contentType.startsWith('image/') && a.path);
  return <div className='attempt-column'>
    <div className='attempt-header'>
      {statusIcon(result.status)}
      <a href={`#?testId=${encodeURIComponent(test.testId)}&run=${index}`}>Attempt #{index + 1}</a>
      <span className='muted'>{result.status} · {msToString(result.duration)}</span>
    </div>
    {result.errors.length > 0 && <pre className='attempt-error'>{stripAnsiEscapes(result.errors[0].message).split('\n').slice(0, 6).join('\n')}</pre>}
    <ol className='attempt-steps'>
      {steps.map((s, i) => {
        const counterpart = other[i];
        const slower = counterpart && counterpart.title === s.title && s.duration > 500 && s.duration > counterpart.duration * 2;
        return <li key={i} className={clsx(s.error && 'step-error', i === divergence && 'step-diverge', slower && 'step-slow')} style={{ paddingLeft: s.depth * 14 }}>
          <span className='attempt-step-title'>{s.title}</span>
          <span className='muted'>{msToString(s.duration)}</span>
        </li>;
      })}
    </ol>
    {screenshots.map((a, i) => <a key={i} href={formatUrl(a.path!)} target='_blank' rel='noreferrer'>
      <img className='attempt-screenshot' src={formatUrl(a.path!)} alt={a.name} />
    </a>)}
  </div>;
};

function firstDivergence(a: FlatStep[], b: FlatStep[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (!a[i] || !b[i] || a[i].title !== b[i].title || !!a[i].error !== !!b[i].error)
      return i;
  }
  return -1;
}

function sameErrors(a: TestResult, b: TestResult): boolean {
  const first = (r: TestResult) => stripAnsiEscapes(r.errors[0]?.message ?? '').split('\n')[0];
  return first(a) === first(b);
}
