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
 * Port of Playwright's packages/playwright/src/reporters/html.ts
 * (reference copy: upstream/html.ts). Differences, all marked [extended-report]:
 *  - public Reporter API (v1) instead of the internal ReporterV2;
 *  - Playwright-internal helpers replaced by ./compat;
 *  - report UI is taken from this package (dist/web) instead of playwright-core;
 *  - own option names / env vars so it can run side by side with the built-in 'html' reporter;
 *  - extra tabs (failure clusters + user tabs) and report-summary.json.
 * The HtmlBuilder class is kept as close to upstream as possible to ease merges.
 */

import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';

import * as yazl from 'yazl';
import { codeFrameColumns } from '@babel/code-frame';

import { calculateSha1, copyFileAndMakeWritable, extensionForContentType, formatError, formatResultFailure, MultiMap, removeFolders, resolveReporterOutputPath, sanitizeForFilePath, stripAnsiEscapes, toPosixPath } from './compat';
import { clusterFailures, collectFailedTests, renderClustersMarkdown } from './failureClusters';
import { buildInsights } from './insights';
import { encodeTabs, kFailureAnalysisTabId, kSkillSectionId, resolveSectionInput, resolveTabInput } from '../tabs';
import { showReport } from '../server';
import { sortTabs } from '../shared/tabsFormat';

import type { ExtendedTab } from '../shared/tabsFormat';
import type { ExtendedTabInput, ExtendedTabSectionInput } from '../tabs';
import type { ExtendedTabSection } from '../shared/tabsFormat';
import type { FailureCluster, FailedTestInfo } from './failureClusters';
import type { InsightsData } from '../shared/insightsFormat';
import type { HTMLReport, HTMLReportOptions, Location, Stats, TestAttachment, TestCase, TestCaseSummary, TestFile, TestFileSummary, TestResult, TestStep } from '../../web/src/types';
import type { Metadata, TestAnnotation } from '@playwright/test';
import type * as api from '@playwright/test/reporter';
import type { TransformCallback } from 'stream';
import type { ZipFile } from 'yazl';

type TestEntry = {
  testCase: TestCase;
  testCaseSummary: TestCaseSummary
};

type OpenOption = 'always' | 'never' | 'on-failure';
const openOptions: OpenOption[] = ['always', 'never', 'on-failure'];

// [extended-report] options
export type ExtendedReporterOptions = {
  /** Default: "extended-report" next to package.json. Env: EXTENDED_REPORT_OUTPUT_DIR. */
  outputFolder?: string;
  /** Default: "never" (the built-in html reporter usually opens its own report). Env: EXTENDED_REPORT_OPEN. */
  open?: OpenOption;
  host?: string;
  port?: number;
  /** Env: EXTENDED_REPORT_TITLE. */
  title?: string;
  attachmentsBaseURL?: string;
  noSnippets?: boolean;
  noCopyPrompt?: boolean;
  doNotInlineAssets?: boolean;
  mergeFiles?: boolean;
  /** Extra tabs to embed at generation time. Files that do not exist yet can be marked `optional`. */
  tabs?: ExtendedTabInput[];
  /** Language of generated texts (analysis, classification, prompts). Default: "ru". Env: EXTENDED_REPORT_LANGUAGE. */
  language?: 'ru' | 'en';
  /** Built-in "Failure analysis" tab with failed tests grouped by error. Default: true. */
  failureClusters?: boolean | {
    title?: string;
    order?: number;
    /** Intro text (Markdown) at the top of the tab. */
    description?: string;
    /** Extra sections available at generation time, e.g. `{ id: 'skill', title: 'Skill analysis', file: './analysis.md', optional: true }`. */
    sections?: ExtendedTabSectionInput[];
  };
  /** Write report-summary.json (stats, failures, clusters) for LLM / scripts. Default: true. */
  summaryJson?: boolean;
  /**
   * Built-in "Insights" tab: failure classification, run history, network / console errors
   * from traces, retry comparison, "Ask AI" and "Fix" buttons. Default: true.
   */
  insights?: boolean | {
    title?: string;
    order?: number;
    /**
     * Cross-run history (new vs known failures, unstable tests, duration regressions). Off by default:
     * pass `{}` (file: `extended-report-history.json` next to the report folder) or set EXTENDED_REPORT_HISTORY_FILE.
     * The file must be kept between CI builds.
     */
    history?: false | { file?: string, maxRuns?: number };
    /** Read trace.zip of failed tests for network / console errors. Default: true. */
    traces?: boolean;
    /** Base URL of a running `pw-extended-report ai-gateway`, e.g. http://ai-gw:8787/ (docs/AGENT.md). Env: EXTENDED_REPORT_AI_ENDPOINT. */
    aiEndpoint?: string;
    /** URL template for "Fix" with {file} {line} {title} {project} {testId}. Env: EXTENDED_REPORT_FIX_URL. */
    fixUrlTemplate?: string;
  };
  configDir?: string;
};

