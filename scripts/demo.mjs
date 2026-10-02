#!/usr/bin/env node
/**
 * Live demo: runs the example project 5 times to build up history, attaches a
 * sample "AI analysis" tab and opens the report with mock "Ask AI".
 *
 *   npm run demo              # mock AI answers
 *   npm run demo -- --ai      # real model, see EXTENDED_REPORT_AI_* in README
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

spawnSync(process.execPath, [cli, 'add-tab', 'example/extended-report', '--id', 'ai', '--title', 'AI анализ', '--icon', 'note',
  '--order', '10', '--source', 'jenkins-log-skill (sample)', '--file', 'example/ai-analysis.md'], { cwd: root, stdio: 'inherit' });

const aiFlag = process.argv.includes('--ai') ? '--ai' : '--ai-mock';
spawn(process.execPath, [cli, 'show', 'example/extended-report', aiFlag, '--port', '9324'], { cwd: root, stdio: 'inherit' });
