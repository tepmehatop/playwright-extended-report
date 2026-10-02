import * as React from 'react';
import { clsx } from '@web/uiUtils';
import { msToString } from '@isomorphic/formatUtils';
import { AutoChip } from '../../chip';
import { Label } from '../../labels';
import { statusIcon } from '../../statusIcon';
import { useSearchParams } from '../../links';
import type { LoadedReport } from '../../loadedReport';
import type { FailureKind, HistoryOutcome, InsightCluster, InsightsData, InsightTest, NetworkIssue } from '../../../../src/shared/insightsFormat';
import { AttemptsCompare } from './attemptsCompare';
import { backendBugReport, FixMenu } from './actions';
import { AgentPanel, CopyButton } from '../agent/agentPanel';
import { OpenInIdeButton } from '../ide';
import { texts } from '../i18n';
import './insights.css';

const kKindOrder: FailureKind[] = ['product-bug', 'environment', 'test-bug', 'ui-change', 'flaky', 'unknown'];

export function kindLabel(kind: FailureKind): string {
  return texts().kinds[kind];
}

export const InsightsView: React.FC<{ content: string, report: LoadedReport | undefined }> = ({ content, report }) => {
  const t = texts();
  const searchParams = useSearchParams();
  const groupParam = searchParams.get('group');
  const data = React.useMemo(() => {
    try {
      return JSON.parse(content) as InsightsData;
    } catch {
      return undefined;
    }
  }, [content]);
  const [kind, setKind] = React.useState<FailureKind | 'all' | 'new'>('all');
  const [view, setView] = React.useState<'tests' | 'groups'>(groupParam ? 'groups' : 'tests');
  React.useEffect(() => {
    if (groupParam)
      setView('groups');
  }, [groupParam]);
  if (!data)
    return <div className='insights-empty'>{t.corrupted}</div>;

  const counts = new Map<FailureKind, number>();
  for (const x of data.tests)
    counts.set(x.classification?.kind ?? 'unknown', (counts.get(x.classification?.kind ?? 'unknown') ?? 0) + 1);
  const newFailures = data.tests.filter(x => x.history?.isNewFailure).length;
  const visible = data.tests.filter(x => kind === 'all' || (kind === 'new' ? x.history?.isNewFailure : (x.classification?.kind ?? 'unknown') === kind));
  const clusters = data.clusters ?? [];

  return <div className='insights' data-testid='insights'>
    <div className='insights-filters'>
      <div className='insights-view-switch' role='tablist'>
        <button role='tab' aria-selected={view === 'tests'} className={clsx('insights-filter', view === 'tests' && 'active')} onClick={() => setView('tests')}>{t.byTest}<span className='counter'>{data.tests.length}</span></button>
        <button role='tab' aria-selected={view === 'groups'} className={clsx('insights-filter', view === 'groups' && 'active')} onClick={() => setView('groups')} data-testid='insights-groups-view'>{t.byGroup}<span className='counter'>{clusters.length}</span></button>
      </div>
    </div>

    {view === 'tests' && <>
      <div className='insights-filters' role='toolbar' aria-label='Failure kinds'>
        <FilterButton active={kind === 'all'} onClick={() => setKind('all')} label={t.allFailures} count={data.tests.length} />
        {kKindOrder.filter(k => counts.get(k)).map(k => <FilterButton key={k} active={kind === k} onClick={() => setKind(k)} label={kindLabel(k)} count={counts.get(k)!} kind={k} />)}
        {!!data.history && <FilterButton active={kind === 'new'} onClick={() => setKind('new')} label={t.newInRun} count={newFailures} />}
      </div>
      {!data.tests.length && <div className='insights-empty'>{t.noFailures}</div>}
      {visible.map(test => <InsightCard key={test.testId} test={test} data={data} report={report} />)}
    </>}

    {view === 'groups' && <>
      {!clusters.length && <div className='insights-empty'>{t.noFailures}</div>}
      {clusters.map(cluster => <GroupCard key={cluster.id} cluster={cluster} data={data} report={report} focused={groupParam === String(cluster.id)} />)}
    </>}

    {data.history ? <HistorySection data={data} report={report} /> : <div className='insights-note'>{t.historyOff}</div>}
  </div>;
};

