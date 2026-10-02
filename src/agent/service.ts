/**
 * The test agent behind the "Ask AI" / "Fix" buttons.
 *
 * Two paths, tried in this order:
 *  1. MCP-assisted: the model gets the evidence pack plus tools — your MCP servers (serena, code-index,
 *     codebase-memory, context7, playwright...) and the agent's own (locator lab, read source) — and may
 *     call them before answering.
 *  2. Simple (fallback, or when no MCP is configured): our code collects everything (trace, DOM at failure,
 *     similar elements, locator lab, re-run), the model only reasons over it and answers in text.
 *     Works with any chat/completions model, including those with no tool calling at all.
 *
 * HTTP API (mounted by `pw-extended-report show --ai` / `agent` / `ai-gateway`):
 *   GET  /api/agent/status
 *   POST /api/agent/jobs        {kind: analyze | debug | fix | apply | revert | lab, group?, ...}
 *   GET  /api/agent/jobs/<id>
 *   POST /api/ide/open          {file, line, column?, ide}   (local agent with a repository only)
 *   POST /api/ai/ask            {prompt}                     (simple prompt -> answer)
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { buildEvidence, sourceForPath } from './evidence';
import { applyEditBlocks, parseEditBlocks } from './edits';
import { agentLang, chat, describeLlm } from './llm';
import { closeLocatorLab, describeLab, extractLocators, normalizeLocator, runLocatorLab } from './locatorLab';
import { analyzePrompt, clusterPrompt, debugPrompt, fixPrompt, fixRetryMessage, systemPrompt, toolsGuide } from './prompts';
import { runTests } from './repo';
import { runToolLoop } from './toolLoop';
import { readTrace } from './trace';

import type http from 'http';
import type { Evidence, ReportTestCase } from './evidence';
import type { ChatMessage, LlmConfig } from './llm';
import type { LabResult } from './locatorLab';
import type { McpHub } from './mcp';
import type { Lang } from './prompts';
import type { Repo, RunResult } from './repo';
import type { AgentTool } from './toolLoop';
import type { TraceData } from './trace';
import type { InsightTest } from '../shared/insightsFormat';

export type AgentOptions = {
  llm: LlmConfig;
  /** Report folder served by us: traces are read from disk instead of being uploaded. */
  reportDir?: string;
  /** Tests repository: sources, MCP ${REPO}; with `allowRun` also re-runs and fixes. */
  repo?: Repo;
  /** Allow running tests and applying fixes in `repo`. Default: true when repo is set. */
  allowRun?: boolean;
  /** MCP servers offered to the model (MCP-assisted path). */
  mcp?: McpHub;
  corsOrigin?: string;
};

export type JobKind = 'analyze' | 'debug' | 'fix' | 'apply' | 'revert' | 'lab';

export type JobRequest = {
  kind: JobKind;
  /** The test (for a group: its representative). */
  test: ReportTestCase;
  attempt?: number;
  insight?: InsightTest;
  /** Report-relative path of trace.zip, e.g. data/<sha1>.zip */
  tracePath?: string;
  traceBase64?: string;
  errorContext?: string;
  comment?: string;
  /** Previous analysis to build the fix on. */
  analysis?: string;
  /** For apply / revert. */
  fixId?: string;
  /** Error of a fix that did not help, to get a different proposal. */
  previousFixError?: string;
  /** Analyze / fix a whole error group: the other tests of the group. */
  group?: { id?: number, title?: string, tests: ReportTestCase[], insights?: InsightTest[] };
  /** For kind "lab": locators to check on the DOM at failure. */
  locators?: string[];
  /** Set to false to skip the MCP-assisted path. */
  useTools?: boolean;
};

export type FixProposal = {
  id: string;
  explanation: string;
  files: { file: string, diff: string, inRepo: boolean }[];
  canApply: boolean;
  /** Locators used by the fix, checked on the DOM at failure. */
  lab?: LabResult[];
  applied?: boolean;
  reverted?: boolean;
  verify?: { status: string, error?: string, durationMs?: number, tests?: { title: string, status: string }[] };
};

export type JobState = {
  id: string;
  kind: JobKind;
  status: 'running' | 'done' | 'error';
  log: { time: number, text: string }[];
  result?: {
    markdown?: string;
    evidence?: string;
    prompt?: string;
    model?: string;
    /** "mcp" when the answer came from the MCP-assisted path. */
    path?: 'mcp' | 'simple';
    toolCalls?: { name: string, ok: boolean }[];
    fix?: FixProposal;
    rerun?: { status: string, error?: string, durationMs?: number };
    lab?: LabResult[];
  };
  error?: string;
};

type StoredFix = { proposal: FixProposal, edits: { file: string, oldContent: string, newContent: string, inRepo: boolean }[], tests: ReportTestCase[] };
type SourceFile = { path: string, content: string, focusLine?: number, inRepo: boolean };

export class AgentService {
  private _options: AgentOptions;
  private _jobs = new Map<string, JobState>();
  private _fixes = new Map<string, StoredFix>();
  private _lang: Lang;