export type ReportSummary = {
  generatedAt: string;
  title?: string;
  status: api.FullResult['status'];
  startTime: string;
  duration: number;
  stats: { total: number, expected: number, unexpected: number, flaky: number, skipped: number, ok: boolean, failureRate: number };
  projects: string[];
  metadata: Metadata;
  topLevelErrors: string[];
  failedTests: (FailedTestInfo & { clusterId?: number })[];
  clusters: (Omit<FailureCluster, 'tests'> & { testIds: string[] })[];
  insights?: InsightsData;
};

class ExtendedHtmlReporter implements api.Reporter {
  private config!: api.FullConfig;
  private suite!: api.Suite;
  private _options: ExtendedReporterOptions;
  private _outputFolder!: string;
  private _attachmentsBaseURL!: string;
  private _open: OpenOption = 'never';
  private _port: number | undefined;
  private _host: string | undefined;
  private _buildResult: { ok: boolean, singleTestId: string | undefined } | undefined;
  private _topLevelErrors: api.TestError[] = [];

  constructor(options: ExtendedReporterOptions = {}) {
    this._options = options;
  }

  printsToStdio() {
    return false;
  }

  onBegin(config: api.FullConfig, suite: api.Suite) {
    this.config = config;
    const { outputFolder, open, attachmentsBaseURL, host, port } = this._resolveOptions();
    this._outputFolder = outputFolder;
    this._open = open;
    this._host = host;
    this._port = port;
    this._attachmentsBaseURL = attachmentsBaseURL;
    const reportedWarnings = new Set<string>();
    for (const project of this.config.projects) {
      if (this._isSubdirectory(outputFolder, project.outputDir) || this._isSubdirectory(project.outputDir, outputFolder)) {
        const key = outputFolder + '|' + project.outputDir;
        if (reportedWarnings.has(key))
          continue;
        reportedWarnings.add(key);
        writeLine(red(`Configuration Error: extended report output folder clashes with the tests output folder:`));
        writeLine(`
    extended report folder: ${outputFolder}
    test results folder: ${project.outputDir}`);
        writeLine('');
        writeLine(`The extended report will clear its output directory prior to being generated, which will lead to the artifact loss.
`);
      }
    }
    this.suite = suite;
  }

  _resolveOptions(): { outputFolder: string, open: OpenOption, attachmentsBaseURL: string, host: string | undefined, port: number | undefined } {
    const configDir = this._options.configDir ?? this.config?.rootDir ?? process.cwd();
    const envFolder = process.env.EXTENDED_REPORT_OUTPUT_DIR;
    const outputFolder = envFolder ? path.resolve(envFolder) : resolveReporterOutputPath('extended-report', configDir, this._options.outputFolder);
    const envOpen = process.env.EXTENDED_REPORT_OPEN;
    let open: OpenOption = this._options.open || 'never';
    if (envOpen) {
      if (openOptions.includes(envOpen as OpenOption))
        open = envOpen as OpenOption;
      else
        writeLine(red(`Configuration Error: invalid EXTENDED_REPORT_OPEN=${envOpen}. Valid values are: ${openOptions.join(', ')}`));
    }
    return {
      outputFolder,
      open,
      attachmentsBaseURL: process.env.EXTENDED_REPORT_ATTACHMENTS_BASE_URL || this._options.attachmentsBaseURL || 'data/',
      host: process.env.EXTENDED_REPORT_HOST || this._options.host,
      port: process.env.EXTENDED_REPORT_PORT ? +process.env.EXTENDED_REPORT_PORT : this._options.port,
    };
  }

  _isSubdirectory(parentDir: string, dir: string): boolean {
    const relativePath = path.relative(parentDir, dir);
    return !!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
  }

  onError(error: api.TestError): void {
    this._topLevelErrors.push(error);
  }

  async onEnd(result: api.FullResult) {
    const projectSuites = this.suite.suites;
    await removeFolders([this._outputFolder]);
    const noSnippets = parseBooleanEnvVar('EXTENDED_REPORT_NO_SNIPPETS') ?? this._options.noSnippets;
    const noCopyPrompt = parseBooleanEnvVar('EXTENDED_REPORT_NO_COPY_PROMPT') ?? this._options.noCopyPrompt;
    const doNotInlineAssets = parseBooleanEnvVar('EXTENDED_REPORT_DO_NOT_INLINE_ASSETS') ?? this._options.doNotInlineAssets ?? false;
    const mergeFiles = parseBooleanEnvVar('EXTENDED_REPORT_MERGE_FILES') ?? this._options.mergeFiles;

    const builder = new HtmlBuilder(yazl, this.config, this._outputFolder, this._attachmentsBaseURL, doNotInlineAssets, {
      title: process.env.EXTENDED_REPORT_TITLE || this._options.title,
      noSnippets,
      noCopyPrompt,
      mergeFiles,
    });
    // [extended-report] extra tabs + summary are computed before the data is streamed out.
    const { tabs, summary } = await this._buildExtras(result);
    this._buildResult = await builder.build(this.config.metadata, projectSuites, result, this._topLevelErrors, tabs);
    if (summary)
      await fs.promises.writeFile(path.join(this._outputFolder, 'report-summary.json'), JSON.stringify(summary, null, 2));
    writeLine(`Extended report: ${path.relative(process.cwd(), this._outputFolder) || '.'}`);
  }

