import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { startReportServer } from '../dist/reporter/index.js';

const root = path.resolve(__dirname, '..');
const outputRoot = path.join(__dirname, '.output');
const reportDir = path.join(outputRoot, 'extended-report');
const cli = path.join(root, 'dist', 'cli', 'index.js');

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv, input?: string } = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...options.env }, input: options.input, encoding: 'utf-8' });
  return { code: result.status, output: result.stdout + result.stderr };
}

function cliRun(...args: string[]) {
  const result = run(process.execPath, [cli, ...args]);
  expect(result.code, result.output).toBe(0);
  return result.output;
}

async function openReport(page: Page, hash = '') {
  await page.goto(pathToFileURL(path.join(reportDir, 'index.html')).href + hash);
  await expect(page.locator('.subnav-item').first()).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  // The demo project has failing tests on purpose, so a non-zero exit code is expected.
  const result = run(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '-c', 'example/playwright.config.ts'], {
    env: { EXTENDED_REPORT_OUTPUT_DIR: reportDir, PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(outputRoot, 'playwright-report') },
  });
  expect(fs.existsSync(path.join(reportDir, 'index.html')), result.output).toBe(true);
  cliRun('add-tab', reportDir, '--id', 'ai', '--title', 'AI анализ', '--icon', 'sparkle', '--badge', '3', '--badge-kind', 'danger', '--order', '10', '--source', 'jenkins-log-skill', '--file', 'example/ai-analysis.md');
});

test('built-in report is generated untouched next to the extended one', () => {
  const builtIn = fs.readFileSync(path.join(outputRoot, 'playwright-report', 'index.html'), 'utf-8');
  expect(builtIn).not.toContain('extendedReportTabs');
});

test('extra tabs appear in the navigation bar with badges', async ({ page }) => {
  await openReport(page);
  const nav = page.locator('nav');
  await expect(nav.getByTestId('extended-tab-nav-ai')).toHaveText(/AI анализ\s*3/);
  await expect(nav.getByTestId('extended-tab-nav-failures')).toHaveText(/Failure analysis\s*6/);
  await expect(nav.getByTestId('extended-tab-nav-insights')).toHaveText(/Insights\s*8/);
  // order: 10 puts the AI tab before the built-in failures tab (order 100).
  const ids = await nav.locator('[data-testid^=extended-tab-nav-]').evaluateAll(els => els.map(e => e.getAttribute('data-testid')));
  expect(ids).toEqual(['extended-tab-nav-ai', 'extended-tab-nav-insights', 'extended-tab-nav-failures']);
});

