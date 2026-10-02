/**
 * Read / write the extra tabs stored inside a generated report's index.html.
 * Used by the reporter (at generation time) and by the CLI (after the run,
 * e.g. when the Jenkins log-analysis skill has produced its Markdown).
 */

import fs from 'fs';
import path from 'path';

import { kTabsTemplateClose, kTabsTemplateOpen, sortTabs, validateTab } from './shared/tabsFormat';

import type { ExtendedTab, ExtendedTabBadgeKind, ExtendedTabFormat, ExtendedTabIcon, ExtendedTabsPayload } from './shared/tabsFormat';

export type { ExtendedTab, ExtendedTabBadgeKind, ExtendedTabFormat, ExtendedTabIcon, ExtendedTabsPayload } from './shared/tabsFormat';

/** A tab whose content comes from a file (Markdown, HTML, or a folder for iframe tabs). */
export type ExtendedTabInput = Omit<ExtendedTab, 'content' | 'format'> & {
  format?: ExtendedTabFormat;
  /** Inline content. Either `content` or `file` is required. */
  content?: string;
  /** Path to .md / .html file, or to a folder with index.html (iframe tab). */
  file?: string;
  /** For `file`: do not fail when the file does not exist, just skip the tab. Default: false. */
  optional?: boolean;
};

const kReportMarker = 'playwrightReportBase64';

export function encodeTabs(tabs: ExtendedTab[]): string {
  const payload: ExtendedTabsPayload = { version: 1, tabs };
  return kTabsTemplateOpen + Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64') + kTabsTemplateClose;
}

function indexFile(reportDir: string): string {
  const file = path.join(reportDir, 'index.html');
  if (!fs.existsSync(file))
    throw new Error(`No report found: ${file} does not exist`);
  return file;
}

/** Returns the byte offset of our template inside index.html, or -1. */
function findTabsTemplate(buffer: Buffer): { start: number, end: number } | undefined {
  const start = buffer.lastIndexOf(kTabsTemplateOpen);
  if (start === -1)
    return undefined;
  const close = buffer.indexOf(kTabsTemplateClose, start);
  if (close === -1)
    return undefined;
  return { start, end: close + kTabsTemplateClose.length };
}

export async function readTabs(reportDir: string): Promise<ExtendedTab[]> {
  const buffer = await fs.promises.readFile(indexFile(reportDir));
  const range = findTabsTemplate(buffer);
  if (!range)
    return [];
  const base64 = buffer.subarray(range.start + kTabsTemplateOpen.length, range.end - kTabsTemplateClose.length).toString('utf-8');
  const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8')) as ExtendedTabsPayload;
  return payload.tabs || [];
}

/**
 * Replaces all tabs. The template is always the last thing in the file, so we
 * truncate and append instead of rewriting the (possibly large) report.
 */
export async function writeTabs(reportDir: string, tabs: ExtendedTab[]): Promise<void> {
  for (const tab of tabs) {
    const error = validateTab(tab);
    if (error)
      throw new Error(error);
  }
  const file = indexFile(reportDir);
  const buffer = await fs.promises.readFile(file);
  if (buffer.indexOf(kReportMarker) === -1)
    throw new Error(`${file} is not a Playwright HTML report`);
  const range = findTabsTemplate(buffer);
  if (range && buffer.length - range.end > 16)
    throw new Error(`Unexpected content after the tabs block in ${file}`);
  if (range)
    await fs.promises.truncate(file, range.start);
  await fs.promises.appendFile(file, encodeTabs(sortTabs(tabs)));
}

/** Adds a tab or replaces the tab with the same id. */
export async function upsertTab(reportDir: string, input: ExtendedTabInput): Promise<ExtendedTab | undefined> {
  const tab = await resolveTabInput(reportDir, input);
  if (!tab)
    return undefined;
  const tabs = (await readTabs(reportDir)).filter(t => t.id !== tab.id);
  tabs.push(tab);
  await writeTabs(reportDir, tabs);
  return tab;
}

export async function removeTab(reportDir: string, id: string): Promise<boolean> {
  const tabs = await readTabs(reportDir);
  const filtered = tabs.filter(t => t.id !== id);
  if (filtered.length === tabs.length)
    return false;
  await writeTabs(reportDir, filtered);
  await fs.promises.rm(path.join(reportDir, 'tabs', id), { recursive: true, force: true });
  return true;
}

/**
 * Turns a tab description into a stored tab. For iframe tabs the file/folder is
 * copied into `<report>/tabs/<id>/` so that the report folder stays self-contained.
 */
export async function resolveTabInput(reportDir: string, input: ExtendedTabInput): Promise<ExtendedTab | undefined> {
  const { file, optional, content, format, ...rest } = input;
  if (content !== undefined)
    return { ...rest, format: format ?? 'markdown', content };
  if (!file)
    throw new Error(`tab "${input.id}": either "content" or "file" is required`);

  const stat = await fs.promises.stat(file).catch(() => undefined);
  if (!stat) {
    if (optional)
      return undefined;
    throw new Error(`tab "${input.id}": file not found: ${file}`);
  }

  const resolvedFormat: ExtendedTabFormat = format ?? (stat.isDirectory() ? 'iframe' : formatFromExtension(file));
  if (resolvedFormat === 'iframe') {
    const targetDir = path.join(reportDir, 'tabs', input.id);
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    await fs.promises.mkdir(targetDir, { recursive: true });
    if (stat.isDirectory()) {
      await fs.promises.cp(file, targetDir, { recursive: true });
      if (!fs.existsSync(path.join(targetDir, 'index.html')))
        throw new Error(`tab "${input.id}": folder ${file} has no index.html`);
      return { ...rest, format: 'iframe', content: `tabs/${input.id}/index.html` };
    }
    const name = path.basename(file);
    await fs.promises.copyFile(file, path.join(targetDir, name));
    return { ...rest, format: 'iframe', content: `tabs/${input.id}/${encodeURIComponent(name)}` };
  }
  if (stat.isDirectory())
    throw new Error(`tab "${input.id}": ${file} is a folder; use format "iframe"`);
  return {
    source: path.basename(file),
    ...rest,
    format: resolvedFormat,
    content: await fs.promises.readFile(file, 'utf-8'),
  };
}

function formatFromExtension(file: string): ExtendedTabFormat {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm')
    return 'html';
  return 'markdown';
}

export function isValidTabIcon(icon: string): icon is ExtendedTabIcon {
  return ['sparkle', 'bug', 'graph', 'note', 'list', 'none'].includes(icon);
}

export function isValidBadgeKind(kind: string): kind is ExtendedTabBadgeKind {
  return ['default', 'danger', 'attention', 'success'].includes(kind);
}
