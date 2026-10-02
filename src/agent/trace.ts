/**
 * Deep reading of a Playwright trace.zip for the agent:
 *  - every API action with its locator, duration, error and call log,
 *  - the failing action,
 *  - test steps and their source stack (test.trace),
 *  - network / console / page errors,
 *  - the DOM of the page at the moment of failure (rebuilt from frame snapshots),
 *  - source files embedded into the trace (src/<sha1(path)>.<ext>).
 *
 * Only JSONL lines we understand are used; anything else is skipped, so a newer
 * trace format degrades to "less evidence", never to an error.
 */

import crypto from 'crypto';
import * as yauzl from 'yauzl';

import type { ConsoleIssue, NetworkIssue } from '../shared/insightsFormat';

export type TraceAction = {
  callId: string;
  title: string;
  method: string;
  /** Human readable locator, e.g. getByTestId('cart') */
  locator?: string;
  selector?: string;
  /** Short summary of other parameters (url, value, expected...). */
  params?: string;
  startTime: number;
  endTime?: number;
  error?: string;
  logs: string[];
  pageId?: string;
};

export type TraceStep = {
  stepId: string;
  title: string;
  parentId?: string;
  error?: string;
  /** file:line of the step in user code. */
  location?: string;
  stack: { file: string, line: number, column: number }[];
};

export type DomElement = {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  depth: number;
};

export type DomState = {
  url: string;
  /** Compact outline, one element per line. */
  outline: string;
  elements: DomElement[];
  isBlank: boolean;
  snapshotName: string;
};

export type TraceRequest = { method: string, url: string, status: number, durationMs?: number, failure?: string };

export type TraceData = {
  actions: TraceAction[];
  failingAction?: TraceAction;
  steps: TraceStep[];
  testErrors: string[];
  network: NetworkIssue[];
  requests: TraceRequest[];
  console: ConsoleIssue[];
  dom?: DomState;
  /** sha1(absolute path) -> source text */
  sources: Map<string, string>;
  /** Absolute paths seen in stacks, test file first. */
  sourcePaths: string[];
  pageUrls: string[];
};

const ansi = /\u001b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ansi, '');

export function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

