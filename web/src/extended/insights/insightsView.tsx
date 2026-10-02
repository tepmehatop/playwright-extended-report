import * as React from 'react';
import { clsx } from '@web/uiUtils';
import { msToString } from '@isomorphic/formatUtils';
import { AutoChip } from '../../chip';
import { Label } from '../../labels';
import { statusIcon } from '../../statusIcon';
import type { LoadedReport } from '../../loadedReport';
import type { FailureKind, HistoryOutcome, InsightsData, InsightTest } from '../../../../src/shared/insightsFormat';
import { AttemptsCompare } from './attemptsCompare';
import { AskAiPanel, FixMenu } from './actions';
import './insights.css';

export const kKindLabels: Record<FailureKind, string> = {
  'product-bug': 'Product bug',
  'test-bug': 'Test bug',
  'environment': 'Environment',
  'ui-change': 'UI change',
  'flaky': 'Flaky',
  'unknown': 'Unclassified',
};

const kKindOrder: FailureKind[] = ['product-bug', 'environment', 'test-bug', 'ui-change', 'flaky', 'unknown'];

export const InsightsView: React.FC<{ content: string, report: LoadedReport | undefined }> = ({ content, report }) => {
  const data = React.useMemo(() => {
    try {
      return JSON.parse(content) as InsightsData;
    } catch {
      return undefined;
    }
  }, [content]);
  const [kind, setKind] = React.useState<FailureKind | 'all' | 'new'>('all');
  if (!data)
    return <div className='insights-empty'>Insights data is corrupted.</div>;

  const counts = new Map<FailureKind, number>();
  for (const t of data.tests)
    counts.set(t.classification?.kind ?? 'unknown', (counts.get(t.classification?.kind ?? 'unknown') ?? 0) + 1);
  const newFailures = data.tests.filter(t => t.history?.isNewFailure).length;
  const visible = data.tests.filter(t => kind === 'all' || (kind === 'new' ? t.history?.isNewFailure : (t.classification?.kind ?? 'unknown') === kind));

  return <div className='insights' data-testid='insights'>
    <div className='insights-filters' role='toolbar' aria-label='Failure kinds'>
      <FilterButton active={kind === 'all'} onClick={() => setKind('all')} label='All failures' count={data.tests.length} />
      {kKindOrder.filter(k => counts.get(k)).map(k => <FilterButton key={k} active={kind === k} onClick={() => setKind(k)} label={kKindLabels[k]} count={counts.get(k)!} kind={k} />)}
      {!!data.history && <FilterButton active={kind === 'new'} onClick={() => setKind('new')} label='New in this run' count={newFailures} />}
    </div>

    {!data.tests.length && <div className='insights-empty'>No failed or flaky tests in this run.</div>}
    {visible.map(test => <InsightCard key={test.testId} test={test} data={data} report={report} />)}

    {data.history ? <HistorySection data={data} report={report} /> : <div className='insights-note'>
      Run history is disabled. Enable it with the <code>insights.history</code> reporter option and keep the history file between CI builds to see new / known failures, unstable tests and duration regressions.
    </div>}
  </div>;
};

const FilterButton: React.FC<{ active: boolean, onClick: () => void, label: string, count: number, kind?: FailureKind }> = ({ active, onClick, label, count, kind }) => {
  return <button className={clsx('insights-filter', active && 'active')} aria-pressed={active} onClick={onClick}>
    {kind && <span className={clsx('insights-kind-dot', `kind-${kind}`)} />}
    {label}<span className='counter'>{count}</span>
  </button>;
};

