/**
 * Extracts failed network requests and browser errors from a Playwright trace.zip.
 *
 * Trace layout (stable for years): <n>-trace.network holds HAR entries as
 * `{"type":"resource-snapshot","snapshot":{request,response,...}}` lines,
 * <n>-trace.trace holds `{"type":"console",...}` and
 * `{"type":"event","method":"pageError",...}` lines. Unknown lines are ignored,
 * so a format change degrades to "no data" instead of an error.
 */

import * as yauzl from 'yauzl';

import type { ConsoleIssue, NetworkIssue } from '../shared/insightsFormat';

export type TraceIssues = { network: NetworkIssue[], console: ConsoleIssue[] };

const kMaxEntryBytes = 50 * 1024 * 1024;
const kMaxItems = 20;
// Noise that is never the cause of a failure.
const kIgnoredUrl = /\/favicon\.ico(\?|$)/;

export async function readTraceIssues(traceZipPath: string): Promise<TraceIssues> {
  const result: TraceIssues = { network: [], console: [] };
  const files = await readZipTextEntries(traceZipPath, name => /(^|\/)[^/]*\.(network|trace)$/.test(name));
  const seen = new Set<string>();
  for (const [name, text] of files) {
    for (const line of text.split('\n')) {
      if (!line || (!line.includes('"resource-snapshot"') && !line.includes('"console"') && !line.includes('pageError')))
        continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (name.endsWith('.network') && event.type === 'resource-snapshot')
        addNetwork(result, event.snapshot, seen);
      else if (event.type === 'console')
        addConsole(result, event.messageType, event.text, event.location?.url, seen);
      else if (event.type === 'event' && event.method === 'console')
        addConsole(result, event.params?.message?.type, event.params?.message?.text, event.params?.message?.location?.url, seen);
      else if (event.type === 'event' && event.method === 'pageError')
        addPageError(result, event.params, seen);
    }
  }
  result.network = result.network.slice(0, kMaxItems);
  result.console = result.console.slice(0, kMaxItems);
  return result;
}

function addNetwork(result: TraceIssues, entry: any, seen: Set<string>) {
  const status = Number(entry?.response?.status ?? 0);
  const failure = entry?._failureText as string | undefined;
  const url = String(entry?.request?.url ?? '');
  if (!url || kIgnoredUrl.test(url) || url.startsWith('data:'))
    return;
  // status -1 / 0 without failure text means "no response recorded" (e.g. aborted by route), skip.
  if (!(status >= 400 || failure))
    return;
  const method = String(entry?.request?.method ?? 'GET');
  const key = `net|${method}|${url}|${status}`;
  if (seen.has(key))
    return;
  seen.add(key);
  result.network.push({
    method,
    url,
    status: status > 0 ? status : 0,
    statusText: entry?.response?.statusText || undefined,
    failure,
    durationMs: typeof entry?.time === 'number' ? Math.round(entry.time) : undefined,
  });
}

function addConsole(result: TraceIssues, type: string | undefined, text: string | undefined, url: string | undefined, seen: Set<string>) {
  if (type !== 'error' && type !== 'warning')
    return;
  if (!text)
    return;
  const key = `console|${type}|${text}`;
  if (seen.has(key))
    return;
  seen.add(key);
  result.console.push({ kind: type === 'error' ? 'console-error' : 'console-warning', text: text.slice(0, 1000), location: url || undefined });
}

function addPageError(result: TraceIssues, params: any, seen: Set<string>) {
  const error = params?.error?.error ?? params?.error;
  const text = error?.stack || (error?.name ? `${error.name}: ${error.message}` : error?.message) || String(params?.error?.value ?? '');
  if (!text)
    return;
  const key = `pageerror|${text}`;
  if (seen.has(key))
    return;
  seen.add(key);
  const location = params?.location?.url ? `${params.location.url}:${(params.location.line ?? 0) + 1}` : undefined;
  result.console.unshift({ kind: 'page-error', text: text.slice(0, 2000), location });
}

function readZipTextEntries(zipPath: string, filter: (name: string) => boolean): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, string>();
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip)
        return reject(error);
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!filter(entry.fileName) || entry.uncompressedSize > kMaxEntryBytes) {
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
    });
  });
}
