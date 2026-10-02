import * as React from 'react';
import { Dialog } from '@web/shared/dialog';
import type { InsightsData, InsightTest, NetworkIssue } from '../../../../src/shared/insightsFormat';
import { reportLang, texts } from '../i18n';

const kKindNames = {
  ru: { 'product-bug': 'баг продукта', 'test-bug': 'ошибка теста', 'environment': 'окружение', 'ui-change': 'изменение UI', 'flaky': 'нестабильный тест', 'unknown': 'не определено' },
  en: { 'product-bug': 'product bug', 'test-bug': 'test bug', 'environment': 'environment', 'ui-change': 'UI change', 'flaky': 'flaky', 'unknown': 'unclassified' },
};

/** Prompt for "Copy prompt" when no agent backend is available. */
export function buildPrompt(test: InsightTest, errorContext: string | undefined): string {
  const ru = reportLang() === 'ru';
  const c = test.classification;
  const lines: string[] = [];
  lines.push(ru ? 'Ты — опытный инженер по автоматизации тестирования. Разбери упавший тест Playwright. Отвечай на русском языке; код, локаторы и тексты ошибок оставляй как есть.' : 'You are a senior QA automation engineer analysing a failed Playwright test.');
  lines.push('');
  lines.push(ru ? '## Тест' : '## Test');
  lines.push(`${[...test.titlePath].join(' › ') || test.title}${test.projectName ? ` [${test.projectName}]` : ''}`);
  lines.push(ru ? `Расположение: ${test.file}:${test.line}. Итог: ${test.outcome}. Попыток: ${test.attempts}.` : `Location: ${test.file}:${test.line}. Outcome: ${test.outcome}. Attempts: ${test.attempts}.`);
  if (c) {
    lines.push('');
    lines.push(ru ? '## Классификация по правилам' : '## Rule-based classification');
    lines.push(`${kKindNames[ru ? 'ru' : 'en'][c.kind]} (${ru ? 'уверенность' : 'confidence'}: ${c.confidence}): ${c.reason}`);
    for (const e of c.evidence)
      lines.push(`- ${e}`);
  }
  if (test.error) {
    lines.push('');
    lines.push(ru ? '## Ошибка' : '## Error');
    lines.push('```');
    lines.push(test.error.split('\n').slice(0, 60).join('\n'));
    lines.push('```');
  }
  if (test.network.length) {
    lines.push('');
    lines.push(ru ? '## Упавшие сетевые запросы' : '## Failed network requests');
    for (const n of test.network)
      lines.push(`- ${n.method} ${n.url} → ${n.status || n.failure}${n.responseBody ? `\n  ${ru ? 'тело ответа' : 'response body'}: ${n.responseBody.slice(0, 300)}` : ''}`);
  }
  if (test.console.length) {
    lines.push('');
    lines.push(ru ? '## Ошибки браузера' : '## Browser errors');
    for (const m of test.console)
      lines.push(`- ${m.kind}: ${m.text.split('\n').slice(0, 3).join(' ')}`);
  }
  if (test.history && test.history.totalRuns > 1) {
    const h = test.history;
    lines.push('');
    lines.push(ru ? '## История' : '## History');
    lines.push(ru
      ? `Падал в ${h.failedRuns} из ${h.totalRuns} последних прогонов. ${h.isNewFailure ? 'НОВОЕ падение: во всех прошлых прогонах проходил.' : h.failingStreak > 1 ? `Падает ${h.failingStreak} прогонов подряд.` : ''}`
      : `Failed in ${h.failedRuns} of ${h.totalRuns} recent runs. ${h.isNewFailure ? 'NEW failure: it passed in all previous runs.' : h.failingStreak > 1 ? `Failing ${h.failingStreak} runs in a row.` : ''}`);
    lines.push(`${ru ? 'Последовательность (старые → новые)' : 'Sequence (old → new)'}: ${h.runs.map(r => r.outcome).join(' ')}  (p=passed f=failed k=flaky s=skipped)`);
  }
  if (errorContext) {
    lines.push('');
    lines.push(ru ? '## Снапшот страницы и код теста в момент падения' : '## Page snapshot and test source at the moment of failure');
    lines.push(errorContext.slice(0, 15000));
  }
  lines.push('');
  lines.push(ru ? '## Задача' : '## Task');
  if (ru) {
    lines.push('1. Подтверди или исправь классификацию: баг продукта / ошибка теста / окружение / изменение UI / нестабильный тест. Одна строка.');
    lines.push('2. Первопричина в 2–3 предложениях со ссылками на факты выше.');
    lines.push('3. Если это ошибка теста — дай исправленный код Playwright. Если баг продукта или окружение — что и кому сообщить; никогда не ослабляй проверки, чтобы тест прошёл.');
    lines.push('Ответ — кратко, в Markdown.');
  } else {
    lines.push('1. Confirm or correct the classification: product bug / test bug / environment / UI change / flaky. One line.');
    lines.push('2. Root cause in 2–3 sentences, citing the evidence above.');
    lines.push('3. If it is a test bug, give the corrected Playwright code. If it is a product bug or an environment problem, say what to report and to whom; never weaken assertions to make the test pass.');
    lines.push('Answer in concise Markdown.');
  }
  return lines.join('\n');
}

