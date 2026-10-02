import * as React from 'react';
import { Dialog } from '@web/shared/dialog';
import type { InsightsData, InsightTest } from '../../../../src/shared/insightsFormat';

const kKindNames = {
  'product-bug': 'product bug',
  'test-bug': 'test bug',
  'environment': 'environment',
  'ui-change': 'UI change',
  'flaky': 'flaky',
  'unknown': 'unclassified',
};

export function buildPrompt(test: InsightTest, errorContext: string | undefined): string {
  const c = test.classification;
  const lines: string[] = [];
  lines.push('You are a senior QA automation engineer analysing a failed Playwright test.');
  lines.push('');
  lines.push('## Test');
  lines.push(`${[...test.titlePath].join(' › ') || test.title}${test.projectName ? ` [${test.projectName}]` : ''}`);
  lines.push(`Location: ${test.file}:${test.line}. Outcome: ${test.outcome}. Attempts: ${test.attempts}.`);
  if (c) {
    lines.push('');
    lines.push('## Rule-based classification');
    lines.push(`${kKindNames[c.kind]} (confidence: ${c.confidence}): ${c.reason}`);
    for (const e of c.evidence)
      lines.push(`- ${e}`);
  }
  if (test.error) {
    lines.push('');
    lines.push('## Error');
    lines.push('```');
    lines.push(test.error.split('\n').slice(0, 60).join('\n'));
    lines.push('```');
  }
  if (test.network.length) {
    lines.push('');
    lines.push('## Failed network requests');
    for (const n of test.network)
      lines.push(`- ${n.method} ${n.url} → ${n.status || n.failure}`);
  }
  if (test.console.length) {
    lines.push('');
    lines.push('## Browser errors');
    for (const m of test.console)
      lines.push(`- ${m.kind}: ${m.text.split('\n').slice(0, 3).join(' ')}`);
  }
  if (test.history && test.history.totalRuns > 1) {
    const h = test.history;
    lines.push('');
    lines.push('## History');
    lines.push(`Failed in ${h.failedRuns} of ${h.totalRuns} recent runs. ${h.isNewFailure ? 'NEW failure: it passed in all previous runs.' : h.failingStreak > 1 ? `Failing ${h.failingStreak} runs in a row.` : ''}`);
    lines.push(`Sequence (old → new): ${h.runs.map(r => r.outcome).join(' ')}  (p=passed f=failed k=flaky s=skipped)`);
  }
  if (errorContext) {
    lines.push('');
    lines.push('## Page snapshot and test source at the moment of failure');
    lines.push(errorContext.slice(0, 15000));
  }
  lines.push('');
  lines.push('## Task');
  lines.push('1. Confirm or correct the classification: product bug / test bug / environment / UI change / flaky. One line.');
  lines.push('2. Root cause in 2–3 sentences, citing the evidence above.');
  lines.push('3. If it is a test bug, give the corrected Playwright code. If it is a product bug or an environment problem, say what to report and to whom; never weaken assertions to make the test pass.');
  lines.push('Answer in concise Markdown.');
  return lines.join('\n');
}

export function healerPrompt(test: InsightTest): string {
  const c = test.classification;
  return [
    `Fix the failing Playwright test "${[...test.titlePath].join(' › ') || test.title}"${test.projectName ? ` (project "${test.projectName}")` : ''} in ${test.file}:${test.line}.`,
    '',
    `Run it with: ${rerunCommand(test)}`,
    c ? `Report classification: ${kKindNames[c.kind]} — ${c.reason}` : '',
    test.error ? `Error:\n\`\`\`\n${test.error.split('\n').slice(0, 30).join('\n')}\n\`\`\`` : '',
    test.network.length ? `Failed requests: ${test.network.map(n => `${n.method} ${n.url} → ${n.status || n.failure}`).join('; ')}` : '',
    test.console.length ? `Browser errors: ${test.console.map(m => m.text.split('\n')[0]).join('; ')}` : '',
    '',
    'Only change the test when the failure is caused by the test itself (locators, waits, test data). If it is a product bug or an environment problem, do not weaken assertions — mark the test with test.fixme() and explain why in a comment.',
  ].filter(l => l !== '').join('\n');
}

export function rerunCommand(test: InsightTest): string {
  return `npx playwright test "${test.file}:${test.line}"${test.projectName ? ` --project="${test.projectName}"` : ''} --retries=0 --trace=on`;
}

function fillTemplate(template: string, test: InsightTest): string {
  const values: Record<string, string> = {
    file: test.file, line: String(test.line), title: test.title, project: test.projectName, testId: test.testId,
  };
  return template.replace(/\{(file|line|title|project|testId)\}/g, (_, key) => encodeURIComponent(values[key]));
}

export const FixMenu: React.FC<{ test: InsightTest, data?: InsightsData, onAgentFix: () => void }> = ({ test, data, onAgentFix }) => {
  const anchor = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState<string>();
  const copy = async (what: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(undefined), 3000);
  };
  return <>
    <button ref={anchor} className='button' aria-haspopup='menu' aria-expanded={open} onClick={() => setOpen(!open)}>Fix ▾</button>
    <Dialog open={open} anchor={anchor} minWidth={280} verticalOffset={4} requestClose={() => setOpen(false)} dataTestId='fix-menu'>
      <div className='fix-menu' role='menu'>
        <button role='menuitem' onClick={() => {
          setOpen(false);
          onAgentFix();
        }}>Propose fix with AI agent</button>
        <button role='menuitem' onClick={() => copy('healer', healerPrompt(test))}>{copied === 'healer' ? 'Copied ✓' : 'Copy fix prompt (for any LLM / IDE agent)'}</button>
        <button role='menuitem' onClick={() => copy('rerun', rerunCommand(test))}>{copied === 'rerun' ? 'Copied ✓' : 'Copy rerun command'}</button>
        {data?.fix?.urlTemplate && <a role='menuitem' href={fillTemplate(data.fix.urlTemplate, test)} target='_blank' rel='noreferrer'>Run fix job ↗</a>}
      </div>
    </Dialog>
  </>;
};
