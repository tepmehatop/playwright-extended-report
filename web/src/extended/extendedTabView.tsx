import * as React from 'react';
import { clsx } from '@web/uiUtils';
import { AutoChip } from '../chip';
import { HeaderView } from '../headerView';
import { Link, navigate, useSearchParams } from '../links';
import type { LoadedReport } from '../loadedReport';
import type { TestCaseSummary } from '../types';
import { extendedTabs, findExtendedTab, type ExtendedTab } from './extendedTabs';
import { sortSections } from '../../../src/shared/tabsFormat';
import { tabIcon } from './icons';
import { renderMarkdown, sanitizeHtml, slugify } from './markdown';
import { InsightsView } from './insights/insightsView';
import './extendedTabs.css';

export const kTabParam = 'tab';

/** Navigation items rendered next to "All / Passed / Failed / Flaky / Skipped". */
export const ExtendedTabsNav: React.FC = () => {
  const selected = useSearchParams().get(kTabParam);
  return <>
    {extendedTabs().map(tab => <Link
      key={tab.id}
      className='subnav-item'
      href={`#?${kTabParam}=${encodeURIComponent(tab.id)}`}
      title={tab.description || tab.title}
      // Link's prop types do not declare aria-* but forward them.
      {...{ 'aria-selected': selected === tab.id, 'data-testid': `extended-tab-nav-${tab.id}` }}>
      {tabIcon(tab.icon)}
      <span className='subnav-item-label'>{tab.title}</span>
      {tab.badge !== undefined && tab.badge !== '' && <span className={clsx('d-inline counter', tab.badgeKind && `extended-badge-${tab.badgeKind}`)}>{tab.badge}</span>}
    </Link>)}
  </>;
};

export const ExtendedTabView: React.FC<{
  tabId: string | null,
  report: LoadedReport | undefined,
}> = ({ tabId, report }) => {
  const tab = findExtendedTab(tabId);
  if (!tab) {
    return <div className='extended-tab'>
      <HeaderView title='Tab not found' />
      <div className='extended-tab-meta'>Tab id: {tabId}</div>
    </div>;
  }
  return <div className='extended-tab' data-testid={`extended-tab-${tab.id}`}>
    <AutoChip header={<span className='extended-tab-header'>{tabIcon(tab.icon)}{tab.title}</span>} dataTestId='extended-tab-chip'>
      <TabContent tab={tab} report={report} />
    </AutoChip>
  </div>;
};

type Exportable = { id: string, title: string, format: string, content: string, description?: string, generatedAt?: string, source?: string };

const TabToolbar: React.FC<{ item: Exportable, compact?: boolean }> = ({ item, compact }) => {
  const [copied, setCopied] = React.useState(false);
  const canExport = item.format === 'markdown' || item.format === 'html';
  const meta = [
    item.generatedAt && `Generated: ${formatDate(item.generatedAt)}`,
    item.source && `Source: ${item.source}`,
  ].filter(Boolean).join(' · ');
  if (!item.description && !meta && !canExport)
    return null;
  return <div className={clsx('extended-tab-toolbar', compact && 'compact')}>
    <div className='extended-tab-meta'>
      {item.description && <div className='extended-tab-description'>{item.description}</div>}
      {meta && <div>{meta}</div>}
    </div>
    <div style={{ flex: 'auto' }}></div>
    {canExport && <>
      <button className='button' onClick={async () => {
        await navigator.clipboard.writeText(item.content);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      }}>{copied ? 'Copied' : item.format === 'markdown' ? 'Copy Markdown' : 'Copy HTML'}</button>
      <button className='button' onClick={() => download(item)}>Download</button>
    </>}
  </div>;
};

