import * as React from 'react';
import { clsx } from '@web/uiUtils';
import { formatUrl } from '../../utils';
import type { LoadedReport } from '../../loadedReport';
import type { TestCase } from '../../types';
import type { InsightsData, InsightTest } from '../../../../src/shared/insightsFormat';
import { renderMarkdown } from '../markdown';
import { useTestCase } from '../insights/attemptsCompare';
import { buildPrompt } from '../insights/actions';
import './agent.css';

type AgentStatus = { enabled: boolean, model: string, canRun: boolean, canApply: boolean, tracesFromDisk: boolean };
type JobKind = 'analyze' | 'debug' | 'fix' | 'apply' | 'revert';
type FixProposal = { id: string, explanation: string, files: { file: string, diff: string, inRepo: boolean }[], canApply: boolean, applied?: boolean, reverted?: boolean, verify?: { status: string, error?: string, durationMs?: number } };
type Job = {
  id: string;
  kind: JobKind;
  status: 'running' | 'done' | 'error';
  log: { time: number, text: string }[];
  result?: { markdown?: string, evidence?: string, prompt?: string, model?: string, fix?: FixProposal, rerun?: { status: string } };
  error?: string;
};

/** Where the agent API lives: an explicit gateway (Jenkins-hosted reports) or the server that serves this report. */
function agentBase(data?: InsightsData): string {
  const endpoint = data?.ai?.endpoint;
  if (!endpoint)
    return '';
  return endpoint.replace(/api\/(agent|ai)\/.*$/, '').replace(/\/?$/, '/');
}

let statusCache: Promise<AgentStatus | null> | undefined;
let statusCacheBase: string | undefined;

export function useAgentStatus(data?: InsightsData): AgentStatus | null | undefined {
  const base = agentBase(data);
  const [status, setStatus] = React.useState<AgentStatus | null | undefined>();
  React.useEffect(() => {
    if (location.protocol === 'file:' && !base) {
      setStatus(null);
      return;
    }
    if (!statusCache || statusCacheBase !== base) {
      statusCacheBase = base;
      statusCache = fetch(base + 'api/agent/status').then(r => r.ok ? r.json() : null).then(s => s?.enabled ? s : null).catch(() => null);
    }
    let cancelled = false;
    statusCache.then(s => !cancelled && setStatus(s));
    return () => {
      cancelled = true;
    };
  }, [base]);
  return status;
}

function lastFailedAttempt(test: TestCase): number {
  for (let i = test.results.length - 1; i >= 0; i--) {
    if (test.results[i].status !== 'passed' && test.results[i].status !== 'skipped')
      return i;
  }
  return test.results.length - 1;
}

async function toBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buffer.length; i += 0x8000)
    binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * The agent UI: analysis, local re-run, fix proposal with diff, apply & verify, revert.
 * Without an agent backend it degrades to "copy the prompt".
 */