export async function readTrace(zipPathOrBuffer: string | Buffer): Promise<TraceData> {
  const entries = await readZip(zipPathOrBuffer, name => /\.(trace|network)$/.test(name) || name.startsWith('src/'));
  const data: TraceData = { actions: [], steps: [], testErrors: [], network: [], requests: [], console: [], sources: new Map(), sourcePaths: [], pageUrls: [] };
  const actionsById = new Map<string, TraceAction>();
  const snapshotsByFrame = new Map<string, any[]>();
  const snapshotOrder: { frameId: string, index: number, snapshot: any }[] = [];
  const seenNet = new Set<string>();

  for (const [name, text] of entries) {
    if (name.startsWith('src/')) {
      data.sources.set(name.slice(4).replace(/\.[^.]+$/, ''), text);
      continue;
    }
    const isTestTrace = /(^|\/)test\.trace$/.test(name);
    for (const line of text.split('\n')) {
      if (!line)
        continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (isTestTrace) {
        readTestEvent(e, data);
        continue;
      }
      switch (e.type) {
        case 'before': {
          const action: TraceAction = {
            callId: e.callId,
            title: e.title || `${e.class}.${e.method}`,
            method: e.method,
            selector: e.params?.selector,
            locator: e.params?.selector ? selectorToLocator(e.params.selector) : undefined,
            params: summarizeParams(e.params),
            startTime: e.startTime,
            logs: [],
            pageId: e.pageId,
          };
          actionsById.set(e.callId, action);
          data.actions.push(action);
          break;
        }
        case 'after': {
          const action = actionsById.get(e.callId);
          if (action) {
            action.endTime = e.endTime;
            if (e.error)
              action.error = strip(e.error.message || String(e.error));
          }
          break;
        }
        case 'log': {
          const action = actionsById.get(e.callId);
          if (action && action.logs.length < 60)
            action.logs.push(strip(e.message).trim());
          break;
        }
        case 'frame-snapshot': {
          const s = e.snapshot;
          let list = snapshotsByFrame.get(s.frameId);
          if (!list) {
            list = [];
            snapshotsByFrame.set(s.frameId, list);
          }
          list.push(s);
          snapshotOrder.push({ frameId: s.frameId, index: list.length - 1, snapshot: s });
          if (s.isMainFrame && s.frameUrl && !data.pageUrls.includes(s.frameUrl))
            data.pageUrls.push(s.frameUrl);
          break;
        }
        case 'resource-snapshot': {
          const entry = e.snapshot;
          const url = String(entry?.request?.url ?? '');
          if (!url || url.startsWith('data:'))
            break;
          const status = Number(entry?.response?.status ?? 0);
          const request: TraceRequest = { method: entry?.request?.method ?? 'GET', url, status: status > 0 ? status : 0, durationMs: typeof entry?.time === 'number' ? Math.round(entry.time) : undefined, failure: entry?._failureText };
          data.requests.push(request);
          const key = `${request.method}|${url}|${status}`;
          if ((status >= 400 || request.failure) && !seenNet.has(key)) {
            seenNet.add(key);
            data.network.push({ method: request.method, url, status: request.status, statusText: entry?.response?.statusText || undefined, failure: request.failure, durationMs: request.durationMs });
          }
          break;
        }
        case 'console': {
          if ((e.messageType === 'error' || e.messageType === 'warning') && e.text)
            data.console.push({ kind: e.messageType === 'error' ? 'console-error' : 'console-warning', text: String(e.text).slice(0, 1000), location: e.location?.url });
          break;
        }
        case 'event': {
          if (e.method === 'pageError') {
            const error = e.params?.error?.error ?? e.params?.error;
            const text = error?.stack || error?.message || String(e.params?.error?.value ?? '');
            if (text)
              data.console.unshift({ kind: 'page-error', text: text.slice(0, 2000), location: e.params?.location?.url });
          }
          break;
        }
      }
    }
  }

  data.actions.sort((a, b) => a.startTime - b.startTime);
  data.failingAction = [...data.actions].reverse().find(a => a.error) ?? [...data.actions].reverse().find(a => a.endTime === undefined && a.method !== 'close');

  // DOM at failure: the "after" snapshot of the failing call, else the latest snapshot of the main frame.
  const failingCallId = data.failingAction?.callId;
  let target = failingCallId ? [...snapshotOrder].reverse().find(s => s.snapshot.callId === failingCallId && s.snapshot.isMainFrame) : undefined;
  if (!target)
    target = [...snapshotOrder].reverse().find(s => s.snapshot.isMainFrame);
  if (target) {
    try {
      data.dom = buildDom(snapshotsByFrame.get(target.frameId)!, target.index);
    } catch {
    }
  }
  return data;
}

function readTestEvent(e: any, data: TraceData) {
  if (e.type === 'before' && e.class === 'Test' && e.method === 'step' || (e.type === 'before' && e.stepId && e.class === 'Test' && e.method !== 'fixture' && e.method !== 'hook')) {
    const stack = (e.stack || []).filter((f: any) => f?.file && !String(f.file).includes('node_modules') && !String(f.file).startsWith('project#'));
    data.steps.push({
      stepId: e.stepId || e.callId,
      title: e.title || e.method,
      parentId: e.parentId,
      stack,
      location: stack[0] ? `${stack[0].file}:${stack[0].line}` : undefined,
    });
    for (const frame of stack) {
      if (!data.sourcePaths.includes(frame.file))
        data.sourcePaths.push(frame.file);
    }
  } else if (e.type === 'after' && e.error) {
    const step = data.steps.find(s => s.stepId === (e.stepId || e.callId));
    if (step)
      step.error = strip(e.error.message || String(e.error));
  } else if (e.type === 'error' && e.message) {
    data.testErrors.push(strip(e.message));
    for (const frame of e.stack || []) {
      if (frame?.file && !String(frame.file).includes('node_modules') && !data.sourcePaths.includes(frame.file))
        data.sourcePaths.unshift(frame.file);
    }
  }
}