const TabContent: React.FC<{ tab: ExtendedTab, report: LoadedReport | undefined }> = ({ tab, report }) => {
  if (tab.format === 'insights')
    return <><TabToolbar item={tab} /><InsightsView content={tab.content} report={report} /></>;
  if (tab.format === 'iframe') {
    return <iframe
      className='extended-tab-iframe'
      src={tab.content}
      title={tab.title}
      sandbox='allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads' />;
  }
  const sectionIds = new Set((tab.sections || []).map(s => s.id));
  const blocks = sortSections([
    ...(tab.sections || []),
    ...(tab.placeholders || []).filter(p => !sectionIds.has(p.sectionId)).map(p => ({ id: p.sectionId, title: p.title, order: p.order, format: 'markdown' as const, content: p.markdown, placeholder: true })),
  ]);
  const whole = [tab.content, ...(tab.sections || []).map(s => `## ${s.title}\n\n${s.content}`)].join('\n\n');
  return <>
    <TabToolbar item={{ ...tab, content: whole }} />
    {!!tab.content && <RichContent format={tab.format} content={tab.content} report={report} />}
    {blocks.map(section => <div key={section.id} className='extended-section' data-testid={`extended-section-${section.id}`}>
      <AutoChip header={section.title}>
        {'placeholder' in section
          ? <div className='extended-section-placeholder'><RichContent format='markdown' content={section.content} report={report} /></div>
          : <>
            <TabToolbar item={section} compact />
            <RichContent format={section.format} content={section.content} report={report} />
          </>}
      </AutoChip>
    </div>)}
  </>;
};

/** Sanitized Markdown / HTML with in-report links (#?testId, #?test=, #?q=, #anchor). */
const RichContent: React.FC<{ format: string, content: string, report: LoadedReport | undefined }> = ({ format, content, report }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const searchParams = useSearchParams();
  const html = React.useMemo(() => format === 'html' ? sanitizeHtml(content) : renderMarkdown(content), [format, content]);

  // Give headings ids so that `[see](#heading)` links and the browser's find work.
  React.useEffect(() => {
    const used = new Set<string>();
    for (const heading of ref.current?.querySelectorAll('h1, h2, h3, h4, h5, h6') || []) {
      if (heading.id)
        continue;
      let id = slugify(heading.textContent || '') || 'section';
      for (let i = 1; used.has(id); i++)
        id = `${slugify(heading.textContent || '')}-${i}`;
      used.add(id);
      heading.id = id;
    }
  }, [html]);

  const onClick = React.useCallback((event: React.MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href');
    if (!href || !href.startsWith('#'))
      return;
    event.preventDefault();
    if (href.startsWith('#?')) {
      const params = new URLSearchParams(href.slice(2));
      const testTitle = params.get('test');
      if (testTitle !== null)
        navigate(resolveTestHref(testTitle, params.get('project'), report, searchParams));
      else
        navigate(href);
      return;
    }
    const target = ref.current?.querySelector('#' + CSS.escape(decodeURIComponent(href.slice(1))));
    target?.scrollIntoView({ block: 'start' });
  }, [report, searchParams]);

  return <div ref={ref} className='markdown-body' onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
};

/**
 * Resolves `[text](#?test=<title>)` links written by tools that only know test
 * titles (e.g. a Jenkins log parser) to the matching test in this report.
 * Falls back to a text search when nothing matches exactly.
 */
function resolveTestHref(title: string, project: string | null, report: LoadedReport | undefined, current: URLSearchParams): string {
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = normalize(title.replace(/\s+>\s+/g, ' › '));
  let tests: TestCaseSummary[] = (report?.json().files || []).flatMap(f => f.tests);
  if (project)
    tests = tests.filter(t => t.projectName === project);
  const fullTitle = (t: TestCaseSummary) => normalize([...t.path, t.title].join(' › '));
  const candidates = [
    tests.filter(t => fullTitle(t) === wanted),
    tests.filter(t => normalize(t.title) === wanted),
    tests.filter(t => fullTitle(t).endsWith(wanted)),
    tests.filter(t => fullTitle(t).includes(wanted)),
  ].find(list => list.length) || [];
  // Prefer the failed run when the same test ran in several projects.
  const test = candidates.find(t => !t.ok) || candidates[0];
  if (test) {
    const params = new URLSearchParams();
    params.set('testId', test.testId);
    return '#?' + params.toString();
  }
  const params = new URLSearchParams(current);
  params.delete(kTabParam);
  params.delete('testId');
  params.set('q', `"${title.replace(/"/g, '')}"`);
  return '#?' + params.toString();
}

function download(tab: Exportable) {
  const extension = tab.format === 'markdown' ? 'md' : 'html';
  const blob = new Blob([tab.content], { type: tab.format === 'markdown' ? 'text/markdown' : 'text/html' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${tab.id}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return isNaN(date.getTime()) ? value : date.toLocaleString();
}
