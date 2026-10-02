#!/usr/bin/env node
/**
 * pw-extended-report — manage tabs of a generated extended report.
 * Run `pw-extended-report help` for usage.
 */

import fs from 'fs';
import path from 'path';

import { isValidBadgeKind, isValidTabIcon, kFailureAnalysisTabId, kSkillSectionId, readTabs, removeSection, removeTab, upsertSection, upsertTab } from '../tabs';
import { showReport, startAiGateway } from '../server';
import { AgentService } from '../agent/service';
import { analyzeReport } from '../agent/batch';
import { McpHub, loadMcpConfig } from '../agent/mcp';
import { llmConfigFromEnv } from '../agent/llm';
import { Repo } from '../agent/repo';

import type { ExtendedTabFormat, ExtendedTabInput } from '../tabs';

const kDefaultReportDir = 'extended-report';

const usage = `Usage: pw-extended-report <command> [report-dir] [options]

report-dir defaults to ./${kDefaultReportDir}

Commands:
  add-tab [report-dir]     Add a tab, or replace the tab with the same --id
      --id <id>              Tab id, used in the URL (#?tab=<id>). Required.
      --title <title>        Tab label. Default: the id.
      --file <path>          .md / .html file, or a folder with index.html (iframe tab).
                             Use "-" to read Markdown from stdin.
      --content <text>       Inline content instead of --file.
      --format <format>      markdown | html | iframe. Default: from the file extension.
      --icon <icon>          sparkle | bug | graph | note | list | none. Default: note.
      --badge <text>         Counter next to the title, e.g. number of issues.
      --badge-kind <kind>    default | danger | attention | success.
      --order <number>       Tabs are sorted by order (built-in failures tab: 100).
      --description <text>   Subtitle shown above the content.
      --source <text>        Where the content came from, shown in the tab.
      --optional             Do nothing (exit 0) if --file does not exist.

  add-analysis [report-dir] --file <path>
                             Put your skill / LLM analysis into the "Failure analysis" tab
                             (above the automatic error grouping). Replaces the previous one.
      --title <title>        Section title. Default: "Анализ скилла" / "Skill analysis".
      --source <text>        Where it came from, e.g. "jenkins-log-skill #123".
      --optional             Do nothing if --file does not exist.

  add-section [report-dir] --tab <tab-id> --id <section-id> --title <title> (--file <path>|--content <text>)
                             Add a section to any Markdown / HTML tab.
  remove-section [report-dir] --tab <tab-id> --id <section-id>

  remove-tab [report-dir] --id <id>
  list-tabs [report-dir]
  show [report-dir] [--host <host>] [--port <port>] [--no-open] [--ai | --ai-mock] [--repo <dir>] [--config <file>]
                             Serve the report locally.
      --ai                   Enable the AI agent (Ask AI / Fix). Model settings: see docs/AGENT.md
                             (EXTENDED_REPORT_AI_PROVIDER = openai | gigachat | gigacode-ift-ssl | gigacode-cli).
      --ai-mock              Enable the agent with template answers (demo, no model).
      --repo <dir>           Tests repository: enables "Run & debug" and applying fixes.
      --config <file>        Playwright config inside the repo (default: the repo's default).

  agent [report-dir] [--repo <dir>] [--ai-mock] [--port <port>]
                             Same as "show --ai --repo .": run it inside the tests repository.

  ai-gateway [--host <host>] [--port <port>] [--ai-mock] [--repo <dir>] [--allow-run]
                             Standalone agent backend with CORS for reports hosted elsewhere
                             (Jenkins). Point EXTENDED_REPORT_AI_ENDPOINT to it. With --repo the agent
                             reads sources from the repository (and MCP gets \${REPO}); --allow-run
                             also enables re-runs and fixes there.

  analyze [report-dir] [--max <n>] [--scope groups|tests] [--agent-url <url>] [--repo <dir>] [--strict]
                             AI analysis in CI right after the run: one request per error group
                             (largest first, default --max 10), written into the report.
                             Runs the agent in-process, or delegates to --agent-url (a running ai-gateway).

  Agent options (show --ai / agent / ai-gateway / analyze):
      --mcp-config <file>    MCP servers (mcpServers JSON). Default lookup: EXTENDED_REPORT_MCP_CONFIG,
                             <repo>/.pw-extended-report/mcp.json, <repo>/.mcp.json, ~/.pw-extended-report/mcp.json
      --no-mcp               Do not use MCP servers (simple path only).
  help

Examples:
  pw-extended-report add-analysis --file analysis.md --source "jenkins-log-skill"
  pw-extended-report add-tab --id ai --title "AI analysis" --icon sparkle --file analysis.md
  cat analysis.md | pw-extended-report add-tab extended-report --id ai --file -
  pw-extended-report show extended-report
`;

