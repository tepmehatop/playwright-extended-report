/**
 * `pw-extended-report analyze`: AI analysis prepared in CI, right after the run, so the report
 * opens with the answers already in place (no waiting for the model, works without a backend).
 *
 * For every error group (largest first) the agent analyzes one representative test with the full
 * evidence (trace, DOM at failure, locator lab, sources) plus a short list of the other tests of the
 * group — one model request per group. Results are written into the report:
 *  - Insights: shown in the group card and in "Ask AI" of every test of the group (marked "from CI"),
 *  - Failure analysis: a section with all group analyses.
 */

import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';

import { readTabs, writeTabs } from '../tabs';
import { readZip } from './trace';

import type { AgentService, JobRequest, JobState } from './service';
import type { ReportTestCase } from './evidence';
import type { InsightsData, PrecomputedAnalysis } from '../shared/insightsFormat';

export type AnalyzeOptions = {
  /** Local agent (same process). */
  agent?: AgentService;
  /** Or a remote agent backend, e.g. http://agent-vm:8787/ */
  agentUrl?: string;
  /** Groups to analyze, largest first. Default: 10. */
  max?: number;
  /** "groups" (default) or "tests": one request per failed test. */
  scope?: 'groups' | 'tests';
  log: (text: string) => void;
};

const kTemplateOpen = '<template id="playwrightReportBase64">data:application/zip;base64,';

/** Reads the report's own data (report.json + <fileId>.json with full test cases). */
export async function readReportTestCases(reportDir: string): Promise<Map<string, ReportTestCase>> {
  const html = fs.readFileSync(path.join(reportDir, 'index.html'));
  const start = html.indexOf(kTemplateOpen);
  if (start === -1)
    throw new Error('not a Playwright HTML report');
  const end = html.indexOf('</template>', start);
  const zip = Buffer.from(html.subarray(start + kTemplateOpen.length, end).toString('latin1'), 'base64');
  const entries = await readZip(zip, name => name.endsWith('.json') && name !== 'report.json');
  const tests = new Map<string, ReportTestCase>();
  for (const text of entries.values()) {
    for (const test of JSON.parse(text).tests ?? [])
      tests.set(test.testId, test);
  }
  return tests;
}

