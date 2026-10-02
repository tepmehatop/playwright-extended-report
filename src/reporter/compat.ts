/**
 * Copyright (c) Microsoft Corporation.
 * Modifications copyright (c) playwright-extended-report contributors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Self-contained replacements for the Playwright-internal helpers used by the
 * upstream html reporter (`@utils/*`, `@isomorphic/*`, `./base`, `../util`).
 *
 * The upstream reporter imports them from Playwright's private modules, which
 * change between releases. Keeping our own copies means this package depends
 * only on the public Reporter API and does not break on Playwright upgrades.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { Location, TestCase, TestError, TestResult } from '@playwright/test/reporter';

export class MultiMap<K, V> {
  private _map = new Map<K, V[]>();

  set(key: K, value: V) {
    let values = this._map.get(key);
    if (!values) {
      values = [];
      this._map.set(key, values);
    }
    values.push(value);
  }

  get(key: K): V[] {
    return this._map.get(key) || [];
  }

  keys(): IterableIterator<K> {
    return this._map.keys();
  }
}

export function calculateSha1(buffer: Buffer | string): string {
  const hash = crypto.createHash('sha1');
  hash.update(buffer);
  return hash.digest('hex');
}

export function toPosixPath(aPath: string): string {
  return aPath.split(path.sep).join(path.posix.sep);
}

export function sanitizeForFilePath(s: string) {
  return s.replace(/[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-');
}

export async function removeFolders(dirs: string[]) {
  await Promise.all(dirs.map(dir => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10 }).catch(() => {})));
}

export async function copyFileAndMakeWritable(from: string, to: string) {
  await fs.promises.copyFile(from, to);
  await fs.promises.chmod(to, 0o664);
}

const ansiRegex = new RegExp('([\\u001B\\u009B][[\\]()#?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{0,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~])))', 'g');
export function stripAnsiEscapes(str: string): string {
  return str.replace(ansiRegex, '');
}

// The html report renders ANSI colors (via ansi2html), so we emit them the same way
// Playwright's `internalScreen` does.
const colors = {
  red: (s: string) => `\u001b[31m${s}\u001b[39m`,
  dim: (s: string) => `\u001b[2m${s}\u001b[22m`,
};

export function resolveReporterOutputPath(defaultValue: string, configDir: string, configValue: string | undefined) {
  if (configValue)
    return path.resolve(configDir, configValue);
  let dir = configDir;
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json')))
      return path.resolve(dir, defaultValue);
    const parent = path.dirname(dir);
    if (parent === dir)
      return path.resolve(process.cwd(), defaultValue);
    dir = parent;
  }
}

export type ErrorDetails = {
  message: string;
  location?: Location;
};

export function formatResultFailure(test: TestCase, result: TestResult, initialIndent: string): ErrorDetails[] {
  const errorDetails: ErrorDetails[] = [];

  if (result.status === 'passed' && test.expectedStatus === 'failed')
    errorDetails.push({ message: indent(colors.red(`Expected to fail, but passed.`), initialIndent) });
  if (result.status === 'interrupted')
    errorDetails.push({ message: indent(colors.red(`Test was interrupted.`), initialIndent) });

  for (const error of result.errors) {
    const formattedError = formatError(error);
    errorDetails.push({
      message: indent(formattedError.message, initialIndent),
      location: formattedError.location,
    });
  }
  return errorDetails;
}

export function formatError(error: TestError): ErrorDetails {
  const message = error.message || error.value || '';
  const stack = error.stack;
  if (!stack && !error.location)
    return { message };

  const tokens = [];
  const parsedStack = stack ? parseErrorStack(stack) : undefined;
  tokens.push(parsedStack?.message || message);

  if (error.snippet) {
    tokens.push('');
    tokens.push(error.snippet);
  }

  if (parsedStack && parsedStack.stackLines.length)
    tokens.push(colors.dim(parsedStack.stackLines.join('\n')));

  let location = error.location;
  if (parsedStack && !location)
    location = parsedStack.location;

  const cause = (error as { cause?: TestError }).cause;
  if (cause)
    tokens.push(colors.dim('[cause]: ') + formatError(cause).message);

  return {
    location,
    message: tokens.join('\n'),
  };
}

function parseErrorStack(stack: string): { message: string, stackLines: string[], location?: Location } {
  const lines = stack.split('\n');
  let firstStackLine = lines.findIndex(line => line.startsWith('    at '));
  if (firstStackLine === -1)
    firstStackLine = lines.length;
  const message = lines.slice(0, firstStackLine).join('\n');
  const stackLines = lines.slice(firstStackLine);
  let location: Location | undefined;
  for (const line of stackLines) {
    const frame = parseStackFrameLocation(line);
    if (!frame || frame.file.includes(`${path.sep}node_modules${path.sep}`))
      continue;
    location = frame;
    break;
  }
  return { message, stackLines, location };
}

function parseStackFrameLocation(line: string): Location | undefined {
  const match = line.match(/^\s*at (?:.*?\()?(.+?):(\d+):(\d+)\)?\s*$/);
  if (!match)
    return undefined;
  let file = match[1];
  if (file.startsWith('internal') || file.startsWith('node:'))
    return undefined;
  if (file.startsWith('file://'))
    file = fileURLToPath(file);
  return { file, line: +match[2], column: +match[3] };
}

function indent(lines: string, tab: string) {
  return lines.replace(/^(?=.+$)/gm, tab);
}

const kExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/xml': 'xml',
  'text/xml': 'xml',
};

export function extensionForContentType(contentType: string): string | undefined {
  return kExtensions[contentType.split(';')[0].trim().toLowerCase()];
}