type ParsedArgs = { command?: string, positional: string[], flags: Map<string, string | true> };

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const name = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && (!next.startsWith('--') || next === '-') && !['optional', 'no-open', 'ai', 'ai-mock', 'allow-run', 'strict', 'no-mcp'].includes(name)) {
        flags.set(name, next);
        ++i;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags.get(name);
  if (value === true)
    throw new Error(`--${name} requires a value`);
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

async function addTab(reportDir: string, flags: ParsedArgs['flags']) {
  const id = stringFlag(flags, 'id');
  if (!id)
    throw new Error('--id is required');
  const iconFlag = stringFlag(flags, 'icon');
  if (iconFlag !== undefined && !isValidTabIcon(iconFlag))
    throw new Error(`invalid --icon "${iconFlag}"`);
  const icon = iconFlag;
  const badgeKindFlag = stringFlag(flags, 'badge-kind');
  if (badgeKindFlag !== undefined && !isValidBadgeKind(badgeKindFlag))
    throw new Error(`invalid --badge-kind "${badgeKindFlag}"`);
  const badgeKind = badgeKindFlag;
  const format = stringFlag(flags, 'format') as ExtendedTabFormat | undefined;
  const order = stringFlag(flags, 'order');

  const input: ExtendedTabInput = {
    id,
    title: stringFlag(flags, 'title') || id,
    format,
    icon,
    badge: stringFlag(flags, 'badge'),
    badgeKind,
    order: order !== undefined ? Number(order) : undefined,
    description: stringFlag(flags, 'description'),
    source: stringFlag(flags, 'source'),
    generatedAt: new Date().toISOString(),
    optional: flags.has('optional'),
  };
  const file = stringFlag(flags, 'file');
  const content = stringFlag(flags, 'content');
  if (file === '-')
    input.content = await readStdin();
  else if (file)
    input.file = path.resolve(file);
  else if (content !== undefined)
    input.content = content;
  else
    throw new Error('either --file or --content is required');

  const tab = await upsertTab(reportDir, input);
  if (!tab)
    console.log(`Skipped tab "${id}": ${file} does not exist (--optional).`);
  else
    console.log(`Tab "${tab.id}" (${tab.format}) written to ${path.join(reportDir, 'index.html')}`);
}

async function addSection(reportDir: string, tabId: string, flags: ParsedArgs['flags'], defaults: { id?: string, title?: string, order?: number }) {
  const id = stringFlag(flags, 'id') || defaults.id;
  if (!id)
    throw new Error('--id is required');
  const file = stringFlag(flags, 'file');
  const content = stringFlag(flags, 'content');
  const order = stringFlag(flags, 'order');
  const section = await upsertSection(reportDir, tabId, {
    id,
    title: stringFlag(flags, 'title') || defaults.title || id,
    order: order !== undefined ? Number(order) : defaults.order,
    description: stringFlag(flags, 'description'),
    source: stringFlag(flags, 'source'),
    generatedAt: new Date().toISOString(),
    optional: flags.has('optional'),
    file: file === '-' ? undefined : file ? path.resolve(file) : undefined,
    content: file === '-' ? await readStdin() : content,
  });
  if (!section)
    console.log(`Skipped section "${id}": ${file} does not exist (--optional).`);
  else
    console.log(`Section "${id}" written to tab "${tabId}" in ${path.join(reportDir, 'index.html')}`);
}

function makeAgent(flags: ParsedArgs['flags'], options: { reportDir?: string, repoDir?: string, allowRun?: boolean, cors?: string }): AgentService {
  const repo = options.repoDir ? new Repo(options.repoDir, stringFlag(flags, 'config')) : undefined;
  const { config, source } = flags.has('no-mcp') ? { config: { mcpServers: {} }, source: undefined } : loadMcpConfig({ configFile: stringFlag(flags, 'mcp-config'), repoDir: repo?.dir });
  const mcp = Object.keys(config.mcpServers).length ? new McpHub(config, source) : undefined;
  return new AgentService({
    llm: llmConfigFromEnv({ mock: flags.has('ai-mock') }),
    reportDir: options.reportDir,
    repo,
    allowRun: options.allowRun,
    mcp,
    corsOrigin: options.cors,
  });
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const reportDir = path.resolve(positional[0] || kDefaultReportDir);
  switch (command) {
    case 'add-tab':
      await addTab(reportDir, flags);
      return;
    case 'add-analysis':
      if (!flags.has('file') && !flags.has('content'))
        throw new Error('--file is required');
      {
        // Title in the report's language, as set by the reporter's placeholder.
        const tab = (await readTabs(reportDir)).find(t => t.id === kFailureAnalysisTabId);
        const title = tab?.placeholders?.find(p => p.sectionId === kSkillSectionId)?.title ?? 'Skill analysis';
        await addSection(reportDir, kFailureAnalysisTabId, flags, { id: kSkillSectionId, title, order: 10 });
      }
      return;
    case 'add-section': {
      const tab = stringFlag(flags, 'tab');
      if (!tab)
        throw new Error('--tab is required');
      await addSection(reportDir, tab, flags, {});
      return;
    }
    case 'remove-section': {
      const tab = stringFlag(flags, 'tab');
      const id = stringFlag(flags, 'id');
      if (!tab || !id)
        throw new Error('--tab and --id are required');
      console.log(await removeSection(reportDir, tab, id) ? `Removed section "${id}".` : `Section "${id}" not found.`);
      return;
    }
    case 'remove-tab': {
      const id = stringFlag(flags, 'id');
      if (!id)
        throw new Error('--id is required');
      const removed = await removeTab(reportDir, id);
      console.log(removed ? `Removed tab "${id}".` : `Tab "${id}" not found.`);
      return;
    }
    case 'list-tabs': {
      const tabs = await readTabs(reportDir);
      if (!tabs.length)
        console.log('No extra tabs.');
      for (const tab of tabs) {
        console.log(`${tab.id}\t${tab.format}\t${tab.title}${tab.badge !== undefined ? `\t[${tab.badge}]` : ''}`);
        for (const section of tab.sections || [])
          console.log(`  - ${section.id}\t${section.title}`);
      }
      return;
    }
    case 'show': {
      const port = stringFlag(flags, 'port');
      const withAi = flags.has('ai') || flags.has('ai-mock');
      const repoDir = stringFlag(flags, 'repo');
      const agent = withAi ? makeAgent(flags, { reportDir, repoDir }) : undefined;
      await showReport(reportDir, { host: stringFlag(flags, 'host'), port: port ? +port : undefined, open: !flags.has('no-open'), agent });
      return;
    }
    case 'agent': {
      const port = stringFlag(flags, 'port');
      const agent = makeAgent(flags, { reportDir, repoDir: stringFlag(flags, 'repo') || process.cwd() });
      await showReport(reportDir, { host: stringFlag(flags, 'host'), port: port ? +port : undefined, open: !flags.has('no-open'), agent });
      return;
    }
    case 'ai-gateway': {
      const port = stringFlag(flags, 'port');
      const agent = makeAgent(flags, { repoDir: stringFlag(flags, 'repo'), allowRun: flags.has('allow-run'), cors: process.env.EXTENDED_REPORT_AI_CORS_ORIGIN || '*' });
      const gateway = await startAiGateway(agent, { host: stringFlag(flags, 'host'), port: port ? +port : undefined });
      const status = agent.status();
      console.log(`AI agent gateway: ${gateway.url} (${status.model}).`);
      console.log(status.repo ? `Repository: ${status.repo}${status.canRun ? ' (run & fix enabled)' : ' (read only)'}` : 'No repository: analysis from traces only.');
      if (status.mcp)
        console.log(`MCP config: ${status.mcp.config}`);
      await new Promise(() => {});
      return;
    }
    case 'analyze': {
      const agentUrl = stringFlag(flags, 'agent-url');
      const max = stringFlag(flags, 'max');
      const scope = stringFlag(flags, 'scope') === 'tests' ? 'tests' : 'groups';
      const agent = agentUrl ? undefined : makeAgent(flags, { reportDir, repoDir: stringFlag(flags, 'repo'), allowRun: false });
      const { analyzed, failed } = await analyzeReport(reportDir, { agent, agentUrl, max: max ? +max : undefined, scope, log: line => console.log(line) });
      console.log(`AI analysis: ${analyzed} done, ${failed} failed. Written to ${path.join(reportDir, 'index.html')}`);
      await agent?.close();
      if (failed && flags.has('strict'))
        process.exitCode = 1;
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(usage);
      return;
    case '--version':
    case 'version': {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
      console.log(pkg.version);
      return;
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${usage}`);
  }
}

main().catch(e => {
  console.error(`pw-extended-report: ${e.message}`);
  process.exit(1);
});