function summarizeParams(params: any): string | undefined {
  if (!params)
    return undefined;
  const parts: string[] = [];
  for (const key of ['url', 'value', 'text', 'key', 'expression', 'files', 'timeout']) {
    if (params[key] !== undefined && params[key] !== '')
      parts.push(`${key}=${JSON.stringify(params[key]).slice(0, 120)}`);
  }
  if (params.expectedText)
    parts.push(`expected=${JSON.stringify(params.expectedText.map((t: any) => t.string ?? t.regexSource ?? '')).slice(0, 200)}`);
  if (params.expectedValue?.value?.s !== undefined)
    parts.push(`expected=${JSON.stringify(params.expectedValue.value.s).slice(0, 200)}`);
  if (params.isNot)
    parts.push('not');
  return parts.join(', ') || undefined;
}

/** Best-effort conversion of Playwright's internal selector engine syntax to user-facing locators. */
export function selectorToLocator(selector: string): string {
  return selector.split(' >> ').map(part => {
    let m = part.match(/^internal:testid=\[([\w-]+)="(.*)"[si]?\]$/);
    if (m)
      return m[1] === 'data-testid' ? `getByTestId('${m[2]}')` : `locator('[${m[1]}="${m[2]}"]')`;
    m = part.match(/^internal:role=(\w+)(?:\[name="(.*?)"([si])?\])?(.*)$/);
    if (m)
      return `getByRole('${m[1]}'${m[2] !== undefined ? `, { name: '${m[2]}'${m[3] === 's' ? ', exact: true' : ''} }` : ''})`;
    m = part.match(/^internal:(text|label|placeholder|alt|title)="(.*)"([si])?$/);
    if (m) {
      const fn = { text: 'getByText', label: 'getByLabel', placeholder: 'getByPlaceholder', alt: 'getByAltText', title: 'getByTitle' }[m[1]]!;
      return `${fn}('${m[2]}'${m[3] === 's' ? ', { exact: true }' : ''})`;
    }
    m = part.match(/^internal:has-text="(.*)"[si]?$/);
    if (m)
      return `filter({ hasText: '${m[1]}' })`;
    m = part.match(/^nth=(\d+)$/);
    if (m)
      return m[1] === '0' ? 'first()' : `nth(${m[1]})`;
    if (part.startsWith('internal:control=enter-frame'))
      return 'contentFrame()';
    return `locator('${part.replace(/^css=/, '')}')`;
  }).join('.');
}

// ---------- DOM reconstruction from frame snapshots ----------

type NodeSnapshot = string | any[];

const isElement = (n: NodeSnapshot): n is any[] => Array.isArray(n) && typeof n[0] === 'string';
const isReference = (n: NodeSnapshot): n is any[] => Array.isArray(n) && Array.isArray(n[0]);

/** Same post-order numbering Playwright's SnapshotRenderer uses for subtree references. */
function snapshotNodes(snapshot: any): NodeSnapshot[] {
  if (!snapshot.__nodes) {
    const nodes: NodeSnapshot[] = [];
    const visit = (n: NodeSnapshot) => {
      if (typeof n === 'string') {
        nodes.push(n);
      } else if (isElement(n)) {
        for (const child of n.slice(2))
          visit(child);
        nodes.push(n);
      }
    };
    visit(snapshot.html);
    snapshot.__nodes = nodes;
  }
  return snapshot.__nodes;
}