export async function analyzeReport(reportDir: string, options: AnalyzeOptions): Promise<{ analyzed: number, failed: number }> {
  const { log } = options;
  const tabs = await readTabs(reportDir);
  const insightsTab = tabs.find(t => t.format === 'insights');
  if (!insightsTab)
    throw new Error('the report has no Insights tab (insights: false in the reporter options?)');
  const data = JSON.parse(insightsTab.content) as InsightsData;
  const ru = (data.language ?? 'ru') === 'ru';
  const testCases = await readReportTestCases(reportDir);
  const insightOf = (id: string) => data.tests.find(t => t.testId === id);

  type Target = { key: string, test: ReportTestCase, group?: JobRequest['group'], save: (a: PrecomputedAnalysis) => void, title: string };
  const targets: Target[] = [];
  if ((options.scope ?? 'groups') === 'groups') {
    for (const cluster of data.clusters ?? []) {
      const tests = cluster.testIds.map(id => testCases.get(id)).filter(Boolean) as ReportTestCase[];
      if (!tests.length)
        continue;
      const [first, ...others] = tests;
      targets.push({
        key: `group ${cluster.id}`,
        title: cluster.title,
        test: first,
        group: others.length ? { id: cluster.id, title: cluster.title, tests: others, insights: others.map(t => insightOf(t.testId)!).filter(Boolean) } : undefined,
        save: a => cluster.ai = a,
      });
    }
  } else {
    for (const insight of data.tests) {
      const test = testCases.get(insight.testId);
      if (test)
        targets.push({ key: insight.testId, title: [...insight.titlePath].join(' › '), test, save: a => insight.ai = a });
    }
  }

  const max = options.max ?? 10;
  let analyzed = 0;
  let failed = 0;
  for (const target of targets.slice(0, max)) {
    log(`${ru ? 'Разбираю' : 'Analyzing'} ${target.key}: ${target.title}`);
    const result = target.test.results;
    const attempt = lastFailedAttempt(target.test);
    const trace = result[attempt]?.attachments.find(a => a.name === 'trace' && a.path);
    const request: JobRequest = { kind: 'analyze', test: target.test, attempt, insight: insightOf(target.test.testId), tracePath: trace?.path, group: target.group };
    try {
      const job = options.agentUrl ? await remoteJob(options.agentUrl, request, reportDir) : await options.agent!.wait(options.agent!.start(request));
      if (job.status !== 'done' || !job.result?.markdown)
        throw new Error(job.error || 'no answer');
      target.save({ markdown: job.result.markdown, model: job.result.model, generatedAt: new Date().toISOString(), evidence: job.result.evidence });
      ++analyzed;
      log(`  ✓ ${job.result.model ?? ''}${job.result.path === 'mcp' ? ' (MCP)' : ''}`);
    } catch (e) {
      ++failed;
      log(`  ✗ ${String(e.message || e).slice(0, 300)}`);
    }
  }
  if (targets.length > max)
    log(ru ? `Разобрано ${max} из ${targets.length}; остальные — кнопкой в отчёте (или --max).` : `Analyzed ${max} of ${targets.length}; the rest on demand in the report (or --max).`);

  insightsTab.content = JSON.stringify(data);
  const failures = tabs.find(t => t.id === 'failures');
  const analyzedClusters = (data.clusters ?? []).filter(c => c.ai);
  if (failures && analyzedClusters.length) {
    const markdown = analyzedClusters.map(c => [
      `### ${c.id}. ${c.title}`,
      '',
      `[${ru ? 'Открыть группу в Insights →' : 'Open the group in Insights →'}](#?tab=insights&group=${c.id})`,
      '',
      c.ai!.markdown.replace(/^## /gm, '#### '),
    ].join('\n')).join('\n\n---\n\n');
    failures.sections = [...(failures.sections ?? []).filter(s => s.id !== 'ai-groups'), {
      id: 'ai-groups',
      title: ru ? 'AI-разбор групп ошибок (подготовлен в CI)' : 'AI analysis of error groups (prepared in CI)',
      format: 'markdown' as const,
      order: 20,
      source: analyzedClusters[0].ai!.model,
      generatedAt: new Date().toISOString(),
      content: markdown,
    }].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  await writeTabs(reportDir, tabs);
  return { analyzed, failed };
}

function lastFailedAttempt(test: ReportTestCase): number {
  for (let i = test.results.length - 1; i >= 0; i--) {
    if (test.results[i].status !== 'passed' && test.results[i].status !== 'skipped')
      return i;
  }
  return test.results.length - 1;
}

async function remoteJob(base: string, request: JobRequest, reportDir: string): Promise<JobState> {
  const body: JobRequest = { ...request };
  if (request.tracePath) {
    const file = path.join(reportDir, request.tracePath);
    if (fs.existsSync(file))
      body.traceBase64 = fs.readFileSync(file).toString('base64');
  }
  const root = base.replace(/\/?$/, '/');
  const { id } = await httpJson('POST', root + 'api/agent/jobs', body);
  while (true) {
    await new Promise(r => setTimeout(r, 1000));
    const job = await httpJson('GET', root + `api/agent/jobs/${id}`) as JobState;
    if (job.status !== 'running')
      return job;
  }
}

function httpJson(method: string, url: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const data = body ? JSON.stringify(body) : undefined;
    const req = (target.protocol === 'https:' ? https : http).request(target, { method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      let text = '';
      res.on('data', d => text += d);
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400)
          reject(new Error(`${res.statusCode}: ${text.slice(0, 300)}`));
        else
          resolve(JSON.parse(text));
      });
    });
    req.on('error', reject);
    if (data)
      req.write(data);
    req.end();
  });
}