  // [extended-report]
  private async _buildExtras(result: api.FullResult): Promise<{ tabs: ExtendedTab[], summary?: ReportSummary }> {
    const tabs: ExtendedTab[] = [];
    const lang: 'ru' | 'en' = /^en/i.test(process.env.EXTENDED_REPORT_LANGUAGE || this._options.language || 'ru') ? 'en' : 'ru';
    const failed = collectFailedTests(this.config, this.suite, this.config.rootDir);
    const clusters = clusterFailures(failed);
    const stats = emptyStats();
    for (const test of this.suite.allTests()) {
      const outcome = test.outcome();
      ++stats.total;
      if (outcome === 'expected')
        ++stats.expected;
      else if (outcome === 'unexpected')
        ++stats.unexpected;
      else if (outcome === 'flaky')
        ++stats.flaky;
      else if (outcome === 'skipped')
        ++stats.skipped;
    }

    const clustersOption = this._options.failureClusters ?? true;
    if (clustersOption) {
      const o = typeof clustersOption === 'object' ? clustersOption : {};
      const failedCount = stats.unexpected + stats.flaky;
      const sections: ExtendedTabSection[] = [{
        id: 'auto',
        title: lang === 'ru' ? 'Автоматическая группировка ошибок' : 'Automatic error grouping',
        description: lang === 'ru' ? 'Встроена в отчёт, без AI: упавшие и нестабильные тесты сгруппированы по нормализованной ошибке.' : 'Built-in, no AI: failed and flaky tests grouped by normalized error message.',
        format: 'markdown',
        order: 100,
        source: 'playwright-extended-report',
        generatedAt: new Date().toISOString(),
        content: renderClustersMarkdown(clusters, stats, lang),
      }];
      for (const input of o.sections || []) {
        try {
          const section = await resolveSectionInput(input.file ? { ...input, file: path.resolve(this._options.configDir ?? process.cwd(), input.file) } : input);
          if (section)
            sections.push(section);
        } catch (e) {
          writeLine(red(`Extended report: failed to add section "${input.id}": ${e.message}`));
        }
      }
      tabs.push({
        id: kFailureAnalysisTabId,
        title: o.title || 'Failure analysis',
        icon: 'bug',
        format: 'markdown',
        order: o.order ?? 100,
        badge: failedCount ? clusters.length : undefined,
        badgeKind: stats.unexpected ? 'danger' : 'attention',
        generatedAt: new Date().toISOString(),
        source: 'playwright-extended-report',
        content: o.description ?? kFailureAnalysisIntro[lang],
        sections,
        placeholders: [{
          sectionId: kSkillSectionId,
          title: lang === 'ru' ? 'Анализ скилла' : 'Skill analysis',
          order: 10,
          markdown: lang === 'ru'
            ? 'Анализ от вашего скилла / LLM ещё не добавлен в этот отчёт. Добавьте его после прогона:\n\n```bash\nnpx pw-extended-report add-analysis extended-report --file analysis.md\n```'
            : 'The analysis from your log-analysis skill / LLM has not been added to this report yet. Add it after the run:\n\n```bash\nnpx pw-extended-report add-analysis extended-report --file analysis.md\n```',
        }],
      });
    }

    for (const input of this._options.tabs || []) {
      const resolvedInput = input.file ? { ...input, file: path.resolve(this._options.configDir ?? process.cwd(), input.file) } : input;
      try {
        fs.mkdirSync(this._outputFolder, { recursive: true });
        const tab = await resolveTabInput(this._outputFolder, resolvedInput);
        if (tab)
          tabs.push(tab);
      } catch (e) {
        writeLine(red(`Extended report: failed to add tab "${input.id}": ${e.message}`));
      }
    }

    let insights: InsightsData | undefined;
    const insightsOption = this._options.insights ?? true;
    if (insightsOption) {
      const o = typeof insightsOption === 'object' ? insightsOption : {};
      const historyFile = o.history === false ? false : process.env.EXTENDED_REPORT_HISTORY_FILE
        ? path.resolve(process.env.EXTENDED_REPORT_HISTORY_FILE)
        : !o.history ? false
          : o.history.file ? path.resolve(this._options.configDir ?? process.cwd(), o.history.file)
            : path.join(path.dirname(this._outputFolder), 'extended-report-history.json');
      try {
        const built = await buildInsights(this.suite, this.config.rootDir, result, {
          historyFile,
          maxRuns: (o.history && o.history.maxRuns) || 30,
          runId: process.env.EXTENDED_REPORT_RUN_ID || process.env.BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || result.startTime.toISOString(),
          runUrl: process.env.BUILD_URL,
          traces: o.traces ?? true,
          aiEndpoint: process.env.EXTENDED_REPORT_AI_ENDPOINT || o.aiEndpoint,
          fixUrlTemplate: process.env.EXTENDED_REPORT_FIX_URL || o.fixUrlTemplate,
          lang,
          clusters: clusters.map(c => ({ id: c.id, title: errorTitle(c.sampleError), category: c.category, signature: c.signature, sampleError: c.sampleError.slice(0, 2000), testIds: c.tests.map(t => t.testId), topLocation: c.topLocation })),
          rootDirInRepo: rootDirInRepo(this.config.rootDir),
        });
        insights = built.data;
        if (built.history)
          fs.writeFileSync(path.join(this._outputFolder, 'history.json'), JSON.stringify(built.history));
        const failing = insights.tests.length;
        tabs.push({
          id: 'insights',
          title: o.title || 'Insights',
          icon: 'sparkle',
          format: 'insights',
          order: o.order ?? 50,
          badge: failing || undefined,
          badgeKind: insights.tests.some(t => t.outcome === 'unexpected') ? 'danger' : 'attention',
          description: lang === 'ru' ? 'Классификация падений, сеть и консоль из трейсов, сравнение попыток, история, AI-агент (Ask AI / Fix).' : 'Failure classification, history, network and console errors, retry comparison, Ask AI / Fix.',
          generatedAt: insights.generatedAt,
          source: 'playwright-extended-report',
          content: JSON.stringify(insights),
        });
      } catch (e) {
        writeLine(red(`Extended report: failed to build insights: ${e.stack || e.message}`));
      }
    }

    if (this._options.summaryJson === false)
      return { tabs };

    const executed = stats.total - stats.skipped;
    const clusterOf = new Map<string, number>();
    for (const c of clusters) {
      for (const t of c.tests)
        clusterOf.set(t.testId, c.id);
    }
    const summary: ReportSummary = {
      generatedAt: new Date().toISOString(),
      title: process.env.EXTENDED_REPORT_TITLE || this._options.title,
      status: result.status,
      startTime: result.startTime.toISOString(),
      duration: result.duration,
      stats: { ...stats, ok: stats.unexpected + stats.flaky === 0, failureRate: executed ? +(stats.unexpected / executed).toFixed(4) : 0 },
      projects: this.config.projects.map(p => p.name),
      metadata: this.config.metadata,
      topLevelErrors: this._topLevelErrors.map(e => stripAnsiEscapes(formatError(e).message)),
      failedTests: failed.map(t => ({ ...t, clusterId: clusterOf.get(t.testId) })),
      clusters: clusters.map(({ tests, ...rest }) => ({ ...rest, testIds: tests.map(t => t.testId) })),
      insights,
    };
    return { tabs, summary };
  }