const kSkipTags = new Set(['HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG', 'PATH', 'path', 'META', 'LINK', 'BASE']);
const kKeptAttrs = ['id', 'data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy', 'name', 'type', 'role', 'aria-label', 'aria-labelledby', 'placeholder', 'title', 'alt', 'href', 'for', 'value', 'disabled', 'aria-disabled', 'aria-hidden', 'hidden', 'class'];
const kTextual = new Set(['A', 'BUTTON', 'LABEL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'SPAN', 'LI', 'TD', 'TH', 'OPTION', 'DIV', 'SECTION', 'STRONG', 'EM', 'B', 'SUMMARY', 'LEGEND', 'DT', 'DD']);

function buildDom(snapshots: any[], index: number): DomState {
  const elements: DomElement[] = [];
  const resolve = (n: NodeSnapshot, snapshotIndex: number): { node: NodeSnapshot, index: number } | undefined => {
    if (!isReference(n))
      return { node: n, index: snapshotIndex };
    const referenceIndex = snapshotIndex - n[0][0];
    if (referenceIndex < 0 || referenceIndex > snapshotIndex)
      return undefined;
    const nodes = snapshotNodes(snapshots[referenceIndex]);
    const node = nodes[n[0][1]];
    return node === undefined ? undefined : resolve(node, referenceIndex);
  };
  const textOf = (n: NodeSnapshot, snapshotIndex: number, budget = 200): string => {
    const r = resolve(n, snapshotIndex);
    if (!r)
      return '';
    if (typeof r.node === 'string')
      return r.node;
    if (!isElement(r.node) || kSkipTags.has(r.node[0]))
      return '';
    let text = '';
    for (const child of r.node.slice(2)) {
      text += ' ' + textOf(child, r.index, budget - text.length);
      if (text.length > budget)
        break;
    }
    return text;
  };
  const visit = (n: NodeSnapshot, snapshotIndex: number, depth: number) => {
    if (elements.length > 1500)
      return;
    const r = resolve(n, snapshotIndex);
    if (!r || !isElement(r.node))
      return;
    const [tag, rawAttrs, ...children] = r.node;
    if (kSkipTags.has(tag))
      return;
    const attrs: Record<string, string> = {};
    for (const key of kKeptAttrs) {
      const value = rawAttrs?.[key];
      if (value !== undefined && !String(key).startsWith('__playwright'))
        attrs[key] = key === 'class' ? String(value).split(/\s+/).slice(0, 3).join(' ') : String(value).slice(0, 120);
    }
    if (rawAttrs?.__playwright_value_ !== undefined)
      attrs.value = String(rawAttrs.__playwright_value_).slice(0, 80);
    const ownText = children.map((c: NodeSnapshot) => {
      const cr = resolve(c, r.index);
      return cr && typeof cr.node === 'string' ? cr.node : '';
    }).join(' ').replace(/\s+/g, ' ').trim();
    const text = kTextual.has(tag) || ownText ? (ownText || textOf(r.node, r.index)).replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    elements.push({ tag: tag.toLowerCase(), attrs, text, depth });
    for (const child of children)
      visit(child, r.index, depth + 1);
  };
  const snapshot = snapshots[index];
  visit(snapshot.html, index, 0);

  const body = elements.find(e => e.tag === 'body');
  const bodyChildren = body ? elements.filter(e => e.depth > body.depth) : [];
  const isBlank = !bodyChildren.some(e => e.text || Object.keys(e.attrs).length);
  return {
    url: snapshot.frameUrl,
    elements,
    outline: renderOutline(elements),
    isBlank,
    snapshotName: `${snapshot.phase || snapshot.snapshotName || ''}@${snapshot.callId || ''}`,
  };
}

function renderOutline(elements: DomElement[]): string {
  const lines: string[] = [];
  const interesting = (e: DomElement) => e.text || Object.keys(e.attrs).some(k => k !== 'class') || ['input', 'button', 'select', 'textarea', 'a', 'form', 'iframe', 'dialog', 'table'].includes(e.tag);
  for (const e of elements) {
    if (['html', 'body'].includes(e.tag) || !interesting(e))
      continue;
    const attrs = Object.entries(e.attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
    lines.push(`${'  '.repeat(Math.min(e.depth, 12))}<${e.tag}${attrs ? ' ' + attrs : ''}>${e.text ? ' ' + e.text : ''}`);
  }
  return lines.join('\n');
}

// ---------- zip ----------

function readZip(source: string | Buffer, filter: (name: string) => boolean): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, string>();
    const onZip = (error: Error | null, zip?: yauzl.ZipFile) => {
      if (error || !zip)
        return reject(error);
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!filter(entry.fileName) || entry.uncompressedSize > 80 * 1024 * 1024) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream)
            return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString('utf-8'));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    };
    if (typeof source === 'string')
      yauzl.open(source, { lazyEntries: true, autoClose: true }, onZip);
    else
      yauzl.fromBuffer(source, { lazyEntries: true }, onZip);
  });
}
