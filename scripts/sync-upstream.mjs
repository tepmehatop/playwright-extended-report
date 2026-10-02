#!/usr/bin/env node
/**
 * Copies the HTML report UI sources from a Playwright checkout into this repo.
 *
 * Usage:
 *   node scripts/sync-upstream.mjs /path/to/playwright            # copy files
 *   node scripts/sync-upstream.mjs /path/to/playwright --dry-run  # only list what would change
 *
 * What is copied:
 *   packages/html-reporter/src/*            -> web/src/                  (UI, patched by us in a few places)
 *   packages/html-reporter/index.html       -> web/index.html
 *   transitive @web/* and @isomorphic/*     -> web/vendor/web, web/vendor/isomorphic
 *   packages/playwright/src/isomorphic/types.d.ts -> web/vendor/testIsomorphic/types.d.ts
 *   packages/playwright/src/reporters/html.ts     -> upstream/html.ts     (reference only, not compiled)
 *
 * Files we patched carry "[extended-report]" markers. Run this script on the
 * `upstream` branch and merge it into `main` — see docs/UPSTREAM_SYNC.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const pwRoot = args.find(a => !a.startsWith('--'));
if (!pwRoot) {
  console.error('Usage: node scripts/sync-upstream.mjs <path-to-playwright-checkout> [--dry-run]');
  process.exit(1);
}
const packages = path.resolve(pwRoot, 'packages');
const reporterSrc = path.join(packages, 'html-reporter', 'src');
if (!fs.existsSync(reporterSrc)) {
  console.error(`Not a Playwright checkout: ${reporterSrc} does not exist`);
  process.exit(1);
}

const aliases = {
  '@web': path.join(packages, 'web', 'src'),
  '@isomorphic': path.join(packages, 'isomorphic'),
};

const isUpstreamUiFile = name => /\.(tsx?|css)$/.test(name) && !/\.(spec|story)\.tsx?$/.test(name) && name !== 'sampleReport.ts';

// Compute the transitive closure of @web/* and @isomorphic/* imports.
const visited = new Set();
function resolveImport(from, spec) {
  let candidate;
  for (const [alias, target] of Object.entries(aliases)) {
    if (spec === alias || spec.startsWith(alias + '/'))
      candidate = target + spec.slice(alias.length);
  }
  if (!candidate && spec.startsWith('.'))
    candidate = path.resolve(path.dirname(from), spec);
  if (!candidate)
    return undefined;
  for (const file of [candidate, candidate + '.ts', candidate + '.tsx', candidate + '.d.ts', path.join(candidate, 'index.ts')]) {
    if (fs.existsSync(file) && fs.statSync(file).isFile())
      return file;
  }
  return undefined;
}
function visit(file) {
  if (visited.has(file))
    return;
  visited.add(file);
  if (!/\.tsx?$/.test(file))
    return;
  const source = fs.readFileSync(file, 'utf8');
  const re = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g;
  for (const m of source.matchAll(re)) {
    const resolved = resolveImport(file, m[1] || m[2] || m[3]);
    if (resolved)
      visit(resolved);
  }
}

const copies = []; // [from, to]
for (const name of fs.readdirSync(reporterSrc)) {
  if (!isUpstreamUiFile(name))
    continue;
  const file = path.join(reporterSrc, name);
  visit(file);
  copies.push([file, path.join(repoRoot, 'web', 'src', name)]);
}
copies.push([path.join(packages, 'html-reporter', 'index.html'), path.join(repoRoot, 'web', 'index.html')]);
for (const file of visited) {
  if (file.startsWith(aliases['@web'] + path.sep))
    copies.push([file, path.join(repoRoot, 'web', 'vendor', 'web', path.relative(aliases['@web'], file))]);
  else if (file.startsWith(aliases['@isomorphic'] + path.sep))
    copies.push([file, path.join(repoRoot, 'web', 'vendor', 'isomorphic', path.relative(aliases['@isomorphic'], file))]);
}
copies.push([path.join(packages, 'playwright', 'src', 'isomorphic', 'types.d.ts'), path.join(repoRoot, 'web', 'vendor', 'testIsomorphic', 'types.d.ts')]);
copies.push([path.join(packages, 'playwright', 'src', 'reporters', 'html.ts'), path.join(repoRoot, 'upstream', 'html.ts')]);

let changed = 0;
for (const [from, to] of copies) {
  const next = fs.readFileSync(from);
  const prev = fs.existsSync(to) ? fs.readFileSync(to) : undefined;
  if (prev && prev.equals(next))
    continue;
  ++changed;
  const patched = prev && prev.toString('utf8').includes('[extended-report]');
  console.log(`${prev ? 'update' : 'add   '} ${path.relative(repoRoot, to)}${patched ? '   <-- contains [extended-report] patches, re-check after merge' : ''}`);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, next);
  }
}

const version = JSON.parse(fs.readFileSync(path.join(pwRoot, 'package.json'), 'utf8')).version;
if (!dryRun)
  fs.writeFileSync(path.join(repoRoot, 'upstream', 'VERSION'), version + '\n');
console.log(`\n${changed} file(s) ${dryRun ? 'would change' : 'synced'} from Playwright ${version}.`);