  async onExit() {
    if (process.env.CI || !this._buildResult)
      return;
    const { ok, singleTestId } = this._buildResult;
    const shouldOpen = !!process.stdin.isTTY && (this._open === 'always' || (!ok && this._open === 'on-failure'));
    if (shouldOpen)
      await showReport(this._outputFolder, { host: this._host, port: this._port, testId: singleTestId });
  }
}

const kFailureAnalysisIntro = {
  ru: [
    'Всё, что известно о падениях этого прогона, в одном месте:',
    '',
    '1. **Анализ скилла** — результат вашего скилла анализа логов / LLM (повторяющиеся ошибки в разных тестах, причины, рекомендации). Добавляется после прогона командой `pw-extended-report add-analysis`.',
    '2. **Автоматическая группировка ошибок** — встроена в отчёт, без AI: упавшие и нестабильные тесты сгруппированы по нормализованной ошибке, с долей падений и местом в коде, где ошибка возникает чаще всего. У каждой группы есть ссылка на разбор AI-агентом.',
    '',
    'Классификация каждого теста, сетевые ошибки и консоль из трейсов, AI-агент (Ask AI / Fix) — во вкладке **Insights**.',
  ].join('\n'),
  en: [
    'One place for everything known about the failures of this run:',
    '',
    '1. **Skill analysis** — the output of your log-analysis skill / LLM (repeated errors across tests, root causes, recommendations), added after the run with `pw-extended-report add-analysis`.',
    '2. **Automatic error grouping** — built into the report, no AI: failed and flaky tests grouped by normalized error message, with failure rate and the line that throws most often. Each group links to the AI agent.',
    '',
    'Per-test classification, network / console errors from traces and the AI agent are in the **Insights** tab.',
  ].join('\n'),
};

function parseBooleanEnvVar(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === 'false' || value === '0')
    return false;
  if (value)
    return true;
  return undefined;
}

type DataMap = Map<string, { testFile: TestFile, testFileSummary: TestFileSummary }>;

// [extended-report] the UI bundle shipped with this package.
const kWebFolder = path.join(__dirname, '..', 'web');

class HtmlBuilder {
  private _config: api.FullConfig;
  private _reportFolder: string;
  private _stepsInFile = new MultiMap<string, TestStep>();
  private _dataZipFile: ZipFile;
  private _hasTraces = false;
  private _attachmentsBaseURL: string;
  private _options: HTMLReportOptions;
  private _doNotInlineAssets: boolean;

