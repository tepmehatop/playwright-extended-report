import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { AgentService, Repo, chat, llmConfigFromEnv, startReportServer } from '../dist/reporter/index.js';

const root = path.resolve(__dirname, '..');
// A throw-away copy of the demo project: the agent re-runs and edits tests there.
const repoDir = path.join(__dirname, '.output-agent', 'repo');
const reportDir = path.join(repoDir, 'example', 'extended-report');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(repoDir, { recursive: true });
  fs.cpSync(path.join(root, 'example'), path.join(repoDir, 'example'), { recursive: true, filter: src => !/(extended-report|playwright-report|test-results|history\.json)/.test(path.relative(root, src)) });
  fs.symlinkSync(path.join(root, 'dist'), path.join(repoDir, 'dist'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(repoDir, 'node_modules'));
  fs.writeFileSync(path.join(repoDir, 'package.json'), '{"name":"agent-repo","private":true}');
  const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '-c', 'example/playwright.config.ts'], { cwd: repoDir, encoding: 'utf-8' });
  expect(fs.existsSync(path.join(reportDir, 'index.html')), result.stdout + result.stderr).toBe(true);
});

const card = (page: Page, title: string) => page.getByTestId('insight-card').filter({ has: page.getByRole('link', { name: title, exact: true }) });