export const AgentPanel: React.FC<{
  test: InsightTest,
  data?: InsightsData,
  report: LoadedReport | undefined,
  /** Attempt to analyze (defaults to the last failed one). */
  attempt?: number,
  initialAction?: 'analyze' | 'fix',
}> = ({ test, data, report, attempt, initialAction = 'analyze' }) => {
  const status = useAgentStatus(data);
  const testCase = useTestCase(report, test.testId);
  const [comment, setComment] = React.useState('');
  const [job, setJob] = React.useState<Job>();
  const [analysis, setAnalysis] = React.useState<string>();
  const [fix, setFix] = React.useState<FixProposal>();
  const [fixJob, setFixJob] = React.useState<Job>();
  const [fallbackPrompt, setFallbackPrompt] = React.useState<string>();
  const startedRef = React.useRef(false);
  const base = agentBase(data);

  const buildRequest = React.useCallback(async (kind: JobKind, extra: Record<string, unknown> = {}) => {
    if (!testCase || testCase === 'not-found')
      throw new Error('Test data is not loaded');
    const index = attempt ?? lastFailedAttempt(testCase);
    const result = testCase.results[index];
    const trace = result?.attachments.find(a => a.name === 'trace' && a.path);
    const errorContextAttachment = result?.attachments.find(a => a.name === 'error-context');
    let errorContext = errorContextAttachment?.body;
    if (!errorContext && errorContextAttachment?.path)
      errorContext = await fetch(formatUrl(errorContextAttachment.path)).then(r => r.ok ? r.text() : undefined).catch(() => undefined);
    let traceBase64: string | undefined;
    if (trace?.path && !status?.tracesFromDisk)
      traceBase64 = await fetch(formatUrl(trace.path)).then(r => r.ok ? r.blob() : undefined).then(b => b ? toBase64(b) : undefined).catch(() => undefined);
    return {
      kind,
      test: testCase,
      attempt: index,
      insight: test,
      tracePath: trace?.path,
      traceBase64,
      errorContext,
      comment: comment.trim() || undefined,
      ...extra,
    };
  }, [testCase, attempt, status, test, comment]);

  const runJob = React.useCallback(async (kind: JobKind, extra: Record<string, unknown> = {}, onUpdate: (job: Job) => void = setJob): Promise<Job> => {
    const pending: Job = { id: '', kind, status: 'running', log: [{ time: Date.now(), text: 'Collecting test data…' }] };
    onUpdate(pending);
    try {
      const body = await buildRequest(kind, extra);
      const response = await fetch(base + 'api/agent/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok)
        throw new Error(`${response.status}: ${(await response.text()).slice(0, 300)}`);
      const { id } = await response.json();
      while (true) {
        await new Promise(r => setTimeout(r, 600));
        const current = await fetch(base + `api/agent/jobs/${id}`).then(r => r.json()) as Job;
        onUpdate(current);
        if (current.status !== 'running')
          return current;
      }
    } catch (e) {
      const failed: Job = { ...pending, status: 'error', error: String(e.message || e) };
      onUpdate(failed);
      return failed;
    }
  }, [base, buildRequest]);

  const analyze = React.useCallback(async (kind: 'analyze' | 'debug') => {
    const done = await runJob(kind);
    if (done.result?.markdown)
      setAnalysis(done.result.markdown);
  }, [runJob]);

  const proposeFix = React.useCallback(async (previousFixError?: string) => {
    setFix(undefined);
    const done = await runJob('fix', { analysis, previousFixError }, setFixJob);
    if (done.result?.fix)
      setFix(done.result.fix);
  }, [runJob, analysis]);

  const applyOrRevert = React.useCallback(async (kind: 'apply' | 'revert') => {
    if (!fix)
      return;
    const done = await runJob(kind, { fixId: fix.id }, setFixJob);
    if (done.result?.fix)
      setFix(done.result.fix);
  }, [runJob, fix]);

  // "Ask AI" / "Fix" are explicit clicks: start right away once everything is loaded.
  React.useEffect(() => {
    if (startedRef.current || !status || !testCase || testCase === 'not-found')
      return;
    startedRef.current = true;
    if (initialAction === 'fix')
      proposeFix();
    else
      analyze('analyze');
  }, [status, testCase, initialAction, analyze, proposeFix]);

  React.useEffect(() => {
    if (status !== null || !testCase || testCase === 'not-found')
      return;
    const result = testCase.results[attempt ?? lastFailedAttempt(testCase)];
    const ec = result?.attachments.find(a => a.name === 'error-context');
    const load = ec?.body ? Promise.resolve(ec.body) : ec?.path ? fetch(formatUrl(ec.path)).then(r => r.ok ? r.text() : undefined).catch(() => undefined) : Promise.resolve(undefined);
    load.then(text => setFallbackPrompt(buildPrompt(test, text)));
  }, [status, testCase, attempt, test]);

  if (status === undefined)
    return <div className='agent-panel'><div className='insights-note'>Connecting to the AI agent…</div></div>;

  if (status === null) {
    return <div className='agent-panel' data-testid='agent-panel'>
      <div className='insights-note'>
        The AI agent is not available for this report. Copy the prompt into your LLM chat / IDE agent, or open the report with <code>npx pw-extended-report agent</code> in the tests repository (or set <code>EXTENDED_REPORT_AI_ENDPOINT</code> to a running <code>pw-extended-report ai-gateway</code>).
      </div>
      <CopyButton label='Copy prompt' text={fallbackPrompt} />
      {fallbackPrompt && <details className='insight-error'><summary>Prompt preview</summary><pre>{fallbackPrompt}</pre></details>}
    </div>;
  }

  const busy = job?.status === 'running' || fixJob?.status === 'running';
  return <div className='agent-panel' data-testid='agent-panel'>
    <div className='agent-header'>
      <span className='agent-model'>AI agent · {status.model}</span>
      {!status.canRun && <span className='muted'>analysis only — run <code>pw-extended-report agent</code> in the tests repo to re-run and apply fixes</span>}
    </div>
    <textarea
      className='agent-comment'
      data-testid='agent-comment'
      placeholder='Hint for the agent (optional), e.g. "auth is fine, the locator of the cart counter changed after the redesign"'
      value={comment}
      onChange={e => setComment(e.target.value)}
      rows={2} />
    <div className='insight-actions'>
      <button className='button' disabled={busy} onClick={() => analyze('analyze')}>{analysis ? 'Analyze again' : 'Analyze'}</button>
      {status.canRun && <button className='button' disabled={busy} onClick={() => analyze('debug')} title='Re-run the test locally with trace and analyze both runs'>Run &amp; debug</button>}
      <button className='button' disabled={busy} onClick={() => proposeFix()}>Propose fix</button>
      <CopyButton label='Copy analysis' text={analysis} />
      <CopyButton label='Copy prompt' text={job?.result?.prompt} />
    </div>

    {job && <JobView job={job} />}
    {job?.result?.markdown && <div className='agent-answer'>
      <div className='ai-answer-meta'>{job.kind === 'debug' ? 'Run & debug' : 'Analysis'}{job.result.model ? ` · ${job.result.model}` : ''}{job.result.rerun ? ` · local run: ${job.result.rerun.status}` : ''}</div>
      <div className='markdown-body' data-testid='agent-answer' dangerouslySetInnerHTML={{ __html: renderMarkdown(job.result.markdown) }} />
    </div>}
    {job?.result?.evidence && <details className='insight-error' data-testid='agent-evidence'>
      <summary>What the agent looked at (evidence from the trace, DOM, logs and code)</summary>
      <div className='markdown-body' dangerouslySetInnerHTML={{ __html: renderMarkdown(job.result.evidence) }} />
    </details>}

    {fixJob && <div className='agent-fix' data-testid='agent-fix'>
      <div className='insight-section-title'>Fix</div>
      <JobView job={fixJob} />
      {fix && <>
        {fix.explanation && <div className='markdown-body' dangerouslySetInnerHTML={{ __html: renderMarkdown(fix.explanation) }} />}
        {fix.files.map(f => <DiffView key={f.file} diff={f.diff} />)}
        {!!fix.files.length && <div className='insight-actions'>
          <CopyButton label='Copy fix (diff)' text={fix.files.map(f => f.diff).join('\n')} />
          {status.canApply && fix.canApply && !fix.applied && <button className='button primary' disabled={busy} onClick={() => applyOrRevert('apply')} data-testid='agent-apply'>Apply &amp; verify</button>}
          {fix.applied && <button className='button' disabled={busy} onClick={() => applyOrRevert('revert')}>Revert</button>}
          {fix.verify && fix.verify.status !== 'passed' && <button className='button' disabled={busy} onClick={() => proposeFix(fix.verify?.error ?? fix.verify?.status)}>Propose another fix</button>}
        </div>}
        {fix.verify && <div className={clsx('agent-verify', fix.verify.status === 'passed' ? 'ok' : 'bad')} data-testid='agent-verify'>
          {fix.verify.status === 'passed' ? '✓ The test passes with the fix.' : `✗ The test still fails (${fix.verify.status}).`}
          {fix.verify.error && <pre>{fix.verify.error.split('\n').slice(0, 12).join('\n')}</pre>}
        </div>}
        {fix.reverted && <div className='insights-note'>The change was reverted.</div>}
      </>}
    </div>}
  </div>;
};

const JobView: React.FC<{ job: Job }> = ({ job }) => {
  const open = job.status !== 'done';
  return <details className='agent-log' open={open} data-testid='agent-log'>
    <summary>
      {job.status === 'running' && <span className='agent-spinner' />}
      {job.status === 'running' ? (job.log[job.log.length - 1]?.text ?? 'Working…') : job.status === 'error' ? `Failed: ${job.error}` : `${job.log.length} step(s)`}
    </summary>
    <pre>{job.log.map(l => l.text).join('\n')}</pre>
  </details>;
};

const DiffView: React.FC<{ diff: string }> = ({ diff }) => {
  return <pre className='agent-diff' data-testid='agent-diff'>{diff.split('\n').map((line, i) => <div key={i} className={clsx(line.startsWith('+') && !line.startsWith('+++') && 'add', line.startsWith('-') && !line.startsWith('---') && 'del', line.startsWith('@@') && 'hunk')}>{line || ' '}</div>)}</pre>;
};

const CopyButton: React.FC<{ label: string, text: string | undefined }> = ({ label, text }) => {
  const [copied, setCopied] = React.useState(false);
  return <button className='button' disabled={!text} onClick={async () => {
    if (!text)
      return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }}>{copied ? 'Copied' : label}</button>;
};