  constructor(yazl: typeof import('yazl'), config: api.FullConfig, outputDir: string, attachmentsBaseURL: string, doNotInlineAssets: boolean, options: HTMLReportOptions) {
    this._dataZipFile = new yazl.ZipFile();
    this._config = config;
    this._reportFolder = outputDir;
    this._options = options;
    this._doNotInlineAssets = doNotInlineAssets;
    fs.mkdirSync(this._reportFolder, { recursive: true });
    this._attachmentsBaseURL = attachmentsBaseURL;
  }

  async build(metadata: Metadata, projectSuites: api.Suite[], result: api.FullResult, topLevelErrors: api.TestError[], tabs: ExtendedTab[]): Promise<{ ok: boolean, singleTestId: string | undefined }> {
    const data: DataMap = new Map();
    for (const projectSuite of projectSuites) {
      const projectName = projectSuite.project()!.name;
      for (const fileSuite of projectSuite.suites) {
        const fileName = this._relativeLocation(fileSuite.location)!.file;
        this._createEntryForSuite(data, projectName, fileSuite, fileName, true);
      }
    }
    if (!this._options.noSnippets)
      createSnippets(this._stepsInFile);

    let ok = true;
    for (const [fileId, { testFile, testFileSummary }] of data) {
      const stats = testFileSummary.stats;
      for (const test of testFileSummary.tests) {
        if (test.outcome === 'expected')
          ++stats.expected;
        if (test.outcome === 'skipped')
          ++stats.skipped;
        if (test.outcome === 'unexpected')
          ++stats.unexpected;
        if (test.outcome === 'flaky')
          ++stats.flaky;
        ++stats.total;
      }
      stats.ok = stats.unexpected + stats.flaky === 0;
      if (!stats.ok)
        ok = false;

      const testCaseSummaryComparator = (t1: TestCaseSummary, t2: TestCaseSummary) => {
        const w1 = (t1.outcome === 'unexpected' ? 1000 : 0) +  (t1.outcome === 'flaky' ? 1 : 0);
        const w2 = (t2.outcome === 'unexpected' ? 1000 : 0) +  (t2.outcome === 'flaky' ? 1 : 0);
        return w2 - w1;
      };
      testFileSummary.tests.sort(testCaseSummaryComparator);

      this._addDataFile(fileId + '.json', testFile);
    }
    const htmlReport: HTMLReport = {
      metadata,
      startTime: result.startTime.getTime(),
      duration: result.duration,
      files: [...data.values()].map(e => e.testFileSummary),
      projectNames: projectSuites.map(r => r.project()!.name),
      stats: { ...[...data.values()].reduce((a, e) => addStats(a, e.testFileSummary.stats), emptyStats()) },
      errors: topLevelErrors.map(error => formatError(error).message),
      options: this._options,
      // [extended-report] shard timeline needs the internal ReporterV2 API; not available to public reporters.
      machines: [],
    };
    htmlReport.files.sort((f1, f2) => {
      const w1 = f1.stats.unexpected * 1000 + f1.stats.flaky;
      const w2 = f2.stats.unexpected * 1000 + f2.stats.flaky;
      return w2 - w1;
    });

    this._addDataFile('report.json', htmlReport);

    let singleTestId: string | undefined;
    if (htmlReport.stats.total === 1) {
      const testFile: TestFile  = data.values().next().value!.testFile;
      singleTestId = testFile.tests[0].testId;
    }

    const reportIndexFile = await this._writeStaticAssets();

    // Copy trace viewer.
    if (this._hasTraces) {
      // [extended-report] the trace viewer must match the Playwright version that recorded the traces,
      // so it is taken from the project's playwright-core, not bundled.
      const traceViewerFolder = path.join(resolvePlaywrightCore(this._config.rootDir), '..', 'lib', 'vite', 'traceViewer');
      const traceViewerTargetFolder = path.join(this._reportFolder, 'trace');
      const traceViewerAssetsTargetFolder = path.join(traceViewerTargetFolder, 'assets');
      fs.mkdirSync(traceViewerAssetsTargetFolder, { recursive: true });
      for (const file of fs.readdirSync(traceViewerFolder)) {
        if (file.endsWith('.map') || file.includes('watch') || file.includes('assets'))
          continue;
        await copyFileAndMakeWritable(path.join(traceViewerFolder, file), path.join(traceViewerTargetFolder, file));
      }
      for (const file of fs.readdirSync(path.join(traceViewerFolder, 'assets'))) {
        if (file.endsWith('.map') || file.includes('xtermModule'))
          continue;
        await copyFileAndMakeWritable(path.join(traceViewerFolder, 'assets', file), path.join(traceViewerAssetsTargetFolder, file));
      }
    }

    await this._writeReportData(reportIndexFile);
    // [extended-report] tabs go last so the CLI can replace them cheaply.
    fs.appendFileSync(reportIndexFile, encodeTabs(sortTabs(tabs)));

    return { ok, singleTestId };
  }