const FilterButton: React.FC<{ active: boolean, onClick: () => void, label: string, count: number, kind?: FailureKind }> = ({ active, onClick, label, count, kind }) => {
  return <button className={clsx('insights-filter', active && 'active')} aria-pressed={active} onClick={onClick}>
    {kind && <span className={clsx('insights-kind-dot', `kind-${kind}`)} />}
    {label}<span className='counter'>{count}</span>
  </button>;
};

const GroupCard: React.FC<{ cluster: InsightCluster, data: InsightsData, report: LoadedReport | undefined, focused: boolean }> = ({ cluster, data, report, focused }) => {
  const t = texts();
  const ref = React.useRef<HTMLDivElement>(null);
  const [panel, setPanel] = React.useState<'none' | 'ai' | 'fix'>(focused ? 'ai' : 'none');
  const tests = cluster.testIds.map(id => data.tests.find(x => x.testId === id)).filter(Boolean) as InsightTest[];
  const kinds = [...new Set(tests.map(x => x.classification?.kind ?? 'unknown'))];
  React.useEffect(() => {
    if (focused) {
      ref.current?.scrollIntoView({ block: 'start' });
      setPanel(p => p === 'none' ? 'ai' : p);
    }
  }, [focused]);
  if (!tests.length)
    return null;
  return <div ref={ref} className={clsx('insight-card', focused && 'focused')} data-testid='group-card'>
    <div className='insight-card-header'>
      <span className='group-id'>{t.group} {cluster.id}</span>
      <span className='insight-title'>{cluster.title}</span>
      <div style={{ flex: 'auto' }} />
      {kinds.map(k => <span key={k} className={clsx('insights-kind', `kind-${k}`)}>{kindLabel(k)}</span>)}
    </div>
    <div className='insight-meta'>
      <span>{cluster.category}</span>
      <span>{t.tests(tests.length)}</span>
      {cluster.topLocation && <span>{t.thrownAt} {cluster.topLocation}</span>}
    </div>
    <ul className='group-tests'>
      {tests.map(x => <li key={x.testId}>
        {statusIcon(x.outcome === 'flaky' ? 'flaky' : 'unexpected')}
        <a href={`#?testId=${encodeURIComponent(x.testId)}`}>{[...x.titlePath].join(' › ')}</a>
        <span className='muted'>{x.projectName} · <OpenInIdeButton file={x.file} line={x.line} compact /></span>
      </li>)}
    </ul>
    <div className='insight-actions'>
      <button className={clsx('button', panel === 'ai' && 'selected')} onClick={() => setPanel(p => p === 'ai' ? 'none' : 'ai')} data-testid='analyze-group'>{t.analyzeGroup}</button>
      <button className={clsx('button', panel === 'fix' && 'selected')} onClick={() => setPanel(p => p === 'fix' ? 'none' : 'fix')} data-testid='fix-group'>{t.fixGroup}</button>
      {cluster.ai && panel === 'none' && <span className='muted'>{t.fromCi}</span>}
    </div>
    {panel !== 'none' && <AgentPanel key={panel} test={tests[0]} data={data} report={report} initialAction={panel === 'fix' ? 'fix' : 'analyze'} group={{ cluster, tests }} />}
  </div>;
};

