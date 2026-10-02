#!/usr/bin/env node
/**
 * Live demo: runs the example project 5 times to build up history, attaches a
 * sample "AI analysis" tab and opens the report with mock "Ask AI".
 *
 *   npm run demo              # template AI answers (no model needed)
 *   npm run demo -- --ai      # real model, configured via env (docs/AGENT.md)
 */

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const playwrightCli = require.resolve('@playwright/test/cli');
const cli = path.join(root, 'dist', 'cli', 'index.js');
const runs = 5;

if (!fs.existsSync(cli)) {
  console.error('Build first: npm run build');
  process.exit(1);
}
fs.rmSync(path.join(root, 'example', 'extended-report-history.json'), { force: true });

for (let run = 1; run <= runs; run++) {
  process.stdout.write(`Run ${run}/${runs}... `);
  const result = spawnSync(process.execPath, [playwrightCli, 'test', '-c', 'example/playwright.config.ts'], {
    cwd: root,
    encoding: 'utf-8',
    env: { ...process.env, DEMO_RUN: String(run), EXTENDED_REPORT_RUN_ID: `demo-${run}` },
  });
  const summary = (result.stdout + result.stderr).match(/\d+ (failed|passed|flaky|skipped)/g) ?? [];
  console.log(summary.join(', '));
}

spawnSync(process.execPath, [cli, 'add-analysis', 'example/extended-report', '--source', 'jenkins-log-skill (sample)', '--file', 'example/ai-analysis.md'], { cwd: root, stdio: 'inherit' });

// Agent mode: analysis + local re-run + fixes in this repository (example/ is the "tests repo").
const args = [cli, 'agent', 'example/extended-report', '--repo', root, '--config', 'example/playwright.config.ts', '--port', '9324'];
if (!process.argv.includes('--ai'))
  args.push('--ai-mock');
spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