test('markdown tab renders and links into tests', async ({ page }) => {
  await openReport(page);
  await page.getByTestId('extended-tab-nav-ai').click();
  await expect(page).toHaveURL(/#\?tab=ai$/);
  await expect(page.getByTestId('extended-tab-nav-ai')).toHaveAttribute('aria-selected', 'true');
  const content = page.locator('.markdown-body');
  await expect(content.getByRole('heading', { name: 'Анализ прогона (пример вывода скилла)' })).toBeVisible();
  await expect(content.locator('table').first()).toContainText('Всего тестов');
  await expect(page.getByText('Source: jenkins-log-skill')).toBeVisible();
  // Test list is hidden while a tab is open.
  await expect(page.locator('.test-file-test')).toHaveCount(0);

  // `#?test=<title>` links resolve to the test page.
  await content.getByRole('link', { name: 'adds item to cart' }).click();
  await expect(page).toHaveURL(/#\?testId=/);
  await expect(page.locator('.header-title')).toHaveText('adds item to cart');

  // Angle-bracket links with spaces and " > " separators resolve too.
  await page.goBack();
  await content.getByRole('link', { name: 'cart survives reload' }).click();
  await expect(page.locator('.header-title')).toHaveText('cart survives reload');

  // Back to the tab, then the regular status filter still works.
  await page.goBack();
  await expect(content.getByRole('heading', { name: 'Анализ прогона (пример вывода скилла)' })).toBeVisible();
  await page.locator('nav').getByRole('link', { name: /Failed/ }).click();
  await expect(page.locator('.test-file-test')).toHaveCount(7);
});

test('failure clusters tab groups tests by error', async ({ page }) => {
  await openReport(page, '#?tab=failures');
  const content = page.locator('.markdown-body');
  await expect(content).toContainText('grouped into 6 distinct error(s)');
  const group = content.locator('#group-1');
  await expect(group).toContainText('expect(locator).toHaveText(expected) failed');
  const links = content.locator('h3#group-1 ~ ul').first().getByRole('link');
  await expect(links).toHaveCount(3);
  await links.first().click();
  await expect(page).toHaveURL(/#\?testId=/);
  await expect(page.locator('.header-title')).toBeVisible();
});

test('native report features still work over http', async ({ page }) => {
  // "Copy prompt" and the trace viewer fetch files, which browsers block on file://.
  const server = await startReportServer(reportDir, { port: 0 });
  try {
    await page.goto(server.url);
    await expect(page.locator('.test-file-test')).toHaveCount(14);
    await page.getByRole('link', { name: 'user can log in' }).first().click();
    await expect(page.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
    await page.getByRole('link', { name: 'View Trace' }).first().click();
    await expect(page).toHaveURL(/trace\/index\.html/);
    await expect(page.getByText('check greeting').first()).toBeVisible();
  } finally {
    await server.close();
  }
});

test('report-summary.json is written for LLM / scripts', () => {
  const summary = JSON.parse(fs.readFileSync(path.join(reportDir, 'report-summary.json'), 'utf-8'));
  expect(summary.stats).toMatchObject({ total: 15, expected: 6, unexpected: 7, flaky: 1, skipped: 1 });
  expect(summary.clusters).toHaveLength(6);
  expect(summary.clusters[0].testIds).toHaveLength(3);
  expect(summary.failedTests[0]).toHaveProperty('error');
});

test('html tabs are sanitized', async ({ page }) => {
  cliRun('add-tab', reportDir, '--id', 'html', '--title', 'HTML', '--format', 'html', '--content', '<b id="ok">safe</b><img src="x" onerror="window.__xss=1"><script>window.__xss=2</script>');
  await openReport(page, '#?tab=html');
  await expect(page.locator('#ok')).toHaveText('safe');
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  cliRun('remove-tab', reportDir, '--id', 'html');
});

test('iframe tab serves a self-contained page from the report folder', async ({ page }) => {
  const pageDir = path.join(outputRoot, 'custom-page');
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, 'index.html'), '<h1>Custom dashboard</h1><script>document.body.append("js works")</script>');
  cliRun('add-tab', reportDir, '--id', 'dash', '--title', 'Dashboard', '--icon', 'graph', '--file', pageDir);
  expect(fs.existsSync(path.join(reportDir, 'tabs', 'dash', 'index.html'))).toBe(true);
  await openReport(page, '#?tab=dash');
  const frame = page.frameLocator('.extended-tab-iframe');
  await expect(frame.getByRole('heading', { name: 'Custom dashboard' })).toBeVisible();
  await expect(frame.locator('body')).toContainText('js works');
  cliRun('remove-tab', reportDir, '--id', 'dash');
  expect(fs.existsSync(path.join(reportDir, 'tabs', 'dash'))).toBe(false);
});

test('add-tab replaces a tab with the same id and keeps the report readable', async ({ page }) => {
  cliRun('add-tab', reportDir, '--id', 'ai', '--title', 'AI v2', '--content', '# Second version');
  expect(cliRun('list-tabs', reportDir)).toMatch(/^ai\tmarkdown\tAI v2$/m);
  await openReport(page, '#?tab=ai');
  await expect(page.locator('.markdown-body h1')).toHaveText('Second version');
  await page.locator('nav').getByRole('link', { name: /^All/ }).click();
  await expect(page.locator('.test-file-test')).toHaveCount(14);
});

test.describe('insights tab', () => {
  let server: Awaited<ReturnType<typeof startReportServer>>;
  test.beforeAll(async () => {
    server = await startReportServer(reportDir, { port: 0, ai: { mode: 'mock' } });
  });
  test.afterAll(async () => {
    await server.close();
  });

  const card = (page: Page, title: string) => page.getByTestId('insight-card').filter({ has: page.getByRole('link', { name: title, exact: true }) });

  test('classifies failures with evidence', async ({ page }) => {
    await page.goto(server.url + '#?tab=insights');
    await expect(page.getByTestId('insight-card')).toHaveCount(8);
    await expect(card(page, 'app › cart items are loaded from api').getByTestId('insight-kind')).toHaveText('Environment');
    await expect(card(page, 'app › profile shows user name').getByTestId('insight-kind')).toHaveText('Product bug');
    await expect(card(page, 'cart › adds item to cart').getByTestId('insight-kind')).toHaveText('Test bug');
    await expect(card(page, 'checkout › flaky payment widget').getByTestId('insight-kind')).toHaveText('Flaky');
    // Filter by kind.
    await page.getByRole('button', { name: /^Test bug/ }).click();
    await expect(page.getByTestId('insight-card')).toHaveCount(4);
  });

  test('shows network and browser errors from the trace', async ({ page }) => {
    await page.goto(server.url + '#?tab=insights');
    const api = card(page, 'app › cart items are loaded from api');
    await expect(api.getByTestId('insight-network')).toContainText('500');
    await expect(api.getByTestId('insight-network')).toContainText('http://demo.local/api/cart');
    await expect(api.getByTestId('insight-console')).toContainText('Failed to load cart: HTTP 500');
    await expect(card(page, 'app › profile shows user name').getByTestId('insight-console')).toContainText("TypeError: Cannot read properties of undefined (reading 'name')");
  });

  test('compares failed and passed attempts', async ({ page }) => {
    await page.goto(server.url + '#?tab=insights');
    const flaky = card(page, 'checkout › flaky payment widget');
    await flaky.getByRole('button', { name: 'Compare attempts' }).click();
    await expect(flaky.getByTestId('attempts-compare')).toContainText('Attempt #1 failed, attempt #2 passed');
    await expect(flaky.locator('.attempt-column')).toHaveCount(2);
  });

  test('asks AI through the gateway and offers fixes', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(server.url + '#?tab=insights');
    const api = card(page, 'app › cart items are loaded from api');
    await api.getByRole('button', { name: 'Ask AI' }).click();
    await expect(api.getByTestId('ai-answer')).toContainText('Classification: environment');
    await api.getByRole('button', { name: 'Fix ▾' }).click();
    await page.getByRole('menuitem', { name: 'Copy rerun command' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npx playwright test "app.spec.ts:36" --project="chromium" --retries=0 --trace=on');
  });

  test('without an AI endpoint falls back to copying the prompt', async ({ page }) => {
    await openReport(page, '#?tab=insights');
    const api = card(page, 'app › cart items are loaded from api');
    await api.getByRole('button', { name: 'Ask AI' }).click();
    await expect(api.getByTestId('ai-panel')).toContainText('No AI endpoint is available');
    await api.getByText('Prompt preview').click();
    await expect(api.getByTestId('ai-panel').locator('pre')).toContainText('GET http://demo.local/api/cart → 500');
  });

  test('history is recorded across runs', () => {
    const history = JSON.parse(fs.readFileSync(path.join(reportDir, 'history.json'), 'utf-8'));
    expect(history.runs).toHaveLength(1);
    expect(fs.existsSync(path.join(outputRoot, 'extended-report-history.json'))).toBe(true);
  });
});
