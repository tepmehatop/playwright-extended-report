import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { AgentService, McpHub, Repo, chat, llmConfigFromEnv, startReportServer } from '../dist/reporter/index.js';

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

const ideLog = path.join(__dirname, '.output-agent', 'ide.log');

test.describe('agent with a repository', () => {
  let server: Awaited<ReturnType<typeof startReportServer>>;
  test.beforeAll(async () => {
    // "IDE" that records how it was called.
    const fakeIde = path.join(__dirname, '.output-agent', 'fake-ide.js');
    fs.writeFileSync(fakeIde, `require('fs').writeFileSync(${JSON.stringify(ideLog)}, process.argv.slice(2).join(' '))`);
    process.env.EXTENDED_REPORT_IDE_COMMAND = `${process.execPath} ${fakeIde} {file} {line}`;
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
    await expect(c.getByTestId('agent-answer')).toContainText('ОШИБКА ТЕСТА');
    await c.getByTestId('agent-comment').fill('Auth is fine, the cart counter was redesigned');
    await c.getByRole('button', { name: 'Анализ заново' }).click();
    await expect(c.getByTestId('agent-answer')).toContainText('Auth is fine, the cart counter was redesigned');
    const evidence = c.getByTestId('agent-evidence');
    await evidence.locator('summary').click();
    await expect(evidence).toContainText('Подсказка инженера');
    await expect(evidence).toContainText('Страница в момент падения');
    await expect(evidence).toContainText('Locator lab');
    await expect(evidence).toContainText('<div class="cart"> Cart: 0');
    await expect(evidence).toContainText("page.locator('div.cart')");
    await expect(evidence).toContainText('Исходный код: example/tests/shop.spec.ts');
  });

  test('run & debug re-runs the test locally', async ({ page }) => {
    await page.goto(server.url + '#?tab=insights');
    const c = card(page, 'cart › removes item from cart');
    await c.getByRole('button', { name: 'Ask AI' }).click();
    await expect(c.getByTestId('agent-answer')).toBeVisible();
    await c.getByRole('button', { name: 'Запустить и отладить' }).click();
    await expect(c.locator('.ai-answer-meta')).toContainText('локальный запуск: failed', { timeout: 120_000 });
    await expect(c.getByTestId('agent-answer')).toContainText('Падение воспроизводится');
  });

  test('fix: propose, apply & verify, revert', async ({ page }) => {
    const file = path.join(repoDir, 'example', 'tests', 'shop.spec.ts');
    const original = fs.readFileSync(file, 'utf-8');
    await page.goto(server.url + '#?tab=insights');
    const c = card(page, 'cart › removes item from cart');
    await c.getByRole('button', { name: 'Fix ▾' }).click();
    await page.getByRole('menuitem', { name: 'Предложить фикс через AI-агента' }).click();
    await expect(c.getByTestId('agent-diff')).toContainText("-    await expect(page.getByTestId('cart-counter')).toHaveText('Cart: 0'");
    await expect(c.getByTestId('agent-diff')).toContainText("+    await expect(page.locator('div.cart')).toHaveText('Cart: 0'");
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
    // Locators introduced by the fix were checked on the DOM at failure.
    await expect(c.getByTestId('agent-fix-lab')).toContainText("page.locator('div.cart')");
    await expect(c.getByTestId('agent-fix-lab')).toContainText('1 элемент');
    await c.getByTestId('agent-apply').click();
    await expect(c.getByTestId('agent-verify')).toHaveText(/Тест проходит с правкой/, { timeout: 120_000 });
    expect(fs.readFileSync(file, 'utf-8')).toContain("page.locator('div.cart')).toHaveText('Cart: 0'");
    await c.getByRole('button', { name: 'Откатить' }).click();
    await expect(c.getByText('Изменение откачено.')).toBeVisible();
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
  });

  test('locator lab checks locators on the page at the moment of failure', async ({ page }) => {
    await page.goto(server.url + '#?tab=insights');
    const c = card(page, 'cart › removes item from cart');
    await c.getByRole('button', { name: 'Ask AI' }).click();
    await expect(c.getByTestId('agent-answer')).toBeVisible();
    await c.getByTestId('agent-lab').locator('summary').click();
    await c.getByTestId('agent-lab-input').fill("page.locator('div.cart')\npage.getByTestId('cart-counter')\npage.getByRole('button', { name: 'Buy' })");
    await c.getByTestId('agent-lab').getByRole('button', { name: 'Проверить' }).click();
    const results = c.getByTestId('agent-lab').getByTestId('lab-results');
    await expect(results.locator('tr').nth(0)).toContainText('1 элемент');
    await expect(results.locator('tr').nth(0)).toContainText('Cart: 0');
    await expect(results.locator('tr').nth(1)).toContainText('0 элементов');
    await expect(results.locator('tr').nth(2)).toContainText('<button id="buy">');
  });

  test('error group: one analysis and one fix for all tests of the group', async ({ page }) => {
    const file = path.join(repoDir, 'example', 'tests', 'shop.spec.ts');
    const original = fs.readFileSync(file, 'utf-8');
    // The link from the automatic grouping opens the group in Insights.
    await page.goto(server.url + '#?tab=failures');
    await page.getByTestId('extended-section-auto').getByRole('link', { name: 'Разобрать группу с AI-агентом →' }).first().click();
    const group = page.getByTestId('group-card').filter({ hasText: 'cart › adds item to cart' });
    await expect(group).toHaveClass(/focused/);
    await expect(group.getByTestId('agent-answer')).toContainText('Та же ошибка ещё в 2 тест(ах) группы');
    await group.getByTestId('fix-group').click();
    await expect(group.getByTestId('agent-diff')).toContainText("+    await expect(page.locator('div.cart')).toHaveText('Cart: 1'");
    await expect(group.getByTestId('agent-diff')).toContainText("+    await expect(page.locator('div.cart')).toHaveText('Cart: 0'");
    await group.getByTestId('agent-apply').click();
    // Verified on all 3 tests: only "removes item" really becomes green — the others have other causes.
    const verify = group.getByTestId('agent-verify');
    await expect(verify).toContainText('Тест всё ещё падает', { timeout: 180_000 });
    await expect(verify).toContainText('✓ cart › removes item from cart: passed');
    await expect(verify).toContainText('✗ cart › adds item to cart: failed');
    await group.getByRole('button', { name: 'Откатить' }).click();
    await expect(group.getByText('Изменение откачено.')).toBeVisible();
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
  });

  test('copy cURL and a backend bug report for a failed request', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(server.url + '#?tab=insights');
    const network = card(page, 'app › cart items are loaded from api').getByTestId('insight-network');
    await network.getByRole('button', { name: 'cURL' }).click();
    const curl = await page.evaluate(() => navigator.clipboard.readText());
    expect(curl).toContain("curl 'http://demo.local/api/cart'");
    await network.getByRole('button', { name: 'Баг-репорт' }).click();
    const bug = await page.evaluate(() => navigator.clipboard.readText());
    expect(bug).toContain('### GET /api/cart → 500');
    expect(bug).toContain('**Тело ответа:**');
    expect(bug).toContain('Internal Server Error');
    await network.getByText('Тело ответа').click();
    await expect(network).toContainText('{"error":"Internal Server Error"}');
  });

  test('open in IDE through the local agent', async ({ page }) => {
    await page.goto(server.url + '#?tab=insights');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByTestId('ide-select').selectOption('agent:idea');
    await page.keyboard.press('Escape');
    const c = card(page, 'cart › removes item from cart');
    await c.locator('.insight-actions').getByTestId('open-in-ide').click();
    await expect(c.getByText('Открыто в IDE')).toBeVisible();
    await expect.poll(() => fs.existsSync(ideLog) ? fs.readFileSync(ideLog, 'utf-8') : '').toContain(path.join('example', 'tests', 'shop.spec.ts') + ' 26');
  });

  test('Ask AI and Fix are on the test page next to Copy prompt', async ({ page }) => {
    await page.goto(server.url + '#?q=s%3Afailed');
    await page.getByRole('link', { name: 'removes item from cart' }).first().click();
    const errors = page.locator('.chip', { has: page.getByRole('button', { name: 'Errors' }) });
    await expect(errors.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
    await expect(errors.getByRole('button', { name: 'Fix ▾' })).toBeVisible();
    await page.getByTestId('test-page-ask-ai').click();
    await expect(page.getByTestId('agent-answer')).toContainText('ОШИБКА ТЕСТА');
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
    await expect(c.getByTestId('agent-answer')).toContainText('ОКРУЖЕНИЕ');
    await expect(c.getByRole('button', { name: 'Запустить и отладить' })).toHaveCount(0);
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
      const result: any = handler(req, body);
      res.statusCode = result?.__status ?? 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) };
}

test('analyze in CI: the report opens with the analysis already in place', async ({ page }) => {
  const copy = path.join(__dirname, '.output-agent', 'analyzed-report');
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(reportDir, copy, { recursive: true });
  const result = spawnSync(process.execPath, [path.join(root, 'dist', 'cli', 'index.js'), 'analyze', copy, '--ai-mock', '--max', '3'], { encoding: 'utf-8' });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('AI analysis: 3 done, 0 failed');
  // No agent backend at all: file:// shows what CI prepared.
  await page.goto(pathToFileURL(path.join(copy, 'index.html')).href + '#?tab=failures');
  await expect(page.getByTestId('extended-section-ai-groups')).toContainText('AI-разбор групп ошибок');
  await page.goto(pathToFileURL(path.join(copy, 'index.html')).href + '#?tab=insights&group=1');
  const group = page.getByTestId('group-card').first();
  await expect(group.getByTestId('agent-precomputed')).toContainText('подготовлен в CI');
  await expect(group.getByTestId('agent-precomputed')).toContainText('Та же ошибка ещё в 2 тест(ах) группы');
});

test.describe('MCP first, simple path as fallback', () => {
  const fakeMcp = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');

  async function analyze(llmUrl: string, provider = 'openai') {
    const saved = { ...process.env };
    Object.assign(process.env, { EXTENDED_REPORT_AI_PROVIDER: provider, EXTENDED_REPORT_AI_BASE_URL: llmUrl, GIGACHAT_API_URL: llmUrl, GIGACHAT_AUTH_URL: llmUrl + '/oauth', GIGACHAT_AUTHORIZATION_KEY: 'k', EXTENDED_REPORT_AI_MODEL: 'test-model' });
    const llm = llmConfigFromEnv();
    process.env = saved;
    const mcp = new McpHub({ mcpServers: { cmp: { command: process.execPath, args: [fakeMcp] } } });
    const agent = new AgentService({ llm, reportDir, mcp });
    const { readReportTestCases } = require('../dist/agent/batch.js');
    const cases = await readReportTestCases(reportDir);
    const test = [...cases.values()].find((t: any) => t.title === 'removes item from cart');
    const attempt = test.results.length - 1;
    const tracePath = test.results[attempt].attachments.find((a: any) => a.name === 'trace').path;
    const job = await agent.wait(agent.start({ kind: 'analyze', test, attempt, tracePath }));
    await agent.close();
    return job;
  }

  test('the model calls an MCP tool, then answers (OpenAI tools format)', async () => {
    const requests: any[] = [];
    const llm = await fakeServer((req, body) => {
      const json = JSON.parse(body);
      requests.push(json);
      if (requests.length === 1)
        return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'cmp__lookup_page_object', arguments: '{"component":"cart"}' } }] } }] };
      const toolResult = json.messages.find((m: any) => m.role === 'tool')?.content;
      return { choices: [{ message: { role: 'assistant', content: `## Вердикт\nОШИБКА ТЕСТА. MCP: ${toolResult}` } }] };
    });
    const job = await analyze(llm.url + '/v1');
    expect(job.status, job.error).toBe('done');
    expect(job.result.path).toBe('mcp');
    expect(job.result.markdown).toContain("CartPage.counter = page.locator('div.cart')");
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(['cmp__lookup_page_object', 'agent__locator_lab', 'agent__read_source']));
    expect(job.log.map((l: any) => l.text).join('\n')).toContain('MCP-путь: вызовов инструментов — 1');
    await llm.close();
  });

  test('GigaChat gets functions / function_call (its own tool format)', async () => {
    const requests: any[] = [];
    const llm = await fakeServer((req, body) => {
      if (req.url === '/oauth')
        return { access_token: 't', expires_at: Date.now() + 600_000 };
      const json = JSON.parse(body);
      requests.push(json);
      if (requests.length === 1)
        return { choices: [{ message: { role: 'assistant', content: '', function_call: { name: 'cmp__lookup_page_object', arguments: { component: 'cart' } } } }] };
      const fn = json.messages.find((m: any) => m.role === 'function');
      return { choices: [{ message: { role: 'assistant', content: `ответ: ${fn.name} ${fn.content}` } }] };
    });
    const job = await analyze(llm.url, 'gigachat');
    expect(job.status, job.error).toBe('done');
    expect(requests[0].functions.map((f: any) => f.name)).toContain('cmp__lookup_page_object');
    expect(requests[0].tools).toBeUndefined();
    expect(requests[1].messages.some((m: any) => m.role === 'assistant' && m.function_call?.arguments?.component === 'cart')).toBe(true);
    expect(job.result.markdown).toContain('cmp__lookup_page_object');
    await llm.close();
  });

  test('when the provider rejects tools, the simple path answers', async () => {
    const llm = await fakeServer((req, body) => {
      const json = JSON.parse(body);
      if (json.tools)
        return { __status: 400, error: 'tools are not supported' };
      return { choices: [{ message: { role: 'assistant', content: '## Вердикт\nпростой путь' } }] };
    });
    const job = await analyze(llm.url + '/v1');
    expect(job.status, job.error).toBe('done');
    expect(job.result.path).toBe('simple');
    expect(job.result.markdown).toContain('простой путь');
    expect(job.log.map((l: any) => l.text).join('\n')).toContain('Перехожу на простой путь');
    await llm.close();
  });
});
