#!/usr/bin/env node
/**
 * pw-extended-report — manage tabs of a generated extended report.
 * Run `pw-extended-report help` for usage.
 */

import fs from 'fs';
import path from 'path';

import { isValidBadgeKind, isValidTabIcon, readTabs, removeTab, upsertTab } from '../tabs';
import { showReport } from '../server';

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

  remove-tab [report-dir] --id <id>
  list-tabs [report-dir]
  show [report-dir] [--host <host>] [--port <port>] [--no-open]
  help

Examples:
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
      if (next !== undefined && (!next.startsWith('--') || next === '-') && !['optional', 'no-open'].includes(name)) {
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

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const reportDir = path.resolve(positional[0] || kDefaultReportDir);
  switch (command) {
    case 'add-tab':
      await addTab(reportDir, flags);
      return;
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
      for (const tab of tabs)
        console.log(`${tab.id}\t${tab.format}\t${tab.title}${tab.badge !== undefined ? `\t[${tab.badge}]` : ''}`);
      return;
    }
    case 'show': {
      const port = stringFlag(flags, 'port');
      await showReport(reportDir, { host: stringFlag(flags, 'host'), port: port ? +port : undefined, open: !flags.has('no-open') });
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