const InsightCard: React.FC<{ test: InsightTest, data: InsightsData, report: LoadedReport | undefined }> = ({ test, data, report }) => {
  const [panel, setPanel] = React.useState<'none' | 'compare' | 'ai'>('none');
  const c = test.classification;
  const kind = c?.kind ?? 'unknown';
  const projectNames = report?.json().projectNames ?? [];
  const toggle = (p: 'compare' | 'ai') => setPanel(current => current === p ? 'none' : p);
  return <div className='insight-card' data-testid='insight-card'>
    <div className='insight-card-header'>
      {statusIcon(test.outcome === 'flaky' ? 'flaky' : 'unexpected')}
      <a className='insight-title' href={`#?testId=${encodeURIComponent(test.testId)}`}>{[...test.titlePath].join(' › ') || test.title}</a>
      {test.projectName && <Label label={test.projectName} colorIndex={Math.max(0, projectNames.indexOf(test.projectName)) % 6} />}
      <div style={{ flex: 'auto' }} />
      <span className={clsx('insights-kind', `kind-${kind}`)} title={`confidence: ${c?.confidence ?? 'low'}`} data-testid='insight-kind'>{kKindLabels[kind]}</span>
    </div>
    <div className='insight-meta'>
      <span>{test.file}:{test.line}</span>
      {test.attempts > 1 && <span>{test.attempts} attempts</span>}
      {test.history && <HistoryBadge test={test} />}
    </div>
    {c && <div className='insight-reason'>{c.reason}</div>}
    {c && c.evidence.length > 0 && <ul className='insight-evidence'>{c.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>}

    {test.network.length > 0 && <div className='insight-section' data-testid='insight-network'>
      <div className='insight-section-title'>Failed network requests</div>
      <table className='insight-table'>
        <tbody>{test.network.map((n, i) => <tr key={i}>
          <td><span className={clsx('http-status', n.status >= 500 || !n.status ? 'http-5xx' : 'http-4xx')}>{n.status || 'ERR'}</span></td>
          <td className='mono'>{n.method}</td>
          <td className='mono insight-url' title={n.url}>{n.url}</td>
          <td className='muted'>{n.failure ?? n.statusText ?? ''}</td>
          <td className='muted'>{n.durationMs !== undefined ? msToString(n.durationMs) : ''}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {test.console.length > 0 && <div className='insight-section' data-testid='insight-console'>
      <div className='insight-section-title'>Browser errors</div>
      {test.console.map((m, i) => <div key={i} className={clsx('insight-console', m.kind)}>
        <span className='insight-console-kind'>{m.kind === 'page-error' ? 'uncaught' : m.kind === 'console-error' ? 'error' : 'warning'}</span>
        <span className='mono'>{m.text.split('\n')[0]}</span>
      </div>)}
    </div>}

    {test.error && <details className='insight-error'>
      <summary>Error</summary>
      <pre>{test.error}</pre>
    </details>}

    <div className='insight-actions'>
      {test.attempts > 1 && <button className={clsx('button', panel === 'compare' && 'selected')} onClick={() => toggle('compare')}>Compare attempts</button>}
      <button className={clsx('button', panel === 'ai' && 'selected')} onClick={() => toggle('ai')}>Ask AI</button>
      <FixMenu test={test} data={data} />
      <a className='button' href={`#?testId=${encodeURIComponent(test.testId)}`}>Open test</a>
    </div>
    {panel === 'compare' && <AttemptsCompare testId={test.testId} report={report} />}
    {panel === 'ai' && <AskAiPanel test={test} data={data} report={report} />}
  </div>;
};

const HistoryBadge: React.FC<{ test: InsightTest }> = ({ test }) => {
  const h = test.history!;
  let label: string;
  if (h.isNewFailure)
    label = 'NEW failure';
  else if (h.failingStreak > 1)
    label = `failing ${h.failingStreak} runs in a row`;
  else if (!h.failedRuns && h.runs.some(r => r.outcome === 'k'))
    label = `flaky in ${h.runs.filter(r => r.outcome === 'k').length}/${h.totalRuns} runs`;
  else
    label = `failed ${h.failedRuns}/${h.totalRuns} runs`;
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
  const h = data.history!;
  const maxTotal = Math.max(1, ...h.runs.map(r => r.total));
  const allTests = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const file of report?.json().files ?? []) {
      for (const t of file.tests)
        map.set(t.testId, [...t.path, t.title].join(' › ') + (t.projectName ? ` [${t.projectName}]` : ''));
    }
    return map;
  }, [report]);
  return <>
    <AutoChip header={`Run history (${h.runs.length} runs)`} dataTestId='insights-history'>
      <div className='run-bars'>
        {h.runs.map(r => {
          const failedPct = (r.failed / maxTotal) * 100;
          const flakyPct = (r.flaky / maxTotal) * 100;
          const bar = <div className='run-bar' title={`${r.runId} · ${new Date(r.startTime).toLocaleString()} · ${r.failed} failed, ${r.flaky} flaky of ${r.total}`}>
            <div className='run-bar-fill'>
              <div className='run-bar-failed' style={{ height: `${failedPct}%` }} />
              <div className='run-bar-flaky' style={{ height: `${flakyPct}%` }} />
            </div>
            <div className='run-bar-label'>{r.runId.length > 8 ? r.runId.slice(-5) : r.runId}</div>
          </div>;
          return r.url ? <a key={r.runId} href={r.url} target='_blank' rel='noreferrer'>{bar}</a> : <React.Fragment key={r.runId}>{bar}</React.Fragment>;
        })}
      </div>
      {h.runs.length < 2 && <div className='insights-note'>This is the first run with history. Trends, new / known failures and regressions appear from the next run on.</div>}
    </AutoChip>

    {h.unstable.length > 0 && <AutoChip header={`Unstable tests (${h.unstable.length})`} dataTestId='insights-unstable'>
      <table className='insight-table'>
        <tbody>{h.unstable.map(u => <tr key={u.testId}>
          <td><a href={`#?testId=${encodeURIComponent(u.testId)}`}>{u.title}</a> <span className='muted'>{u.projectName}</span></td>
          <td><HistoryDots outcomes={u.runs} /></td>
          <td className='num'>{Math.round(u.instability * 100)}%</td>
        </tr>)}</tbody>
      </table>
    </AutoChip>}

    {h.regressions.length > 0 && <AutoChip header={`Duration regressions (${h.regressions.length})`} dataTestId='insights-regressions'>
      <table className='insight-table'>
        <thead><tr><th>Test</th><th className='num'>Now</th><th className='num'>Usual (median)</th><th className='num'>Slower</th></tr></thead>
        <tbody>{h.regressions.map(r => <tr key={r.testId}>
          <td><a href={`#?testId=${encodeURIComponent(r.testId)}`}>{r.title}</a> <span className='muted'>{r.projectName}</span></td>
          <td className='num'>{msToString(r.durationMs)}</td>
          <td className='num'>{msToString(r.baselineMs)}</td>
          <td className='num'>×{(r.durationMs / Math.max(1, r.baselineMs)).toFixed(1)}</td>
        </tr>)}</tbody>
      </table>
    </AutoChip>}

    {h.fixedTestIds.length > 0 && <AutoChip header={`Fixed since previous run (${h.fixedTestIds.length})`} dataTestId='insights-fixed'>
      <ul className='insight-list'>{h.fixedTestIds.map(id => <li key={id}><a href={`#?testId=${encodeURIComponent(id)}`}>{allTests.get(id) ?? id}</a></li>)}</ul>
    </AutoChip>}
  </>;
};