  constructor(options: AgentOptions) {
    this._options = options;
    this._lang = agentLang(options.llm);
  }

  private get _canRun(): boolean {
    return !!this._options.repo && this._options.allowRun !== false;
  }

  status() {
    return {
      enabled: true,
      model: describeLlm(this._options.llm),
      provider: this._options.llm.provider,
      language: this._lang,
      canRun: this._canRun,
      canApply: this._canRun,
      canOpenInIde: !!this._options.repo,
      repo: this._options.repo?.dir,
      tracesFromDisk: !!this._options.reportDir,
      mcp: this._options.mcp ? { config: this._options.mcp.source, servers: this._options.mcp.status() } : undefined,
    };
  }

  /** Returns false when the URL is not ours. */
  handle(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    const url = new URL(request.url || '/', 'http://localhost');
    const p = url.pathname;
    if (!p.includes('/api/agent/') && !p.endsWith('/api/ai/status') && !p.endsWith('/api/ai/ask') && !p.endsWith('/api/ide/open'))
      return false;
    if (this._options.corsOrigin) {
      response.setHeader('Access-Control-Allow-Origin', this._options.corsOrigin);
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return true;
      }
    }
    const reply = (status: number, body: unknown) => {
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(body));
    };
    if (p.endsWith('/api/agent/status') || p.endsWith('/api/ai/status')) {
      reply(200, this.status());
      return true;
    }
    const jobMatch = p.match(/\/api\/agent\/jobs\/([\w-]+)$/);
    if (jobMatch && request.method === 'GET') {
      const job = this._jobs.get(jobMatch[1]);
      reply(job ? 200 : 404, job ?? { error: 'job not found' });
      return true;
    }
    if (request.method !== 'POST') {
      reply(405, { error: 'POST expected' });
      return true;
    }
    readBody(request).then(async body => {
      const json = JSON.parse(body);
      if (p.endsWith('/api/ai/ask')) {
        const answer = await chat(this._options.llm, [{ role: 'system', content: systemPrompt(this._lang) }, { role: 'user', content: String(json.prompt || '') }], () => this._t('Шаблонный ответ: подключите модель, чтобы получить настоящий анализ.', 'Mock answer: configure a model to get a real analysis.'));
        reply(200, { markdown: answer.content, model: answer.model });
        return;
      }
      if (p.endsWith('/api/ide/open')) {
        reply(200, await this._openInIde(json));
        return;
      }
      if (p.endsWith('/api/agent/jobs')) {
        const job = this.start(json as JobRequest);
        reply(200, { id: job.id });
        return;
      }
      reply(404, { error: 'not found' });
    }).catch(e => reply(400, { error: String(e?.message || e) }));
    return true;
  }

  start(request: JobRequest): JobState {
    const job: JobState = { id: crypto.randomUUID(), kind: request.kind, status: 'running', log: [] };
    this._jobs.set(job.id, job);
    if (this._jobs.size > 200)
      this._jobs.delete(this._jobs.keys().next().value!);
    const log = (text: string) => job.log.push({ time: Date.now(), text });
    this._run(request, job, log).then(() => {
      job.status = 'done';
    }).catch(e => {
      job.status = 'error';
      job.error = String(e?.message || e);
      log(`${this._t('Ошибка', 'Error')}: ${job.error}`);
    });
    return job;
  }

  async close() {
    await this._options.mcp?.close();
    await closeLocatorLab();
  }

  /** Waits for a job started with start(); used by `pw-extended-report analyze`. */
  async wait(job: JobState): Promise<JobState> {
    while (job.status === 'running')
      await new Promise(r => setTimeout(r, 200));
    return job;
  }

  private _t(ru: string, en: string): string {
    return this._lang === 'ru' ? ru : en;
  }

  private async _run(request: JobRequest, job: JobState, log: (text: string) => void) {
    if (!request.test?.results?.length)
      throw new Error(this._t('нет данных теста', 'test data is missing'));
    switch (request.kind) {
      case 'apply': return this._apply(request, job, log);
      case 'revert': return this._revert(request, job, log);
    }

    const t = this._t.bind(this);
    const attempt = request.attempt ?? lastFailedAttempt(request.test);
    log(t('Читаю трейс…', 'Reading the trace…'));
    const trace = await this._loadTrace(request).catch(e => {
      log(`${t('Трейс недоступен', 'Trace not available')}: ${e.message}`);
      return undefined;
    });
    if (trace)
      log(t(`Трейс: ${trace.actions.length} действий, ${trace.requests.length} запросов, ${trace.console.length} ошибок консоли${trace.dom ? `, DOM в момент падения (${trace.dom.elements.length} элементов)` : ''}.`, `Trace: ${trace.actions.length} actions, ${trace.requests.length} requests, ${trace.console.length} console errors${trace.dom ? `, DOM at failure (${trace.dom.elements.length} elements)` : ''}.`));

    if (request.kind === 'lab') {
      if (!trace?.dom)
        throw new Error(t('в трейсе нет снимка страницы на момент падения', 'the trace has no page snapshot at failure'));
      log(t('Проверяю локаторы на странице в момент падения…', 'Checking locators on the page at failure…'));
      const lab = await runLocatorLab(trace.dom.html, request.locators ?? [], { fromDirs: this._labDirs() });
      job.result = { lab, markdown: describeLab(lab, this._lang) };
      log(t('Готово.', 'Done.'));
      return;
    }

    const sources = this._collectSources(request.test, trace, request.group?.tests ?? []);
    if (sources.length)
      log(`${t('Исходники', 'Source files')}: ${sources.map(s => s.path).join(', ')}${sources.some(s => s.inRepo) ? '' : t(' (из трейса)', ' (from the trace)')}.`);

    let rerun: RunResult | undefined;
    let rerunTrace: TraceData | undefined;
    if (request.kind === 'debug') {
      const repo = this._options.repo;
      if (!repo || !this._canRun)
        throw new Error(t('Для «Run & debug» нужен репозиторий тестов: откройте отчёт командой `pw-extended-report agent` в репозитории.', 'Run & debug needs the tests repository: open the report with `pw-extended-report agent` inside the repo.'));
      log(t('Запускаю тест локально (без ретраев, с трейсом)…', 'Running the test locally (no retries, trace on)…'));
      [rerun] = (await runTests(repo, [testRef(request.test)], log)).tests;
      log(`${t('Локальный запуск', 'Local run')}: ${rerun.status}${rerun.durationMs !== undefined ? ` ${t('за', 'in')} ${Math.round(rerun.durationMs)}ms` : ''}.`);
      if (rerun.status === 'error' || rerun.status === 'not-found')
        log(rerun.output.split('\n').slice(-8).join('\n'));
      if (rerun.tracePath)
        rerunTrace = await readTrace(rerun.tracePath).catch(() => undefined);
      job.result = { rerun: { status: rerun.status, error: rerun.error, durationMs: rerun.durationMs } };
    }

    // Locator lab on the DOM at failure: the failing locator and the closest candidates.
    let lab: LabResult[] | undefined;
    const preliminary = buildEvidence({ lang: this._lang, test: request.test, attempt, trace }, 1_000_000);
    if (trace?.dom && !trace.dom.isBlank && (preliminary.failingLocator || preliminary.candidates.length)) {
      const locators = [preliminary.failingLocator ? normalizeLocator(preliminary.failingLocator) : '', ...preliminary.candidates.map(c => c.code)].filter(Boolean);
      try {
        lab = await runLocatorLab(trace.dom.html, locators, { fromDirs: this._labDirs() });
        log(t(`Locator lab: проверено ${lab.length} локаторов на DOM момента падения.`, `Locator lab: ${lab.length} locator(s) checked on the DOM at failure.`));
      } catch (e) {
        log(`Locator lab: ${t('недоступен', 'not available')} (${String(e.message || e).split('\n')[0].slice(0, 160)})`);
      }
    }

    const evidence = buildEvidence({
      lang: this._lang,
      test: request.test,
      attempt,
      insight: request.insight,
      trace,
      lab,
      errorContext: request.errorContext,
      comment: request.comment,
      sources: sources.map(s => ({ path: s.path, content: s.content, focusLine: s.focusLine })),
      rerun: rerun ? { status: rerun.status, error: rerun.error, durationMs: rerun.durationMs, trace: rerunTrace, output: rerun.output } : undefined,
    }, this._options.llm.maxContextChars);
    if (evidence.candidates.length)
      log(t(`Найдено элементов, похожих на упавший локатор: ${evidence.candidates.length}.`, `Found ${evidence.candidates.length} element(s) similar to the failing locator.`));
    if (evidence.truncated)
      log(t('Доказательства обрезаны под контекст модели (EXTENDED_REPORT_AI_MAX_CHARS).', 'Evidence was trimmed to fit the model context (EXTENDED_REPORT_AI_MAX_CHARS).'));
    const groupSummary = request.group?.tests.length ? this._groupSummary(request.group) : undefined;
    if (groupSummary)
      log(t(`Группа: ещё ${request.group!.tests.length} тест(ов) с той же ошибкой.`, `Group: ${request.group!.tests.length} more test(s) with the same error.`));

    if (request.kind === 'fix')
      return this._fix(request, job, log, evidence, sources, trace, groupSummary);

    const userPrompt = groupSummary ? clusterPrompt(this._lang, evidence.markdown, groupSummary) : request.kind === 'debug' ? debugPrompt(this._lang, evidence.markdown) : analyzePrompt(this._lang, evidence.markdown);
    const answer = await this._ask(request, log, userPrompt, trace, sources, () => mockAnalysis(this._lang, request, evidence, rerun, lab));
    log(t('Готово.', 'Done.'));
    job.result = { ...job.result, markdown: answer.content, evidence: evidence.markdown, prompt: userPrompt, model: answer.model, path: answer.path, toolCalls: answer.toolCalls, lab };
  }

  /** MCP-assisted path first (when tools are available), then the simple path. */
  private async _ask(request: JobRequest, log: (text: string) => void, userPrompt: string, trace: TraceData | undefined, sources: SourceFile[], mock: () => string, previous: ChatMessage[] = []): Promise<{ content: string, model: string, path: 'mcp' | 'simple', toolCalls?: { name: string, ok: boolean }[] }> {
    const t = this._t.bind(this);
    const llm = this._options.llm;
    const tools = request.useTools === false || llm.provider === 'mock' || /^(0|off|false)$/i.test(process.env.EXTENDED_REPORT_AI_TOOLS || '') ? [] : await this._tools(log, trace, sources);
    if (tools.some(tool => !tool.name.startsWith('agent__'))) {
      log(t(`Спрашиваю модель с MCP-инструментами (${describeLlm(llm)}, инструментов: ${tools.length})…`, `Asking the model with MCP tools (${describeLlm(llm)}, ${tools.length} tools)…`));
      try {
        const result = await runToolLoop({ llm, lang: this._lang, system: systemPrompt(this._lang), user: userPrompt + toolsGuide(this._lang, tools.map(tool => tool.name)), tools, log });
        log(t(`MCP-путь: вызовов инструментов — ${result.toolCalls.length}.`, `MCP path: ${result.toolCalls.length} tool call(s).`));
        return { content: result.content, model: result.model, path: 'mcp', toolCalls: result.toolCalls.map(c => ({ name: c.name, ok: c.ok })) };
      } catch (e) {
        log(t(`MCP-путь не сработал (${String(e.message || e).slice(0, 200)}). Перехожу на простой путь.`, `MCP path failed (${String(e.message || e).slice(0, 200)}). Falling back to the simple path.`));
      }
    }
    log(t(`Спрашиваю модель (${describeLlm(llm)})…`, `Asking the model (${describeLlm(llm)})…`));
    const answer = await chat(llm, [{ role: 'system', content: systemPrompt(this._lang) }, ...previous, { role: 'user', content: userPrompt }], mock);
    return { content: answer.content, model: answer.model, path: 'simple' };
  }

  private async _tools(log: (text: string) => void, trace: TraceData | undefined, sources: SourceFile[]): Promise<AgentTool[]> {
    const hub = this._options.mcp;
    if (!hub?.configured)
      return [];
    const mcpTools = await hub.tools(log);
    if (!mcpTools.length)
      return [];
    const tools: AgentTool[] = mcpTools.map(tool => ({
      name: tool.wireName,
      description: `[${tool.server}] ${tool.description}`,
      parameters: tool.inputSchema,
      call: args => hub.call(tool, args),
    }));
    if (trace?.dom && !trace.dom.isBlank) {
      tools.push({
        name: 'agent__locator_lab',
        description: 'Check Playwright locators on the page as it was at the moment of failure. Returns the number of matched elements, visibility and text for each. Use plain chains like page.getByRole(\'button\', { name: \'Buy\' }).',
        parameters: { type: 'object', properties: { locators: { type: 'array', items: { type: 'string' } } }, required: ['locators'] },
        call: async args => describeLab(await runLocatorLab(trace.dom!.html, Array.isArray(args.locators) ? args.locators : [String(args.locators ?? '')], { fromDirs: this._labDirs() }), this._lang),
      });
    }
    tools.push({
      name: 'agent__read_source',
      description: 'Read a source file of the tests repository (or of the trace when there is no repository). Optional 1-based line range.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' } }, required: ['path'] },
      call: async args => {
        const repo = this._options.repo;
        const found = repo?.find(String(args.path));
        const content = found ? repo!.read(found) : sources.find(s => s.path.endsWith(String(args.path)) || String(args.path).endsWith(s.path))?.content;
        if (content === undefined)
          throw new Error(`file not found: ${args.path}`);
        const lines = content.split('\n');
        const from = Math.max(1, Number(args.from) || 1);
        const to = Math.min(lines.length, Number(args.to) || from + 199);
        return lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n');
      },
    });
    return tools;
  }

  private async _fix(request: JobRequest, job: JobState, log: (text: string) => void, evidence: Evidence, sources: SourceFile[], trace: TraceData | undefined, groupSummary?: string) {
    const t = this._t.bind(this);
    if (!sources.length)
      throw new Error(t('Нет исходного кода: ни в репозитории, ни в трейсе нет файла теста.', 'No source code available: neither the repository nor the trace contains the test file.'));
    const files = new Map(sources.map(s => [s.path, s.content]));
    const userPrompt = fixPrompt(this._lang, evidence.markdown, sources.map(s => ({ path: s.path, content: s.content })), request.analysis, request.previousFixError, groupSummary);
    const mock = () => mockFix(this._lang, evidence, sources, request.group?.tests ?? []);
    let answer = await this._ask(request, log, userPrompt, trace, sources, mock);
    let { edits, problems } = applyEditBlocks(parseEditBlocks(answer.content), files);
    if (!edits.length && answer.path === 'mcp') {
      log(t('Ответ с MCP не содержит применимой правки. Повторяю простым путём…', 'The MCP answer has no applicable edit. Retrying with the simple path…'));
      answer = await this._ask({ ...request, useTools: false }, log, userPrompt, trace, sources, mock);
      ({ edits, problems } = applyEditBlocks(parseEditBlocks(answer.content), files));
    }
    if (!edits.length && problems.length) {
      log(t(`Правка не совпала с файлом (проблем: ${problems.length}); прошу модель исправить…`, `The proposed edit did not match the file (${problems.length} problem(s)); asking the model to correct it…`));
      answer = await this._ask({ ...request, useTools: false }, log, fixRetryMessage(this._lang, problems), trace, sources, mock, [{ role: 'user', content: userPrompt }, { role: 'assistant', content: answer.content }]);
      ({ edits, problems } = applyEditBlocks(parseEditBlocks(answer.content), files));
    }
    const explanation = answer.content.replace(/FILE:[\s\S]*?>{5,9} ?REPLACE/g, '').replace(/```[\w-]*\s*```/g, '').trim();
    const canRun = this._canRun;

    // Check the locators the fix introduces before anyone applies it.
    let lab: LabResult[] | undefined;
    const introduced = edits.flatMap(e => extractLocators(e.newContent).filter(l => !e.oldContent.includes(l)));
    if (introduced.length && trace?.dom && !trace.dom.isBlank) {
      try {
        lab = await runLocatorLab(trace.dom.html, introduced, { fromDirs: this._labDirs() });
        log(t(`Locator lab: проверены локаторы из правки (${lab.filter(r => r.ok).length} из ${lab.length} находят ровно 1 элемент).`, `Locator lab: locators of the fix checked (${lab.filter(r => r.ok).length} of ${lab.length} match exactly 1 element).`));
      } catch (e) {
        log(`Locator lab: ${t('недоступен', 'not available')} (${String(e.message || e).split('\n')[0].slice(0, 160)})`);
      }
    }

    const stored: StoredFix = {
      proposal: {
        id: crypto.randomUUID(),
        explanation,
        files: edits.map(e => ({ file: e.file, diff: e.diff, inRepo: !!sources.find(s => s.path === e.file)?.inRepo })),
        canApply: canRun && edits.length > 0 && edits.every(e => sources.find(s => s.path === e.file)?.inRepo),
        lab,
      },
      edits: edits.map(e => ({ file: e.file, oldContent: e.oldContent, newContent: e.newContent, inRepo: !!sources.find(s => s.path === e.file)?.inRepo })),
      tests: [request.test, ...(request.group?.tests ?? [])],
    };
    this._fixes.set(stored.proposal.id, stored);
    if (problems.length)
      log(`${t('Часть правок не применима', 'Some edits could not be applied')}:\n${problems.join('\n')}`);
    log(edits.length ? t(`Предложены изменения в файлах: ${edits.length}.`, `Proposed changes in ${edits.length} file(s).`) : t('Модель не предложила применимой правки.', 'The model did not produce an applicable change.'));
    job.result = { markdown: explanation, evidence: evidence.markdown, prompt: userPrompt, model: answer.model, path: answer.path, fix: stored.proposal };
  }

  private async _apply(request: JobRequest, job: JobState, log: (text: string) => void) {
    const t = this._t.bind(this);
    const repo = this._options.repo;
    const stored = request.fixId ? this._fixes.get(request.fixId) : undefined;
    if (!repo || !this._canRun || !stored)
      throw new Error(!repo || !this._canRun ? t('Применять правки можно только в режиме `pw-extended-report agent` в репозитории тестов.', 'Applying fixes needs the tests repository (`pw-extended-report agent`).') : t('Предложение правки не найдено (агент перезапускался?). Предложите правку заново.', 'Fix proposal not found (the agent was restarted?). Propose the fix again.'));
    if (!stored.proposal.canApply)
      throw new Error(t('Правка затрагивает файлы вне репозитория.', 'This fix references files that are not in the repository.'));
    for (const edit of stored.edits) {
      if (repo.read(edit.file) !== edit.oldContent)
        throw new Error(t(`${edit.file} изменился после предложения правки. Предложите правку заново.`, `${edit.file} changed since the fix was proposed. Propose the fix again.`));
    }
    const backupDir = path.join(repo.dir, '.pw-extended-report', 'backups', stored.proposal.id);
    fs.mkdirSync(backupDir, { recursive: true });
    for (const edit of stored.edits) {
      // .bak so that test runners never pick the backups up.
      fs.writeFileSync(path.join(backupDir, edit.file.replace(/[\\/]/g, '__') + '.bak'), edit.oldContent);
      repo.write(edit.file, edit.newContent);
      log(t(`Изменён ${edit.file} (резервная копия в .pw-extended-report/backups).`, `Changed ${edit.file} (backup in .pw-extended-report/backups).`));
    }
    stored.proposal.applied = true;
    stored.proposal.reverted = false;
    log(stored.tests.length > 1 ? t(`Проверка: запускаю тесты группы (${stored.tests.length})…`, `Verifying: running the ${stored.tests.length} tests of the group…`) : t('Проверка: запускаю тест…', 'Verifying: running the test…'));
    const results = (await runTests(repo, stored.tests.map(testRef), log)).tests;
    const passed = results.filter(r => r.status === 'passed').length;
    const failedResult = results.find(r => r.status !== 'passed');
    stored.proposal.verify = {
      status: passed === results.length ? 'passed' : failedResult?.status ?? 'failed',
      error: failedResult?.error,
      durationMs: results.reduce((a, r) => a + (r.durationMs ?? 0), 0),
      tests: stored.tests.length > 1 ? stored.tests.map((tc, i) => ({ title: [...tc.path, tc.title].join(' › '), status: results[i].status })) : undefined,
    };
    log(passed === results.length
      ? t(results.length > 1 ? `Все ${results.length} тестов проходят с правкой.` : 'Тест проходит с правкой.', results.length > 1 ? `All ${results.length} tests pass with the fix.` : 'The test passes with the fix.')
      : t(`Не прошло: ${results.length - passed} из ${results.length}. Можно откатить или запросить другую правку.`, `Still failing: ${results.length - passed} of ${results.length}. You can revert or ask for another fix.`));
    job.result = { fix: stored.proposal };
  }

  private async _revert(request: JobRequest, job: JobState, log: (text: string) => void) {
    const t = this._t.bind(this);
    const repo = this._options.repo;
    const stored = request.fixId ? this._fixes.get(request.fixId) : undefined;
    if (!repo || !stored?.proposal.applied)
      throw new Error(t('Нечего откатывать.', 'Nothing to revert.'));
    for (const edit of stored.edits) {
      if (repo.read(edit.file) === edit.newContent) {
        repo.write(edit.file, edit.oldContent);
        log(t(`Откачен ${edit.file}.`, `Reverted ${edit.file}.`));
      } else {
        log(t(`${edit.file} менялся после правки; не откачен (копия в .pw-extended-report/backups/${stored.proposal.id}).`, `${edit.file} was changed after the fix; not reverted (backup in .pw-extended-report/backups/${stored.proposal.id}).`));
      }
    }
    stored.proposal.applied = false;
    stored.proposal.reverted = true;
    job.result = { fix: stored.proposal };
  }

  private _groupSummary(group: NonNullable<JobRequest['group']>): string {
    return group.tests.map((tc, i) => {
      const insight = group.insights?.[i];
      const error = (insight?.error ?? tc.results[tc.results.length - 1]?.errors[0]?.message ?? '').replace(/\u001b\[[0-9;]*m/g, '');
      const locator = error.match(/^Locator: (.+)$/m)?.[1];
      return `- ${[...tc.path, tc.title].join(' › ')} (${tc.location.file}:${tc.location.line}${tc.projectName ? `, ${tc.projectName}` : ''})${locator ? ` — locator: ${locator}` : ''}: ${error.split('\n').find(l => l.trim()) ?? ''}`;
    }).join('\n');
  }

  private _labDirs(): string[] {
    return [this._options.repo?.dir, this._options.reportDir].filter(Boolean) as string[];
  }

  private async _loadTrace(request: JobRequest): Promise<TraceData | undefined> {
    if (request.tracePath && this._options.reportDir) {
      const file = path.resolve(this._options.reportDir, request.tracePath.replace(/^\.?\//, ''));
      if (!file.startsWith(path.resolve(this._options.reportDir) + path.sep))
        throw new Error('trace path outside of the report');
      if (fs.existsSync(file))
        return readTrace(file);
    }
    if (request.traceBase64)
      return readTrace(Buffer.from(request.traceBase64, 'base64'));
    return undefined;
  }

  /** Test file + page objects from the failing stack (+ files of the other group tests): from the repo when available, else from the trace. */
  private _collectSources(test: ReportTestCase, trace: TraceData | undefined, others: ReportTestCase[]): SourceFile[] {
    const repo = this._options.repo;
    const failingStep = trace ? [...trace.steps].reverse().find(s => s.error && s.stack.length) : undefined;
    const focus = new Map<string, number>();
    for (const frame of failingStep?.stack ?? []) {
      if (!focus.has(frame.file))
        focus.set(frame.file, frame.line);
    }
    const candidates = [...(failingStep?.stack.map(f => f.file) ?? []), ...(trace?.sourcePaths ?? [])];
    const unique = [...new Set(candidates)].filter(f => !/node_modules|playwright\.config/.test(f)).slice(0, 4);
    if (!unique.length)
      unique.push(test.location.file);

    const result: SourceFile[] = [];
    const add = (file: string, focusLine: number | undefined) => {
      const inRepo = repo?.find(file);
      if (repo && inRepo) {
        if (!result.some(r => r.path === inRepo))
          result.push({ path: inRepo, content: repo.read(inRepo), focusLine, inRepo: true });
        return;
      }
      const fromTrace = sourceForPath(trace, file);
      const label = displayPath(file, test.location.file);
      if (fromTrace !== undefined && !result.some(r => r.path === label))
        result.push({ path: label, content: fromTrace, focusLine, inRepo: false });
    };
    for (const file of unique)
      add(file, focus.get(file) ?? (file.endsWith(test.location.file) ? test.location.line : undefined));
    for (const other of others.slice(0, 10)) {
      if (repo)
        add(other.location.file, other.location.line);
    }
    return result.slice(0, 6);
  }

  private async _openInIde(body: { file?: string, line?: number, column?: number, ide?: string }): Promise<{ ok: boolean, command?: string, error?: string }> {
    const repo = this._options.repo;
    if (!repo)
      return { ok: false, error: this._t('нужен локальный агент с репозиторием (`pw-extended-report agent`)', 'needs the local agent with a repository (`pw-extended-report agent`)') };
    const relative = body.file ? repo.find(body.file) : undefined;
    if (!relative)
      return { ok: false, error: this._t(`файл не найден в репозитории: ${body.file}`, `file not found in the repository: ${body.file}`) };
    const file = repo.absolute(relative);
    const line = Math.max(1, Number(body.line) || 1);
    const column = Math.max(1, Number(body.column) || 1);
    const template = process.env.EXTENDED_REPORT_IDE_COMMAND || kIdeCommands[body.ide ?? ''];
    if (!template)
      return { ok: false, error: this._t('IDE не выбрана: укажите её в настройках отчёта (⚙) или в EXTENDED_REPORT_IDE_COMMAND', 'no IDE selected: choose it in the report settings (⚙) or set EXTENDED_REPORT_IDE_COMMAND') };
    const argv = splitCommand(template).map(a => a.replace('{file}', file).replace('{line}', String(line)).replace('{column}', String(column)));
    const run = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', reject);
      child.on('spawn', () => {
        child.unref();
        resolve();
      });
    });
    try {
      await run(argv[0], argv.slice(1));
      return { ok: true, command: argv.join(' ') };
    } catch (e) {
      // macOS without command-line launchers: open the application bundle instead.
      const app = kMacApps[body.ide ?? ''];
      if (process.platform === 'darwin' && app && e.code === 'ENOENT') {
        const args = ['-na', app, '--args', '--line', String(line), file];
        try {
          await run('open', args);
          return { ok: true, command: `open ${args.join(' ')}` };
        } catch {
        }
      }
      return { ok: false, command: argv.join(' '), error: String(e.message || e) };
    }
  }
}

