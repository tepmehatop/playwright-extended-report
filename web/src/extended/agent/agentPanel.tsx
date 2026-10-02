import * as React from 'react';
import { clsx } from '@web/uiUtils';
import { formatUrl } from '../../utils';
import type { LoadedReport } from '../../loadedReport';
import type { TestCase, TestFile } from '../../types';
import type { InsightCluster, InsightsData, InsightTest, PrecomputedAnalysis } from '../../../../src/shared/insightsFormat';
import { renderMarkdown } from '../markdown';
import { useTestCase } from '../insights/attemptsCompare';
import { buildPrompt } from '../insights/actions';
import { texts } from '../i18n';
import './agent.css';

type AgentStatus = { enabled: boolean, model: string, canRun: boolean, canApply: boolean, tracesFromDisk: boolean, mcp?: { servers: { name: string, status: string, tools: number }[] } };
type JobKind = 'analyze' | 'debug' | 'fix' | 'apply' | 'revert' | 'lab';
type LabResult = { locator: string, ok: boolean, count: number, visible?: boolean, text?: string, element?: string, error?: string };
type FixProposal = { id: string, explanation: string, files: { file: string, diff: string, inRepo: boolean }[], canApply: boolean, lab?: LabResult[], applied?: boolean, reverted?: boolean, verify?: { status: string, error?: string, durationMs?: number, tests?: { title: string, status: string }[] } };
type Job = {
  id: string;
  kind: JobKind;
  status: 'running' | 'done' | 'error';
  log: { time: number, text: string }[];
  result?: { markdown?: string, evidence?: string, prompt?: string, model?: string, path?: 'mcp' | 'simple', toolCalls?: { name: string, ok: boolean }[], fix?: FixProposal, rerun?: { status: string }, lab?: LabResult[] };
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

/** Full test cases of several tests (for an error group). */
function useTestCases(report: LoadedReport | undefined, testIds: string[]): TestCase[] | undefined {
  const [tests, setTests] = React.useState<TestCase[]>();
  const key = testIds.join(',');
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!report || !testIds.length) {
        setTests([]);
        return;
      }
      const files = new Map<string, TestFile>();
      const result: TestCase[] = [];
      for (const id of testIds) {
        const summary = report.json().files.find(f => f.tests.some(t => t.testId === id));
        if (!summary)
          continue;
        if (!files.has(summary.fileId))
          files.set(summary.fileId, await report.entry(`${summary.fileId}.json`) as TestFile);
        const test = files.get(summary.fileId)!.tests.find(t => t.testId === id);
        if (test)
          result.push(test);
      }
      if (!cancelled)
        setTests(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [report, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return tests;
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
 * The agent UI: analysis (MCP-assisted or simple), local re-run, fix proposal with diff and locator lab,
 * apply & verify, revert. Works for one test or a whole error group. Without an agent backend it
 * degrades to "copy the prompt" (and shows the analysis prepared in CI, if any).
 */
export const AgentPanel: React.FC<{
  test: InsightTest,
  data?: InsightsData,
  report: LoadedReport | undefined,
  /** Attempt to analyze (defaults to the last failed one). */
  attempt?: number,
  initialAction?: 'analyze' | 'fix',
  /** Analyze / fix the whole group; `test` is its representative. */
  group?: { cluster: InsightCluster, tests: InsightTest[] },
}> = ({ test, data, report, attempt, initialAction = 'analyze', group }) => {
  const t = texts();
  const status = useAgentStatus(data);
  const testCase = useTestCase(report, test.testId);
  const otherIds = React.useMemo(() => (group?.tests ?? []).map(x => x.testId).filter(id => id !== test.testId), [group, test]);
  const otherCases = useTestCases(report, otherIds);
  const [comment, setComment] = React.useState('');
  const [job, setJob] = React.useState<Job>();
  const [analysis, setAnalysis] = React.useState<string>();
  const [fix, setFix] = React.useState<FixProposal>();
  const [fixJob, setFixJob] = React.useState<Job>();
  const [labJob, setLabJob] = React.useState<Job>();
  const [labInput, setLabInput] = React.useState('');
  const [fallbackPrompt, setFallbackPrompt] = React.useState<string>();
  const startedRef = React.useRef(false);
  const base = agentBase(data);

  const precomputed: { analysis: PrecomputedAnalysis, label: string } | undefined = React.useMemo(() => {
    if (group?.cluster.ai)
      return { analysis: group.cluster.ai, label: t.groupFromCi };
    if (test.ai)
      return { analysis: test.ai, label: t.fromCi };
    const cluster = data?.clusters?.find(c => c.id === test.clusterId);
    if (cluster?.ai)
      return { analysis: cluster.ai, label: t.groupFromCi };
    return undefined;
  }, [group, test, data, t]);

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
      group: group && otherCases?.length ? { id: group.cluster.id, title: group.cluster.title, tests: otherCases, insights: otherCases.map(c => group.tests.find(x => x.testId === c.testId)) } : undefined,
      ...extra,
    };
  }, [testCase, attempt, status, test, comment, group, otherCases]);

  const runJob = React.useCallback(async (kind: JobKind, extra: Record<string, unknown> = {}, onUpdate: (job: Job) => void = setJob): Promise<Job> => {
    const pending: Job = { id: '', kind, status: 'running', log: [{ time: Date.now(), text: t.collecting }] };
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
  }, [base, buildRequest, t]);

  const analyze = React.useCallback(async (kind: 'analyze' | 'debug') => {
    const done = await runJob(kind);
    if (done.result?.markdown)
      setAnalysis(done.result.markdown);
  }, [runJob]);

  const proposeFix = React.useCallback(async (previousFixError?: string) => {
    setFix(undefined);
    const done = await runJob('fix', { analysis: analysis ?? precomputed?.analysis.markdown, previousFixError }, setFixJob);
    if (done.result?.fix)
      setFix(done.result.fix);
  }, [runJob, analysis, precomputed]);

  const applyOrRevert = React.useCallback(async (kind: 'apply' | 'revert') => {
    if (!fix)
      return;
    const done = await runJob(kind, { fixId: fix.id }, setFixJob);
    if (done.result?.fix)
      setFix(done.result.fix);
  }, [runJob, fix]);

  const ready = !!status && !!testCase && testCase !== 'not-found' && (!group || !!otherCases);

  // "Ask AI" / "Fix" are explicit clicks: start right away, unless an analysis from CI is already there.
  React.useEffect(() => {
    if (startedRef.current || !ready)
      return;
    startedRef.current = true;
    if (initialAction === 'fix')
      proposeFix();
    else if (!precomputed)
      analyze('analyze');
  }, [ready, initialAction, analyze, proposeFix, precomputed]);

  React.useEffect(() => {
    if (status !== null || !testCase || testCase === 'not-found')
      return;
    const result = testCase.results[attempt ?? lastFailedAttempt(testCase)];
    const ec = result?.attachments.find(a => a.name === 'error-context');
    const load = ec?.body ? Promise.resolve(ec.body) : ec?.path ? fetch(formatUrl(ec.path)).then(r => r.ok ? r.text() : undefined).catch(() => undefined) : Promise.resolve(undefined);
    load.then(text => setFallbackPrompt(buildPrompt(test, text)));
  }, [status, testCase, attempt, test]);

  const precomputedView = precomputed && !job?.result?.markdown && <div className='agent-answer' data-testid='agent-precomputed'>
    <div className='ai-answer-meta'>{precomputed.label}{precomputed.analysis.model ? ` · ${precomputed.analysis.model}` : ''} · {new Date(precomputed.analysis.generatedAt).toLocaleString()}</div>
    <div className='markdown-body' dangerouslySetInnerHTML={{ __html: renderMarkdown(precomputed.analysis.markdown) }} />
  </div>;

  if (status === undefined)
    return <div className='agent-panel'><div className='insights-note'>{t.connecting}</div></div>;

  if (status === null) {
    return <div className='agent-panel' data-testid='agent-panel'>
      {precomputedView}
      <div className='insights-note' dangerouslySetInnerHTML={{ __html: renderMarkdown(t.noAgent) }} />
      <div className='insight-actions'>
        <CopyButton label={t.copyPrompt} text={fallbackPrompt} />
        {precomputed && <CopyButton label={t.copyAnalysis} text={precomputed.analysis.markdown} />}
      </div>
      {fallbackPrompt && <details className='insight-error'><summary>{t.promptPreview}</summary><pre>{fallbackPrompt}</pre></details>}
    </div>;
  }

  const busy = job?.status === 'running' || fixJob?.status === 'running';
  const mcpServers = status.mcp?.servers ?? [];
  return <div className='agent-panel' data-testid='agent-panel'>
    <div className='agent-header'>
      <span className='agent-model'>{t.agent} · {status.model}</span>
      {!!mcpServers.length && <span className='muted' title={mcpServers.map(s => `${s.name}: ${s.status}${s.tools ? ` (${s.tools})` : ''}`).join('\n')}>{t.mcp}: {mcpServers.map(s => s.name).join(', ')}</span>}
      {!status.canRun && <span className='muted' dangerouslySetInnerHTML={{ __html: renderInline(t.analysisOnly) }} />}
    </div>
    {group && <div className='insights-note'>{t.groupHint}</div>}
    <textarea
      className='agent-comment'
      data-testid='agent-comment'
      placeholder={t.hint}
      value={comment}
      onChange={e => setComment(e.target.value)}
      rows={2} />
    <div className='insight-actions'>
      <button className='button' disabled={busy || !ready} onClick={() => analyze('analyze')}>{analysis || precomputed ? t.analyzeAgain : t.analyze}</button>
      {status.canRun && !group && <button className='button' disabled={busy || !ready} onClick={() => analyze('debug')} title={t.runDebugTitle}>{t.runDebug}</button>}
      <button className='button' disabled={busy || !ready} onClick={() => proposeFix()}>{t.proposeFix}</button>
      <CopyButton label={t.copyAnalysis} text={analysis ?? precomputed?.analysis.markdown} />
      <CopyButton label={t.copyPrompt} text={job?.result?.prompt} />
    </div>

    {precomputedView}
    {job && <JobView job={job} />}
    {job?.result?.markdown && <div className='agent-answer'>
      <div className='ai-answer-meta'>
        {group ? t.groupAnalysis : job.kind === 'debug' ? t.debugLabel : t.analysisLabel}
        {job.result.model ? ` · ${job.result.model}` : ''}
        {job.result.path === 'mcp' ? ` · ${t.viaMcp}, ${t.toolCalls(job.result.toolCalls?.length ?? 0)}` : ''}
        {job.result.rerun ? ` · ${t.localRun}: ${job.result.rerun.status}` : ''}
      </div>
      <div className='markdown-body' data-testid='agent-answer' dangerouslySetInnerHTML={{ __html: renderMarkdown(job.result.markdown) }} />
    </div>}
    {(job?.result?.evidence || (!job && precomputed?.analysis.evidence)) && <details className='insight-error' data-testid='agent-evidence'>
      <summary>{t.evidence}</summary>
      <div className='markdown-body' dangerouslySetInnerHTML={{ __html: renderMarkdown(job?.result?.evidence ?? precomputed!.analysis.evidence!) }} />
    </details>}

    <details className='insight-error agent-lab' data-testid='agent-lab'>
      <summary>{t.labTitle}</summary>
      <textarea className='agent-comment' rows={2} placeholder={t.labHint} value={labInput} onChange={e => setLabInput(e.target.value)} data-testid='agent-lab-input' />
      <div className='insight-actions'>
        <button className='button' disabled={!labInput.trim() || labJob?.status === 'running' || !ready} onClick={() => runJob('lab', { locators: labInput.split('\n').map(l => l.trim()).filter(Boolean) }, setLabJob)}>{t.labRun}</button>
      </div>
      {labJob && labJob.status !== 'done' && <JobView job={labJob} />}
      {labJob?.result?.lab && <LabTable results={labJob.result.lab} />}
    </details>

    {fixJob && <div className='agent-fix' data-testid='agent-fix'>
      <div className='insight-section-title'>{t.fix}</div>
      <JobView job={fixJob} />
      {fix && <>
        {fix.explanation && <div className='markdown-body' dangerouslySetInnerHTML={{ __html: renderMarkdown(fix.explanation) }} />}
        {fix.files.map(f => <DiffView key={f.file} diff={f.diff} />)}
        {!!fix.lab?.length && <div data-testid='agent-fix-lab'>
          <div className='insights-note'>{t.labFix}</div>
          <LabTable results={fix.lab} />
        </div>}
        {!!fix.files.length && <div className='insight-actions'>
          <CopyButton label={t.copyFix} text={fix.files.map(f => f.diff).join('\n')} />
          {status.canApply && fix.canApply && !fix.applied && <button className='button primary' disabled={busy} onClick={() => applyOrRevert('apply')} data-testid='agent-apply'>{t.applyVerify}</button>}
          {fix.applied && <button className='button' disabled={busy} onClick={() => applyOrRevert('revert')}>{t.revert}</button>}
          {fix.verify && fix.verify.status !== 'passed' && <button className='button' disabled={busy} onClick={() => proposeFix(fix.verify?.error ?? fix.verify?.status)}>{t.anotherFix}</button>}
        </div>}
        {fix.verify && <div className={clsx('agent-verify', fix.verify.status === 'passed' ? 'ok' : 'bad')} data-testid='agent-verify'>
          {fix.verify.status === 'passed' ? t.passesWithFix(fix.verify.tests?.length ?? 1) : t.stillFails(fix.verify.status)}
          {fix.verify.tests && <ul>{fix.verify.tests.map((x, i) => <li key={i}>{x.status === 'passed' ? '✓' : '✗'} {x.title}: {x.status}</li>)}</ul>}
          {fix.verify.error && <pre>{fix.verify.error.split('\n').slice(0, 12).join('\n')}</pre>}
        </div>}
        {fix.reverted && <div className='insights-note'>{t.reverted}</div>}
      </>}
    </div>}
  </div>;
};

