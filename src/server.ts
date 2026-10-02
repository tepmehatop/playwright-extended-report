/**
 * Minimal static server for viewing a report locally (`pw-extended-report show`).
 * `npx playwright show-report <folder>` works for the same folder as well.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';

import { handleAiRequest } from './aiGateway';

import type { AiOptions } from './aiGateway';

const kMimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

export type ShowReportOptions = {
  host?: string;
  port?: number;
  testId?: string;
  /** Open a browser. Default: true. */
  open?: boolean;
  /** Serve /api/ai/* for the "Ask AI" button. */
  ai?: AiOptions;
};

export type ReportServer = { url: string, close: () => Promise<void> };

/** Serves the report folder over HTTP. Needed for features that `fetch()` attachments (e.g. "Copy prompt"). */
export async function startReportServer(reportFolder: string, options: { host?: string, port?: number, ai?: AiOptions } = {}): Promise<ReportServer> {
  const folder = path.resolve(reportFolder);
  if (!fs.existsSync(path.join(folder, 'index.html')))
    throw new Error(`No report found at "${folder}"`);

  const server = http.createServer((request, response) => {
    if (options.ai && handleAiRequest(options.ai, request, response, false))
      return;
    const url = new URL(request.url || '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/'))
      pathname += 'index.html';
    const file = path.join(folder, pathname);
    if (!file.startsWith(folder + path.sep)) {
      response.statusCode = 403;
      response.end();
      return;
    }
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) {
        response.statusCode = 404;
        response.end('Not found');
        return;
      }
      response.setHeader('Content-Type', kMimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream');
      response.setHeader('Content-Length', stat.size);
      // The trace viewer registers a service worker scoped to /trace/.
      if (pathname.endsWith('/sw.bundle.js'))
        response.setHeader('Service-Worker-Allowed', '/');
      fs.createReadStream(file).pipe(response);
    });
  });

  const host = options.host || 'localhost';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 9324, host, () => resolve());
  }).catch(async e => {
    if (options.port || e.code !== 'EADDRINUSE')
      throw e;
    // Default port is busy: pick any free one.
    await new Promise<void>(resolve => server.listen(0, host, () => resolve()));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** Serves the report and keeps the process alive until Ctrl+C. */
export async function showReport(reportFolder: string, options: ShowReportOptions = {}): Promise<never> {
  const server = await startReportServer(reportFolder, options);
  let url = server.url;
  if (options.testId)
    url += `#?testId=${options.testId}`;
  process.stdout.write(`\n  Serving extended report at ${url}. Press Ctrl+C to quit.\n`);
  if (options.ai)
    process.stdout.write(`  "Ask AI" is enabled: ${options.ai.mode === 'mock' ? 'mock answers' : `${options.ai.model} via ${options.ai.baseUrl}`}.\n`);
  if (options.open !== false)
    openInBrowser(url);
  return await new Promise<never>(() => {});
}

function openInBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
  }
}

/** Standalone "Ask AI" backend with CORS, for reports hosted elsewhere (e.g. Jenkins). */
export async function startAiGateway(ai: AiOptions, options: { host?: string, port?: number } = {}): Promise<ReportServer> {
  const server = http.createServer((request, response) => {
    if (!handleAiRequest(ai, request, response, true)) {
      response.statusCode = 404;
      response.end('Not found');
    }
  });
  const host = options.host || '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8787, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/api/ai/ask`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