  private async _writeStaticAssets() {
    const appFolder = kWebFolder; // [extended-report]
    const reportIndexFile = path.join(this._reportFolder, 'index.html');
    if (this._doNotInlineAssets) {
      const html = await fs.promises.readFile(path.join(appFolder, 'index.html'), 'utf-8');
      await Promise.all([
        fs.promises.writeFile(reportIndexFile, html),
        fs.promises.copyFile(path.join(appFolder, 'report.js'), path.join(this._reportFolder, 'report.js')),
        fs.promises.copyFile(path.join(appFolder, 'report.css'), path.join(this._reportFolder, 'report.css')),
      ]);
    } else {
      let html = await fs.promises.readFile(path.join(appFolder, 'index.html'), 'utf-8');
      const [js, css] = await Promise.all([
        fs.promises.readFile(path.join(appFolder, 'report.js'), 'utf-8'),
        fs.promises.readFile(path.join(appFolder, 'report.css'), 'utf-8'),
      ]);
      html = html.replace(/<script type="module"[^>]*><\/script>/, () => `<script type="module">${js}</script>`);
      html = html.replace(/<link rel="stylesheet"[^>]*>/, () => `<style type='text/css'>${css}</style>`);
      await fs.promises.writeFile(reportIndexFile, html);
    }
    return reportIndexFile;
  }

  private async _writeReportData(filePath: string) {
    fs.appendFileSync(filePath, '<template id="playwrightReportBase64">data:application/zip;base64,');
    await new Promise<void>((resolve, reject) => {
      this._dataZipFile.end(undefined, () => {
        this._dataZipFile.outputStream
            .pipe(new Base64Encoder())
            .pipe(fs.createWriteStream(filePath, { flags: 'a' })).on('close', resolve).on('error', reject);
      });
    });
    fs.appendFileSync(filePath, '</template>');
  }

  private _addDataFile(fileName: string, data: any) {
    this._dataZipFile.addBuffer(Buffer.from(JSON.stringify(data)), fileName);
  }

  private _createEntryForSuite(data: DataMap, projectName: string, suite: api.Suite, fileName: string, deep: boolean) {
    const fileId = calculateSha1(fileName).slice(0, 20);
    let fileEntry = data.get(fileId);
    if (!fileEntry) {
      fileEntry = {
        testFile: { fileId, fileName, tests: [] },
        testFileSummary: { fileId, fileName, tests: [], stats: emptyStats() },
      };
      data.set(fileId, fileEntry);
    }

    const { testFile, testFileSummary } = fileEntry;
    const testEntries: TestEntry[] = [];
    this._processSuite(suite, projectName, [], deep, testEntries);
    for (const test of testEntries) {
      testFile.tests.push(test.testCase);
      testFileSummary.tests.push(test.testCaseSummary);
    }
  }

  private _processSuite(suite: api.Suite, projectName: string, path: string[], deep: boolean, outTests: TestEntry[]) {
    const newPath = [...path, suite.title];
    suite.entries().forEach(e => {
      if (e.type === 'test')
        outTests.push(this._createTestEntry(e, projectName, newPath));
      else if (deep)
        this._processSuite(e, projectName, newPath, deep, outTests);
    });
  }

  private _createTestEntry(test: api.TestCase, projectName: string, path: string[]): TestEntry {
    const duration = test.results.reduce((a, r) => a + r.duration, 0);
    const location = this._relativeLocation(test.location)!;
    path = path.slice(1).filter(path => path.length > 0);
    const results = test.results.map(r => this._createTestResult(test, r));

    return {
      testCase: {
        testId: test.id,
        title: test.title,
        projectName,
        location,
        duration,
        annotations: this._serializeAnnotations(test.annotations),
        tags: [...new Set(test.tags)],
        outcome: test.outcome(),
        path,
        results,
        repeatEachIndex: test.repeatEachIndex || undefined, // Do not include zero.
        ok: test.outcome() === 'expected' || test.outcome() === 'flaky',
      },
      testCaseSummary: {
        testId: test.id,
        title: test.title,
        projectName,
        location,
        duration,
        annotations: this._serializeAnnotations(test.annotations),
        tags: [...new Set(test.tags)],
        outcome: test.outcome(),
        path,
        ok: test.outcome() === 'expected' || test.outcome() === 'flaky',
        repeatEachIndex: test.repeatEachIndex || undefined, // Do not include zero.
        results: results.map(result => {
          return {
            attachments: result.attachments.map(a => ({ name: a.name, contentType: a.contentType, path: a.path })),
            startTime: result.startTime,
            workerIndex: result.workerIndex,
          };
        }),
      },
    };
  }