const LabTable: React.FC<{ results: LabResult[] }> = ({ results }) => {
  const t = texts();
  return <div data-testid='lab-results'>
    <table className='insight-table'>
      <tbody>{results.map((r, i) => <tr key={i} className={clsx(r.ok ? 'lab-ok' : 'lab-bad')}>
        <td>{r.error ? '✗' : r.count === 1 ? '✓' : r.count > 1 ? '⚠' : '✗'}</td>
        <td className='mono'>{r.locator}</td>
        <td>{r.error ? r.error : `${t.elements(r.count)}${r.count > 1 ? ` (${t.strict})` : ''}${r.visible === false ? ` · ${t.hidden}` : ''}`}</td>
        <td className='mono muted'>{r.element}{r.text ? ` «${r.text}»` : ''}</td>
      </tr>)}</tbody>
    </table>
    <div className='insights-note'>{t.labNote}</div>
  </div>;
};

const JobView: React.FC<{ job: Job }> = ({ job }) => {
  const t = texts();
  const open = job.status !== 'done';
  return <details className='agent-log' open={open} data-testid='agent-log'>
    <summary>
      {job.status === 'running' && <span className='agent-spinner' />}
      {job.status === 'running' ? (job.log[job.log.length - 1]?.text ?? t.working) : job.status === 'error' ? `${t.failed}: ${job.error}` : t.steps(job.log.length)}
    </summary>
    <pre>{job.log.map(l => l.text).join('\n')}</pre>
  </details>;
};

const DiffView: React.FC<{ diff: string }> = ({ diff }) => {
  return <pre className='agent-diff' data-testid='agent-diff'>{diff.split('\n').map((line, i) => <div key={i} className={clsx(line.startsWith('+') && !line.startsWith('+++') && 'add', line.startsWith('-') && !line.startsWith('---') && 'del', line.startsWith('@@') && 'hunk')}>{line || ' '}</div>)}</pre>;
};

export const CopyButton: React.FC<{ label: string, text: string | undefined }> = ({ label, text }) => {
  const t = texts();
  const [copied, setCopied] = React.useState(false);
  return <button className='button' disabled={!text} onClick={async () => {
    if (!text)
      return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }}>{copied ? t.copied : label}</button>;
};

function renderInline(markdown: string): string {
  return renderMarkdown(markdown).replace(/^<p>|<\/p>\s*$/g, '');
}