const InsightCard: React.FC<{ test: InsightTest, data: InsightsData, report: LoadedReport | undefined }> = ({ test, data, report }) => {
  const t = texts();
  const [panel, setPanel] = React.useState<'none' | 'compare' | 'ai' | 'fix'>('none');
  const c = test.classification;
  const kind = c?.kind ?? 'unknown';
  const projectNames = report?.json().projectNames ?? [];
  const toggle = (p: 'compare' | 'ai' | 'fix') => setPanel(current => current === p ? 'none' : p);
  const cluster = data.clusters?.find(x => x.id === test.clusterId);
  return <div className='insight-card' data-testid='insight-card'>
    <div className='insight-card-header'>
      {statusIcon(test.outcome === 'flaky' ? 'flaky' : 'unexpected')}
      <a className='insight-title' href={`#?testId=${encodeURIComponent(test.testId)}`}>{[...test.titlePath].join(' › ') || test.title}</a>
      {test.projectName && <Label label={test.projectName} colorIndex={Math.max(0, projectNames.indexOf(test.projectName)) % 6} />}
      <div style={{ flex: 'auto' }} />
      <span className={clsx('insights-kind', `kind-${kind}`)} title={`confidence: ${c?.confidence ?? 'low'}`} data-testid='insight-kind'>{kindLabel(kind)}</span>
    </div>
    <div className='insight-meta'>
      <OpenInIdeButton file={test.file} line={test.line} compact />
      {test.attempts > 1 && <span>{t.attempts(test.attempts)}</span>}
      {cluster && cluster.testIds.length > 1 && <a href={`#?tab=insights&group=${cluster.id}`}>{t.group} {cluster.id} · {t.tests(cluster.testIds.length)}</a>}
      {test.history && <HistoryBadge test={test} />}
    </div>
    {c && <div className='insight-reason'>{c.reason}</div>}
    {c && c.evidence.length > 0 && <ul className='insight-evidence'>{c.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>}

    {test.network.length > 0 && <div className='insight-section' data-testid='insight-network'>
      <div className='insight-section-title'>{t.failedNetwork}</div>
      <table className='insight-table'>
        <tbody>{test.network.map((n, i) => <NetworkRow key={i} test={test} request={n} />)}</tbody>
      </table>
    </div>}
    {test.console.length > 0 && <div className='insight-section' data-testid='insight-console'>
      <div className='insight-section-title'>{t.browserErrors}</div>
      {test.console.map((m, i) => <div key={i} className={clsx('insight-console', m.kind)}>
        <span className='insight-console-kind'>{m.kind === 'page-error' ? t.uncaught : m.kind === 'console-error' ? t.consoleError : t.warning}</span>
        <span className='mono'>{m.text.split('\n')[0]}</span>
      </div>)}
    </div>}

    {test.error && <details className='insight-error'>
      <summary>{t.error}</summary>
      <pre>{test.error}</pre>
    </details>}

    <div className='insight-actions'>
      {test.attempts > 1 && <button className={clsx('button', panel === 'compare' && 'selected')} onClick={() => toggle('compare')}>{t.compareAttempts}</button>}
      <button className={clsx('button', panel === 'ai' && 'selected')} onClick={() => toggle('ai')}>Ask AI</button>
      <FixMenu test={test} data={data} onAgentFix={() => setPanel('fix')} />
      <OpenInIdeButton file={test.file} line={test.line} />
      <a className='button' href={`#?testId=${encodeURIComponent(test.testId)}`}>{t.openTest}</a>
    </div>
    {panel === 'compare' && <AttemptsCompare testId={test.testId} report={report} />}
    {(panel === 'ai' || panel === 'fix') && <AgentPanel key={panel} test={test} data={data} report={report} initialAction={panel === 'fix' ? 'fix' : 'analyze'} />}
  </div>;
};

const NetworkRow: React.FC<{ test: InsightTest, request: NetworkIssue }> = ({ test, request: n }) => {
  const t = texts();
  return <>
    <tr>
      <td><span className={clsx('http-status', n.status >= 500 || !n.status ? 'http-5xx' : 'http-4xx')}>{n.status || 'ERR'}</span></td>
      <td className='mono'>{n.method}</td>
      <td className='mono insight-url' title={n.url}>{n.url}</td>
      <td className='muted'>{n.failure ?? n.statusText ?? ''}</td>
      <td className='muted'>{n.durationMs !== undefined ? msToString(n.durationMs) : ''}</td>
      <td className='network-actions'>
        {n.curl && <CopyButton label={t.copyCurl} text={n.curl} />}
        <CopyButton label={t.copyBugReport} text={backendBugReport(test, n)} />
      </td>
    </tr>
    {n.responseBody && <tr>
      <td></td>
      <td colSpan={5}>
        <details className='network-body'>
          <summary>{t.responseBody}</summary>
          <pre>{n.responseBody}</pre>
        </details>
      </td>
    </tr>}
  </>;
};

const HistoryBadge: React.FC<{ test: InsightTest }> = ({ test }) => {
  const t = texts();
  const h = test.history!;
  let label: string;
  if (h.isNewFailure)
    label = t.newFailure;
  else if (h.failingStreak > 1)
    label = t.failingRuns(h.failingStreak);
  else if (!h.failedRuns && h.runs.some(r => r.outcome === 'k'))
    label = t.flakyRuns(h.runs.filter(r => r.outcome === 'k').length, h.totalRuns);
  else
    label = t.failedRuns(h.failedRuns, h.totalRuns);
  return <span className='insight-history' data-testid='insight-history'>
    <HistoryDots outcomes={h.runs.map(r => r.outcome)} />
    <span className={clsx(h.isNewFailure && 'insight-new')}>{label}</span>
  </span>;
};

export const HistoryDots: React.FC<{ outcomes: HistoryOutcome[] }> = ({ outcomes }) => {
  const names: Record<HistoryOutcome, string> = { p: 'passed', f: 'failed', k: 'flaky', s: 'skipped' };
  return <span className='history-dots' aria-label={`history: ${outcomes.map(o => names[o]).join(', ')}`}>
    {outcomes.slice(-20).map((o, i) => <span key={i} className={clsx('history-dot', `history-${o}`)} title={names[o]} />)}
  </span>;
};

const HistorySection: React.FC<{ data: InsightsData, report: LoadedReport | undefined }> = ({ data, report }) => {
  const t = texts();
  const h = data.history!;
  const maxTotal = Math.max(1, ...h.runs.map(r => r.total));
  const allTests = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const file of report?.json().files ?? []) {
      for (const x of file.tests)
        map.set(x.testId, [...x.path, x.title].join(' › ') + (x.projectName ? ` [${x.projectName}]` : ''));
    }
    return map;
  }, [report]);
  return <>
    <AutoChip header={t.runHistory(h.runs.length)} dataTestId='insights-history'>
      <div className='run-bars'>
        {h.runs.map(r => {
          const failedPct = (r.failed / maxTotal) * 100;
          const flakyPct = (r.flaky / maxTotal) * 100;
          const bar = <div className='run-bar' title={`${r.runId} · ${new Date(r.startTime).toLocaleString()} · ${r.failed} failed, ${r.flaky} flaky / ${r.total}`}>
            <div className='run-bar-fill'>
              <div className='run-bar-failed' style={{ height: `${failedPct}%` }} />
              <div className='run-bar-flaky' style={{ height: `${flakyPct}%` }} />
            </div>
            <div className='run-bar-label'>{r.runId.length > 8 ? r.runId.slice(-5) : r.runId}</div>
          </div>;
          return r.url ? <a key={r.runId} href={r.url} target='_blank' rel='noreferrer'>{bar}</a> : <React.Fragment key={r.runId}>{bar}</React.Fragment>;
        })}
      </div>
      {h.runs.length < 2 && <div className='insights-note'>{t.firstRun}</div>}
    </AutoChip>

    {h.unstable.length > 0 && <AutoChip header={t.unstable(h.unstable.length)} dataTestId='insights-unstable'>
      <table className='insight-table'>
        <tbody>{h.unstable.map(u => <tr key={u.testId}>
          <td><a href={`#?testId=${encodeURIComponent(u.testId)}`}>{u.title}</a> <span className='muted'>{u.projectName}</span></td>
          <td><HistoryDots outcomes={u.runs} /></td>
          <td className='num'>{Math.round(u.instability * 100)}%</td>
        </tr>)}</tbody>
      </table>
    </AutoChip>}

    {h.regressions.length > 0 && <AutoChip header={t.regressions(h.regressions.length)} dataTestId='insights-regressions'>
      <table className='insight-table'>
        <thead><tr>{t.regressionHeaders.map((x, i) => <th key={i} className={i ? 'num' : undefined}>{x}</th>)}</tr></thead>
        <tbody>{h.regressions.map(r => <tr key={r.testId}>
          <td><a href={`#?testId=${encodeURIComponent(r.testId)}`}>{r.title}</a> <span className='muted'>{r.projectName}</span></td>
          <td className='num'>{msToString(r.durationMs)}</td>
          <td className='num'>{msToString(r.baselineMs)}</td>
          <td className='num'>×{(r.durationMs / Math.max(1, r.baselineMs)).toFixed(1)}</td>
        </tr>)}</tbody>
      </table>
    </AutoChip>}

    {h.fixedTestIds.length > 0 && <AutoChip header={t.fixedSince(h.fixedTestIds.length)} dataTestId='insights-fixed'>
      <ul className='insight-list'>{h.fixedTestIds.map(id => <li key={id}><a href={`#?testId=${encodeURIComponent(id)}`}>{allTests.get(id) ?? id}</a></li>)}</ul>
    </AutoChip>}
  </>;
};