  private _serializeAttachments(attachments: JsonAttachment[]) {
    let lastAttachment: TestAttachment | undefined;
    return attachments.map(a => {
      if (a.name === 'trace')
        this._hasTraces = true;

      if ((a.name === 'stdout' || a.name === 'stderr') && a.contentType === 'text/plain') {
        if (lastAttachment &&
          lastAttachment.name === a.name &&
          lastAttachment.contentType === a.contentType) {
          lastAttachment.body += stripAnsiEscapes(a.body as string);
          return null;
        }
        a.body = stripAnsiEscapes(a.body as string);
        lastAttachment = a as TestAttachment;
        return a;
      }

      if (a.path) {
        let fileName = a.path;
        try {
          const buffer = fs.readFileSync(a.path);
          const sha1 = calculateSha1(buffer) + path.extname(a.path);
          fileName = this._attachmentsBaseURL + sha1;
          fs.mkdirSync(path.join(this._reportFolder, 'data'), { recursive: true });
          fs.writeFileSync(path.join(this._reportFolder, 'data', sha1), buffer);
        } catch (e) {
        }
        return {
          name: a.name,
          contentType: a.contentType,
          path: fileName,
          body: a.body,
        };
      }

      if (a.body instanceof Buffer) {
        if (isTextContentType(a.contentType)) {
          // Content type is like this: "text/html; charset=UTF-8"
          const charset = a.contentType.match(/charset=(.*)/)?.[1];
          try {
            const body = a.body.toString(charset as any || 'utf-8');
            return {
              name: a.name,
              contentType: a.contentType,
              body,
            };
          } catch (e) {
            // Invalid encoding, fall through and save to file.
          }
        }

        fs.mkdirSync(path.join(this._reportFolder, 'data'), { recursive: true });
        const extension = sanitizeForFilePath(path.extname(a.name).replace(/^\./, '')) || extensionForContentType(a.contentType) || 'dat';
        const sha1 = calculateSha1(a.body) + '.' + extension;
        fs.writeFileSync(path.join(this._reportFolder, 'data', sha1), a.body);
        return {
          name: a.name,
          contentType: a.contentType,
          path: this._attachmentsBaseURL + sha1,
        };
      }

      // string
      return {
        name: a.name,
        contentType: a.contentType,
        body: a.body,
      };
    }).filter(Boolean) as TestAttachment[];
  }

  private _serializeAnnotations(annotations: api.TestCase['annotations']): TestAnnotation[] {
    // Annotations can be pushed directly, with a wrong type.
    return annotations.map(a => ({
      type: a.type,
      description: a.description === undefined ? undefined : String(a.description),
      location: a.location ? {
        file: a.location.file,
        line: a.location.line,
        column: a.location.column,
      } : undefined,
    }));
  }

  private _createTestResult(test: api.TestCase, result: api.TestResult): TestResult {
    return {
      duration: result.duration,
      startTime: result.startTime.toISOString(),
      retry: result.retry,
      steps: dedupeSteps(result.steps).map(s => this._createTestStep(s, result)),
      errors: formatResultFailure(test, result, '').map(error => {
        return {
          message: error.message,
          codeframe: error.location ? createErrorCodeframe(error.message, error.location) : undefined
        };
      }),
      status: result.status,
      annotations: this._serializeAnnotations(result.annotations ?? []),
      attachments: this._serializeAttachments([
        ...result.attachments,
        ...result.stdout.map(m => stdioAttachment(m, 'stdout')),
        ...result.stderr.map(m => stdioAttachment(m, 'stderr'))]),
      workerIndex: result.workerIndex,
    };
  }

  private _createTestStep(dedupedStep: DedupedStep, result: api.TestResult): TestStep {
    const { step, duration, count } = dedupedStep;
    const skipped = (step as any).annotations?.find((a: TestAnnotation) => a.type === 'skip');
    let title = step.title;
    if (skipped)
      title = `${title} (skipped${skipped.description ? ': ' + skipped.description : ''})`;
    const testStep: TestStep = {
      title,
      subtitle: (step as any).subtitle,
      startTime: step.startTime.toISOString(),
      duration,
      steps: dedupeSteps(step.steps).map(s => this._createTestStep(s, result)),
      attachments: (step.attachments ?? []).map(s => {
        const index = result.attachments.indexOf(s);
        if (index === -1)
          throw new Error('Unexpected, attachment not found');
        return index;
      }),
      location: this._relativeLocation(step.location),
      error: step.error?.message,
      count,
      skipped: !!skipped,
    };
    if (step.location)
      this._stepsInFile.set(step.location.file, testStep);
    return testStep;
  }

  private _relativeLocation(location: api.Location | undefined): api.Location | undefined {
    if (!location)
      return undefined;
    const file = toPosixPath(path.relative(this._config.rootDir, location.file));
    return {
      file,
      line: location.line,
      column: location.column,
    };
  }
}

const emptyStats = (): Stats => {
  return {
    total: 0,
    expected: 0,
    unexpected: 0,
    flaky: 0,
    skipped: 0,
    ok: true,
  };
};

const addStats = (stats: Stats, delta: Stats): Stats => {
  stats.total += delta.total;
  stats.skipped += delta.skipped;
  stats.expected += delta.expected;
  stats.unexpected += delta.unexpected;
  stats.flaky += delta.flaky;
  stats.ok = stats.ok && delta.ok;
  return stats;
};

class Base64Encoder extends Transform {
  private _remainder: Buffer | undefined;

  override _transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback): void {
    if (this._remainder) {
      chunk = Buffer.concat([this._remainder, chunk]);
      this._remainder = undefined;
    }

    const remaining = chunk.length % 3;
    if (remaining) {
      this._remainder = chunk.slice(chunk.length - remaining);
      chunk = chunk.slice(0, chunk.length - remaining);
    }
    chunk = chunk.toString('base64');
    this.push(Buffer.from(chunk));
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this._remainder)
      this.push(Buffer.from(this._remainder.toString('base64')));
    callback();
  }
}