/** "Copy fix prompt": for any LLM chat or IDE agent (Playwright healer, GigaCode, ...). */
export function healerPrompt(test: InsightTest): string {
  const ru = reportLang() === 'ru';
  const c = test.classification;
  const title = [...test.titlePath].join(' › ') || test.title;
  return [
    ru
      ? `Исправь упавший тест Playwright «${title}»${test.projectName ? ` (проект «${test.projectName}»)` : ''} в ${test.file}:${test.line}.`
      : `Fix the failing Playwright test "${title}"${test.projectName ? ` (project "${test.projectName}")` : ''} in ${test.file}:${test.line}.`,
    '',
    `${ru ? 'Запуск' : 'Run it with'}: ${rerunCommand(test)}`,
    c ? `${ru ? 'Классификация из отчёта' : 'Report classification'}: ${kKindNames[ru ? 'ru' : 'en'][c.kind]} — ${c.reason}` : '',
    test.error ? `${ru ? 'Ошибка' : 'Error'}:\n\`\`\`\n${test.error.split('\n').slice(0, 30).join('\n')}\n\`\`\`` : '',
    test.network.length ? `${ru ? 'Упавшие запросы' : 'Failed requests'}: ${test.network.map(n => `${n.method} ${n.url} → ${n.status || n.failure}`).join('; ')}` : '',
    test.console.length ? `${ru ? 'Ошибки браузера' : 'Browser errors'}: ${test.console.map(m => m.text.split('\n')[0]).join('; ')}` : '',
    '',
    ru
      ? 'Меняй тест, только если причина в самом тесте (локаторы, ожидания, тестовые данные). Если это баг продукта или проблема окружения — не ослабляй проверки: пометь тест test.fixme() и объясни причину в комментарии. Отвечай на русском языке.'
      : 'Only change the test when the failure is caused by the test itself (locators, waits, test data). If it is a product bug or an environment problem, do not weaken assertions — mark the test with test.fixme() and explain why in a comment.',
  ].filter(l => l !== '').join('\n');
}

/** The rerun command stays a command — not translated. */
export function rerunCommand(test: InsightTest): string {
  return `npx playwright test "${test.file}:${test.line}"${test.projectName ? ` --project="${test.projectName}"` : ''} --retries=0 --trace=on`;
}

/** Markdown bug report for a failed backend request (for Jira / the backend team). */
export function backendBugReport(test: InsightTest, request: NetworkIssue): string {
  const ru = reportLang() === 'ru';
  const lines = [
    `### ${request.method} ${new URL(request.url, 'http://x').pathname} → ${request.status || request.failure}`,
    '',
    `**${ru ? 'Запрос' : 'Request'}:** \`${request.method} ${request.url}\``,
    `**${ru ? 'Ответ' : 'Response'}:** ${request.status ? `${request.status} ${request.statusText ?? ''}` : request.failure}${request.durationMs !== undefined ? ` (${request.durationMs}ms)` : ''}`,
    request.startedAt ? `**${ru ? 'Время' : 'Time'}:** ${request.startedAt}` : '',
    `**${ru ? 'Найдено автотестом' : 'Found by the test'}:** ${[...test.titlePath].join(' › ')} (\`${test.file}:${test.line}\`${test.projectName ? `, ${test.projectName}` : ''})`,
    '',
    ru ? '**Воспроизведение:**' : '**Reproduce:**',
    '```bash',
    request.curl ?? `curl -X ${request.method} '${request.url}'`,
    '```',
  ];
  if (request.requestBody)
    lines.push('', ru ? '**Тело запроса:**' : '**Request body:**', '```', request.requestBody.slice(0, 2000), '```');
  if (request.responseBody)
    lines.push('', ru ? '**Тело ответа:**' : '**Response body:**', '```', request.responseBody.slice(0, 2000), '```');
  return lines.filter(l => l !== '').join('\n').replace(/\n\*\*/g, '\n\n**');
}

function fillTemplate(template: string, test: InsightTest): string {
  const values: Record<string, string> = {
    file: test.file, line: String(test.line), title: test.title, project: test.projectName, testId: test.testId,
  };
  return template.replace(/\{(file|line|title|project|testId)\}/g, (_, key) => encodeURIComponent(values[key]));
}

export const FixMenu: React.FC<{ test: InsightTest, data?: InsightsData, onAgentFix: () => void, label?: string }> = ({ test, data, onAgentFix, label }) => {
  const t = texts();
  const anchor = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState<string>();
  const copy = async (what: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(undefined), 3000);
  };
  return <>
    <button ref={anchor} className='button' aria-haspopup='menu' aria-expanded={open} onClick={() => setOpen(!open)}>{label ?? t.fixMenu}</button>
    <Dialog open={open} anchor={anchor} minWidth={300} verticalOffset={4} requestClose={() => setOpen(false)} dataTestId='fix-menu'>
      <div className='fix-menu' role='menu'>
        <button role='menuitem' onClick={() => {
          setOpen(false);
          onAgentFix();
        }}>{t.proposeWithAgent}</button>
        <button role='menuitem' onClick={() => copy('healer', healerPrompt(test))}>{copied === 'healer' ? `${t.copied} ✓` : t.copyFixPrompt}</button>
        <button role='menuitem' onClick={() => copy('rerun', rerunCommand(test))}>{copied === 'rerun' ? `${t.copied} ✓` : t.copyRerun}</button>
        {data?.fix?.urlTemplate && <a role='menuitem' href={fillTemplate(data.fix.urlTemplate, test)} target='_blank' rel='noreferrer'>{t.runFixJob}</a>}
      </div>
    </Dialog>
  </>;
};
