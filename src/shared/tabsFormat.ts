/**
 * Data format of the extra report tabs.
 *
 * Shared by the Node side (reporter + CLI, which write the data into index.html)
 * and the web UI (which reads and renders it). Keep it dependency-free.
 *
 * Tabs are stored at the very end of index.html as
 *   <template id="extendedReportTabs">BASE64(UTF-8 JSON of ExtendedTabsPayload)</template>
 * Being last in the file lets the CLI replace them without re-reading the
 * (potentially large) report data that precedes them.
 */

export type ExtendedTabFormat =
  /** `content` is Markdown (GFM). Rendered and sanitized in the report. */
  | 'markdown'
  /** `content` is an HTML fragment. Sanitized: scripts and event handlers are removed. */
  | 'html'
  /** `content` is a URL (usually relative to the report folder, e.g. `tabs/ai/index.html`) shown in an iframe. Use for pages that need their own JS. */
  | 'iframe'
  /** Built-in: `content` is JSON of InsightsData (see insightsFormat.ts), rendered by the Insights view. */
  | 'insights';

export type ExtendedTabIcon = 'sparkle' | 'bug' | 'graph' | 'note' | 'list' | 'none';

export type ExtendedTabBadgeKind = 'default' | 'danger' | 'attention' | 'success';

/** A titled block inside a tab, e.g. the skill's analysis inside "Failure analysis". */
export type ExtendedTabSection = {
  /** Unique within the tab. */
  id: string;
  title: string;
  format: 'markdown' | 'html';
  content: string;
  /** Sections are sorted by `order`, then by insertion. */
  order?: number;
  description?: string;
  generatedAt?: string;
  source?: string;
};

export type ExtendedTab = {
  /** Stable id, used in the URL: `#?tab=<id>`. Letters, digits, `-` and `_`. */
  id: string;
  /** Label shown in the top navigation bar. */
  title: string;
  format: ExtendedTabFormat;
  content: string;
  icon?: ExtendedTabIcon;
  /** Small counter next to the title, e.g. number of failure groups. */
  badge?: string | number;
  badgeKind?: ExtendedTabBadgeKind;
  /** Tabs are sorted by `order`, then by insertion. */
  order?: number;
  /** Shown as a subtitle above the content. */
  description?: string;
  /** ISO date. */
  generatedAt?: string;
  /** Free-form origin, e.g. "jenkins-log-skill" or a file name. */
  source?: string;
  /** Extra blocks rendered after `content` (markdown / html tabs only). */
  sections?: ExtendedTabSection[];
  /** Shown when the tab has no section with this id yet, e.g. how to add the skill analysis. */
  placeholders?: { sectionId: string, title: string, order?: number, markdown: string }[];
};

export type ExtendedTabsPayload = {
  version: 1;
  tabs: ExtendedTab[];
};

export const kTabsTemplateId = 'extendedReportTabs';
export const kTabsTemplateOpen = `<template id="${kTabsTemplateId}">`;
export const kTabsTemplateClose = '</template>';

const kTabIdRegex = /^[A-Za-z0-9_-]+$/;

export function validateTab(tab: ExtendedTab): string | undefined {
  if (!tab || typeof tab !== 'object')
    return 'tab must be an object';
  if (typeof tab.id !== 'string' || !kTabIdRegex.test(tab.id))
    return `invalid tab id "${tab.id}": use letters, digits, "-" and "_"`;
  if (typeof tab.title !== 'string' || !tab.title)
    return `tab "${tab.id}": title is required`;
  if (!['markdown', 'html', 'iframe', 'insights'].includes(tab.format))
    return `tab "${tab.id}": format must be one of markdown, html, iframe, insights`;
  if (typeof tab.content !== 'string')
    return `tab "${tab.id}": content must be a string`;
  for (const section of tab.sections || []) {
    if (typeof section.id !== 'string' || !kTabIdRegex.test(section.id))
      return `tab "${tab.id}": invalid section id "${section.id}"`;
    if (!['markdown', 'html'].includes(section.format) || typeof section.content !== 'string')
      return `tab "${tab.id}": section "${section.id}" must have markdown or html content`;
  }
  return undefined;
}

export function sortSections(sections: ExtendedTabSection[]): ExtendedTabSection[] {
  return sections
      .map((section, index) => ({ section, index }))
      .sort((a, b) => (a.section.order ?? 0) - (b.section.order ?? 0) || a.index - b.index)
      .map(e => e.section);
}

export function sortTabs(tabs: ExtendedTab[]): ExtendedTab[] {
  return tabs
      .map((tab, index) => ({ tab, index }))
      .sort((a, b) => (a.tab.order ?? 0) - (b.tab.order ?? 0) || a.index - b.index)
      .map(e => e.tab);
}