function isTextContentType(contentType: string) {
  return contentType.startsWith('text/') || contentType.startsWith('application/json');
}

type JsonAttachment = {
  name: string;
  body?: string | Buffer;
  path?: string;
  contentType: string;
};

function stdioAttachment(chunk: Buffer | string, type: 'stdout' | 'stderr'): JsonAttachment {
  return {
    name: type,
    contentType: 'text/plain',
    body: typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
  };
}

type DedupedStep = { step: api.TestStep, count: number, duration: number };

function dedupeSteps(steps: api.TestStep[]) {
  const result: DedupedStep[] = [];
  let lastResult = undefined;
  for (const step of steps) {
    const canDedupe = !step.error && step.duration >= 0 && step.location?.file && !step.steps.length;
    const lastStep = lastResult?.step;
    if (canDedupe && lastResult && lastStep && step.category === lastStep.category && step.title === lastStep.title && (step as any).subtitle === (lastStep as any).subtitle && step.location?.file === lastStep.location?.file && step.location?.line === lastStep.location?.line && step.location?.column === lastStep.location?.column) {
      ++lastResult.count;
      lastResult.duration += step.duration;
      continue;
    }
    lastResult = { step, count: 1, duration: step.duration };
    result.push(lastResult);
    if (!canDedupe)
      lastResult = undefined;
  }
  return result;
}

function createSnippets(stepsInFile: MultiMap<string, TestStep>) {
  for (const file of stepsInFile.keys()) {
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf-8') + '\n//';
    } catch (e) {
      continue;
    }
    const lines = source.split('\n').length;
    const highlighted = codeFrameColumns(source, { start: { line: lines, column: 1 } }, { highlightCode: true, linesAbove: lines, linesBelow: 0 });
    const highlightedLines = highlighted.split('\n');
    const lineWithArrow = highlightedLines[highlightedLines.length - 1];
    for (const step of stepsInFile.get(file)) {
      // Don't bother with snippets that have less than 3 lines.
      if (step.location!.line < 2 || step.location!.line >= lines)
        continue;
      // Cut out snippet.
      const snippetLines = highlightedLines.slice(step.location!.line - 2, step.location!.line + 1);
      // Relocate arrow.
      const index = lineWithArrow.indexOf('^');
      const shiftedArrow = lineWithArrow.slice(0, index) + ' '.repeat(step.location!.column - 1) + lineWithArrow.slice(index);
      // Insert arrow line.
      snippetLines.splice(2, 0, shiftedArrow);
      step.snippet = snippetLines.join('\n');
    }
  }
}

function createErrorCodeframe(message: string, location: Location) {
  let source: string;
  try {
    source = fs.readFileSync(location.file, 'utf-8') + '\n//';
  } catch (e) {
    return;
  }

  return codeFrameColumns(
      source,
      {
        start: {
          line: location.line,
          column: location.column,
        },
      },
      {
        highlightCode: false,
        linesAbove: 100,
        linesBelow: 100,
        message: stripAnsiEscapes(message).split('\n')[0] || undefined,
      }
  );
}

// [extended-report] Finds the playwright-core that belongs to the project's @playwright/test
// (works with npm, yarn and pnpm layouts), falling back to the one next to this package.
function resolvePlaywrightCore(rootDir: string): string {
  const resolveFrom = (request: string, from: string[]) => require.resolve(request, { paths: from });
  try {
    const testPkg = resolveFrom('@playwright/test/package.json', [rootDir, process.cwd()]);
    const playwrightPkg = resolveFrom('playwright/package.json', [path.dirname(testPkg)]);
    return resolveFrom('playwright-core', [path.dirname(playwrightPkg)]);
  } catch {
  }
  try {
    return resolveFrom('playwright-core', [rootDir, process.cwd()]);
  } catch {
  }
  return require.resolve('playwright-core');
}

/** Where Playwright's rootDir is inside the repository (git root, else nearest package.json). */
function rootDirInRepo(rootDir: string): string | undefined {
  let dir = rootDir;
  let packageDir: string | undefined;
  while (true) {
    if (fs.existsSync(path.join(dir, '.git')))
      return toPosixPath(path.relative(dir, rootDir));
    if (!packageDir && fs.existsSync(path.join(dir, 'package.json')))
      packageDir = dir;
    const parent = path.dirname(dir);
    if (parent === dir)
      return packageDir ? toPosixPath(path.relative(packageDir, rootDir)) : undefined;
    dir = parent;
  }
}

function errorTitle(text: string): string {
  return (text.split('\n').map(l => l.trim()).find(Boolean) ?? '').replace(/^Error:\s*/, '').slice(0, 200);
}

function red(text: string) {
  return process.stdout.isTTY ? `\u001b[31m${text}\u001b[39m` : text;
}

function writeLine(line: string) {
  process.stdout.write(line + '\n');
}

export default ExtendedHtmlReporter;