/** Command-line launchers. JetBrains IDEs: Tools → Create Command-line Launcher (or Toolbox shell scripts). */
const kIdeCommands: Record<string, string> = {
  'idea': 'idea --line {line} --column {column} {file}',
  'webstorm': 'webstorm --line {line} --column {column} {file}',
  'pycharm': 'pycharm --line {line} --column {column} {file}',
  'gigaide': 'gigaide --line {line} --column {column} {file}',
  'vscode': 'code -g {file}:{line}:{column}',
  'cursor': 'cursor -g {file}:{line}:{column}',
};

const kMacApps: Record<string, string> = {
  idea: 'IntelliJ IDEA',
  webstorm: 'WebStorm',
  pycharm: 'PyCharm',
  gigaide: 'GigaIDE',
};

function splitCommand(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(part => part.replace(/^["']|["']$/g, ''));
}

function testRef(test: ReportTestCase) {
  return { file: test.location.file, line: test.location.line, projectName: test.projectName };
}

function displayPath(absolute: string, testRelative: string): string {
  const normalized = absolute.replace(/\\/g, '/');
  if (normalized.endsWith('/' + testRelative))
    return testRelative;
  return normalized.split('/').slice(-3).join('/');
}

function lastFailedAttempt(test: ReportTestCase): number {
  for (let i = test.results.length - 1; i >= 0; i--) {
    if (test.results[i].status !== 'passed' && test.results[i].status !== 'skipped')
      return i;
  }
  return test.results.length - 1;
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 120 * 1024 * 1024) {
        reject(new Error('request too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    request.on('error', reject);
  });
}

// ---------- mock answers (demo / tests): built from the evidence, clearly labelled ----------

const kKindVerdict: Record<Lang, Record<string, string>> = {
  ru: { 'product-bug': 'БАГ ПРОДУКТА', 'test-bug': 'ОШИБКА ТЕСТА', 'environment': 'ОКРУЖЕНИЕ', 'ui-change': 'ИЗМЕНЕНИЕ UI', 'flaky': 'НЕСТАБИЛЬНЫЙ ТЕСТ', 'unknown': 'НЕ ОПРЕДЕЛЕНО' },
  en: { 'product-bug': 'PRODUCT BUG', 'test-bug': 'TEST BUG', 'environment': 'ENVIRONMENT', 'ui-change': 'UI CHANGE', 'flaky': 'FLAKY', 'unknown': 'UNKNOWN' },
};

function mockAnalysis(lang: Lang, request: JobRequest, evidence: Evidence, rerun: RunResult | undefined, lab: LabResult[] | undefined): string {
  const ru = lang === 'ru';
  const c = request.insight?.classification;
  const verdict = kKindVerdict[lang][c?.kind ?? 'unknown'];
  const confidence = { high: ru ? 'высокая' : 'high', medium: ru ? 'средняя' : 'medium', low: ru ? 'низкая' : 'low' }[c?.confidence ?? 'low'];
  const lines = [
    ru ? '> **Шаблонный ответ** — модель не подключена (`--ai-mock`). Структура и доказательства настоящие, рассуждение — шаблон.' : '> **Mock answer** — no model configured (`--ai-mock`). The structure and the evidence are real; the reasoning is a template.',
    '',
    ru ? '## Вердикт' : '## Verdict',
    `**${verdict}** — ${c?.reason ?? (ru ? 'см. доказательства' : 'see evidence')} ${ru ? 'Уверенность' : 'Confidence'}: ${confidence}.`,
  ];
  if (request.group?.tests.length)
    lines.push('', ru ? `Та же ошибка ещё в ${request.group.tests.length} тест(ах) группы — вероятно, одна общая причина.` : `The same error in ${request.group.tests.length} more test(s) of the group — most likely one common cause.`);
  if (request.comment)
    lines.push('', `${ru ? 'Подсказка инженера учтена' : 'Engineer\'s hint taken into account'}: _${request.comment}_`);
  if (rerun) {
    lines.push('', ru ? '## Результат перезапуска' : '## Re-run result', ru
      ? `Тест перезапущен локально: **${rerun.status}**.${rerun.status === 'passed' ? ' Падение не воспроизвелось: вероятно окружение, данные или тайминги.' : ' Падение воспроизводится.'}`
      : `The test was re-run locally: **${rerun.status}**.${rerun.status === 'passed' ? ' The failure did not reproduce: suspect environment, data or timing.' : ' The failure reproduces.'}`);
  }
  lines.push('', ru ? '## Что произошло' : '## What happened', evidence.failingLocator ? (ru ? `Тест ждал \`${evidence.failingLocator}\`, и он так и не нашёлся.` : `The test waited for \`${evidence.failingLocator}\` and it never matched.`) : (ru ? 'См. ошибку ниже.' : 'See the error below.'));
  const good = lab?.find(r => r.ok && r.locator !== normalizeLocator(evidence.failingLocator ?? ''));
  if (evidence.candidates.length) {
    lines.push('', ru ? '## Доказательства' : '## Evidence', ru ? 'Элементы на странице в момент падения, похожие на искомый:' : 'Elements present on the page at the moment of failure that look like the target:', ...evidence.candidates.map(cand => `- \`${cand.element}\` (${cand.reason})`));
    if (lab?.length)
      lines.push('', ru ? 'Проверка в Locator lab:' : 'Locator lab check:', describeLab(lab, lang));
    lines.push('', ru ? '## Как исправить' : '## How to fix', ru ? `Обновить локатор, например \`${good?.locator ?? evidence.candidates[0].code}\`.` : `Update the locator, e.g. \`${good?.locator ?? evidence.candidates[0].code}\`.`);
  } else {
    lines.push('', ru ? '## Как исправить' : '## How to fix', ru ? 'Откройте трейс на упавшем шаге и сравните ожидаемое состояние с DOM.' : 'Open the trace at the failing step and compare the expected state with the DOM.');
  }
  lines.push('', ru ? '## Как проверить' : '## How to verify', '`npx playwright test <file>:<line> --retries=0 --trace=on`');
  return lines.join('\n');
}

function mockFix(lang: Lang, evidence: Evidence, files: SourceFile[], groupTests: ReportTestCase[]): string {
  const ru = lang === 'ru';
  const candidate = evidence.candidates[0];
  const locator = evidence.failingLocator;
  if (candidate && locator) {
    const blocks: string[] = [];
    for (const file of files) {
      const lines = file.content.split('\n');
      const matches = (l: string) => l.includes(locator) || l.includes(locator.replace(/'/g, '"'));
      // A group fix touches every line with the locator; a single fix only the failing one.
      const targets = groupTests.length ? lines.filter(matches) : [file.focusLine !== undefined && lines[file.focusLine - 1] && matches(lines[file.focusLine - 1]) ? lines[file.focusLine - 1] : lines.find(matches)].filter(Boolean) as string[];
      for (const line of [...new Set(targets)]) {
        const replacement = line.replace(new RegExp(`(page\\.)?${escapeRegExp(locator)}`), candidate.code);
        blocks.push([`FILE: ${file.path}`, '<<<<<<< SEARCH', line, '=======', replacement, '>>>>>>> REPLACE'].join('\n'));
      }
      if (blocks.length && !groupTests.length)
        break;
    }
    if (blocks.length) {
      return [
        ru ? '## Объяснение' : '## Explanation',
        ru
          ? `**Шаблонная правка** (модель не подключена): \`${locator}\` нет на странице; ближайший элемент — \`${candidate.element}\`, поэтому локатор заменён на \`${candidate.code}\`.`
          : `**Mock fix** (no model configured): \`${locator}\` is not on the page; the closest element is \`${candidate.element}\`, so the locator is replaced with \`${candidate.code}\`.`,
        '',
        ...blocks,
      ].join('\n');
    }
  }
  return ru ? '## Объяснение\n**Шаблонная правка**: безопасного автоматического изменения не найдено (на странице нет похожего элемента).' : '## Explanation\n**Mock fix**: no safe automatic change found for this failure (no similar element on the page).';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