test.describe('agent with a repository', () => {
  let server: Awaited<ReturnType<typeof startReportServer>>;
  test.beforeAll(async () => {
    const agent = new AgentService({ llm: llmConfigFromEnv({ mock: true }), reportDir, repo: new Repo(repoDir, 'example/playwright.config.ts') });
    server = await startReportServer(reportDir, { port: 0, agent });
  });
  test.afterAll(async () => {
    await server.close();
  });

  test('analysis is built from the trace: DOM at failure, similar elements, source, engineer hint', async ({ page }) => {
    await page.goto(server.url + '#?tab=insights');
    const c = card(page, 'cart › removes item from cart');
    await c.getByRole('button', { name: 'Ask AI' }).click();
    await expect(c.getByTestId('agent-answer')).toContainText('TEST BUG');
    await c.getByTestId('agent-comment').fill('Auth is fine, the cart counter was redesigned');
    await c.getByRole('button', { name: 'Analyze again' }).click();
    await expect(c.getByTestId('agent-answer')).toContainText('Auth is fine, the cart counter was redesigned');
    const evidence = c.getByTestId('agent-evidence');
    await evidence.locator('summary').click();
    await expect(evidence).toContainText('Hint from the engineer');
    await expect(evidence).toContainText('Page at the moment of failure');
    await expect(evidence).toContainText('<div class="cart"> Cart: 0');
    await expect(evidence).toContainText("page.locator('div.cart')");
    await expect(evidence).toContainText('Source: example/tests/shop.spec.ts');
  });

  test('run & debug re-runs the test locally', async ({ page }) => {
    await page.goto(server.url + '#?tab=insights');
    const c = card(page, 'cart › removes item from cart');
    await c.getByRole('button', { name: 'Ask AI' }).click();
    await expect(c.getByTestId('agent-answer')).toBeVisible();
    await c.getByRole('button', { name: 'Run & debug' }).click();
    await expect(c.locator('.ai-answer-meta')).toContainText('local run: failed', { timeout: 120_000 });
    await expect(c.getByTestId('agent-answer')).toContainText('The failure reproduces');
  });

  test('fix: propose, apply & verify, revert', async ({ page }) => {
    const file = path.join(repoDir, 'example', 'tests', 'shop.spec.ts');
    const original = fs.readFileSync(file, 'utf-8');
    await page.goto(server.url + '#?tab=insights');
    const c = card(page, 'cart › removes item from cart');
    await c.getByRole('button', { name: 'Fix ▾' }).click();
    await page.getByRole('menuitem', { name: 'Propose fix with AI agent' }).click();
    await expect(c.getByTestId('agent-diff')).toContainText("-    await expect(page.getByTestId('cart-counter')).toHaveText('Cart: 0'");
    await expect(c.getByTestId('agent-diff')).toContainText("+    await expect(page.locator('div.cart')).toHaveText('Cart: 0'");
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
    await c.getByTestId('agent-apply').click();
    await expect(c.getByTestId('agent-verify')).toHaveText(/The test passes with the fix/, { timeout: 120_000 });
    expect(fs.readFileSync(file, 'utf-8')).toContain("page.locator('div.cart')).toHaveText('Cart: 0'");
    await c.getByRole('button', { name: 'Revert' }).click();
    await expect(c.getByText('The change was reverted.')).toBeVisible();
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
  });

  test('Ask AI and Fix are on the test page next to Copy prompt', async ({ page }) => {
    await page.goto(server.url + '#?q=s%3Afailed');
    await page.getByRole('link', { name: 'removes item from cart' }).first().click();
    const errors = page.locator('.chip', { has: page.getByRole('button', { name: 'Errors' }) });
    await expect(errors.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
    await expect(errors.getByRole('button', { name: 'Fix ▾' })).toBeVisible();
    await page.getByTestId('test-page-ask-ai').click();
    await expect(page.getByTestId('agent-answer')).toContainText('TEST BUG');
  });
});

test('analysis-only gateway receives the trace from the browser', async ({ page }) => {
  // Report served as static files (like Jenkins), agent on another origin.
  const agent = new AgentService({ llm: llmConfigFromEnv({ mock: true }), corsOrigin: '*' });
  const gateway = await startReportServer(reportDir, { port: 0, agent });
  const staticServer = await startReportServer(reportDir, { port: 0 });
  try {
    // Point the report to the gateway the same way EXTENDED_REPORT_AI_ENDPOINT does.
    const html = fs.readFileSync(path.join(reportDir, 'index.html'), 'utf-8');
    expect(html).toContain('extendedReportTabs');
    await page.route('**/api/agent/**', route => route.continue({ url: route.request().url().replace(staticServer.url, gateway.url) }));
    await page.goto(staticServer.url + '#?tab=insights');
    const c = card(page, 'app › cart items are loaded from api');
    await c.getByRole('button', { name: 'Ask AI' }).click();
    await expect(c.getByTestId('agent-answer')).toContainText('ENVIRONMENT');
    await expect(c.getByRole('button', { name: 'Run & debug' })).toHaveCount(0);
  } finally {
    await gateway.close();
    await staticServer.close();
  }
});

test.describe('LLM providers', () => {
  const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>) => {
    const saved = { ...process.env };
    Object.assign(process.env, vars);
    try {
      await fn();
    } finally {
      process.env = saved;
    }
  };

  test('openai-compatible proxy with a bearer key', async () => {
    const calls: any[] = [];
    const server = await fakeServer((req, body) => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      return { choices: [{ message: { content: '<think>hidden</think>Proxy answer' } }], model: 'qwen3' };
    });
    await withEnv({ EXTENDED_REPORT_AI_PROVIDER: 'proxy', PROXY_BASE_URL: server.url + '/v1', PROXY_API_KEY: 'secret', LLM_MODEL: 'qwen3' }, async () => {
      const answer = await chat(llmConfigFromEnv(), [{ role: 'user', content: 'hi' }]);
      expect(answer.content).toBe('Proxy answer');
    });
    expect(calls[0]).toMatchObject({ url: '/v1/chat/completions', auth: 'Bearer secret', body: { model: 'qwen3' } });
    await server.close();
  });

  test('gigachat: oauth token, then chat completions', async () => {
    const calls: any[] = [];
    const server = await fakeServer((req, body) => {
      calls.push({ url: req.url, auth: req.headers.authorization, rquid: req.headers.rquid, body });
      if (req.url === '/oauth')
        return { access_token: 'giga-token', expires_at: Date.now() + 30 * 60_000 };
      return { choices: [{ message: { content: 'GigaChat answer' } }], model: 'GigaChat-Pro' };
    });
    await withEnv({ EXTENDED_REPORT_AI_PROVIDER: 'gigachat', GIGACHAT_AUTH_URL: server.url + '/oauth', GIGACHAT_API_URL: server.url + '/api/v1', GIGACHAT_AUTHORIZATION_KEY: 'base64key', GIGACHAT_SCOPE: 'GIGACHAT_API_CORP', LLM_MODEL: 'GigaChat-Pro' }, async () => {
      const answer = await chat(llmConfigFromEnv(), [{ role: 'user', content: 'hi' }]);
      expect(answer.content).toBe('GigaChat answer');
    });
    expect(calls[0]).toMatchObject({ url: '/oauth', auth: 'Basic base64key', body: 'scope=GIGACHAT_API_CORP' });
    expect(calls[0].rquid).toBeTruthy();
    expect(calls[1]).toMatchObject({ url: '/api/v1/chat/completions', auth: 'Bearer giga-token' });
    await server.close();
  });

  test('gigacode-cli: token and model url from ~/.gigacode/gigacode_token.json', async () => {
    const calls: any[] = [];
    const server = await fakeServer((req, body) => {
      calls.push({ url: req.url, auth: req.headers.authorization, model: JSON.parse(body).model });
      return { choices: [{ message: { content: 'GigaCode answer' } }] };
    });
    const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gigacode-')), 'gigacode_token.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ token: 'cli-token', expiryDate: Date.now() + 3600_000, config: { chat: { models: [{ model: 'gigacode-pro', url: server.url + '/v1/chat/completions' }] } } }));
    await withEnv({ EXTENDED_REPORT_AI_PROVIDER: 'gigacode-cli', GIGACODE_TOKEN_FILE: tokenFile, LLM_MODEL: 'gigacode-pro' }, async () => {
      const answer = await chat(llmConfigFromEnv(), [{ role: 'user', content: 'hi' }]);
      expect(answer.content).toBe('GigaCode answer');
    });
    expect(calls[0]).toMatchObject({ url: '/v1/chat/completions', auth: 'Bearer cli-token', model: 'gigacode-pro' });
    await server.close();
  });
});

async function fakeServer(handler: (req: http.IncomingMessage, body: string) => unknown) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(handler(req, body)));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) };
}
