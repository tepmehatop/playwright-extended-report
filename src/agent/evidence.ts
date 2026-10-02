/**
 * Turns everything we know about one failed test into an "evidence pack":
 * a Markdown document with prioritized sections that fits the model's context
 * budget. The same document is shown to the user ("what the agent saw"), so the
 * analysis is verifiable even when the model is weak.
 */

import { describeLab } from './locatorLab';
import { sha1 } from './trace';

import type { LabResult } from './locatorLab';
import type { Lang } from './prompts';
import type { DomElement, DomState, TraceData } from './trace';
import type { InsightTest } from '../shared/insightsFormat';

/** The part of the report's TestCase the agent uses (sent by the UI). */
export type ReportTestCase = {
  testId: string;
  title: string;
  path: string[];
  projectName: string;
  location: { file: string, line: number, column: number };
  outcome: string;
  results: {
    retry: number;
    status: string;
    duration: number;
    errors: { message: string, codeframe?: string }[];
    steps: ReportStep[];
    attachments: { name: string, contentType: string, path?: string, body?: string }[];
  }[];
};

type ReportStep = { title: string, duration: number, error?: string, steps: ReportStep[], location?: { file: string, line: number } };

export type LocatorCandidate = { code: string, reason: string, element: string };

export type EvidenceInput = {
  lang: Lang;
  test: ReportTestCase;
  /** Locator lab results on the DOM at failure (failing locator + candidates). */
  lab?: LabResult[];
  /** Index of the attempt being analyzed. */
  attempt: number;
  insight?: InsightTest;
  trace?: TraceData;
  errorContext?: string;
  comment?: string;
  /** Source files: path -> content (from the repo or the trace). */
  sources?: { path: string, content: string, focusLine?: number }[];
  rerun?: { status: string, error?: string, durationMs?: number, trace?: TraceData, output?: string };
};

export type Evidence = {
  markdown: string;
  failingLocator?: string;
  candidates: LocatorCandidate[];
  truncated: boolean;
};


const kTitles = {
  test: { ru: 'Тест', en: 'Test' },
  hint: { ru: 'Подсказка инженера (доверяй, но проверь по доказательствам)', en: 'Hint from the engineer (trust it, but verify against the evidence)' },
  error: { ru: 'Ошибка', en: 'Error' },
  failing: { ru: 'Упавшее действие (из трейса)', en: 'Failing action (from the trace)' },
  page: { ru: 'Страница в момент падения', en: 'Page at the moment of failure' },
  similar: { ru: 'Элементы на странице, похожие на упавший локатор', en: 'Elements on the page similar to the failing locator' },
  lab: { ru: 'Locator lab: проверка локаторов на DOM момента падения', en: 'Locator lab: locators checked on the DOM at failure' },
  classification: { ru: 'Классификация по правилам (эвристика, может ошибаться)', en: 'Rule-based classification (heuristic, may be wrong)' },
  network: { ru: 'Упавшие сетевые запросы', en: 'Failed network requests' },
  console: { ru: 'Ошибки консоли браузера / необработанные исключения', en: 'Browser console errors / uncaught exceptions' },
  source: { ru: 'Исходный код', en: 'Source' },
  steps: { ru: 'Шаги теста (из отчёта)', en: 'Test steps (report)' },
  actions: { ru: 'Действия в браузере перед падением', en: 'Browser actions before the failure' },
  requests: { ru: 'Последние сетевые запросы', en: 'Last network requests' },
  attempts: { ru: 'Другие попытки', en: 'Other attempts' },
  history: { ru: 'История прошлых прогонов', en: 'History of previous runs' },
  rerun: { ru: 'Локальный перезапуск теста (выполнен агентом только что)', en: 'Local re-run of the test (performed by the agent just now)' },
  errorContext: { ru: 'Снапшот страницы (ARIA) и контекст из вложения error-context', en: 'Page snapshot (ARIA) and context from the error-context attachment' },
};

const kPhrases = {
  title: { ru: 'Название', en: 'Title' }, project: { ru: 'Проект', en: 'Project' }, location: { ru: 'Расположение', en: 'Location' },
  outcome: { ru: 'Итог', en: 'Outcome' }, analyzed: { ru: 'разбирается попытка', en: 'analyzed attempt' }, of: { ru: 'из', en: 'of' },
  attempts: { ru: 'Попытки', en: 'Attempts' }, action: { ru: 'Действие', en: 'Action' }, locator: { ru: 'Локатор', en: 'Locator' },
  params: { ru: 'Параметры', en: 'Params' }, duration: { ru: 'Длительность', en: 'Duration' },
  unfinished: { ru: 'Не завершилось (тест закончился во время ожидания)', en: 'Did not finish (test ended while waiting)' },
  callLog: { ru: 'Лог ожидания', en: 'Call log' }, element: { ru: 'элемент', en: 'element' },
  noneSimilar: { ru: 'Не найдено: нет элементов с похожим test id, текстом или ролью.', en: 'None found: no element with a similar test id, text or role.' },
  status: { ru: 'Статус', en: 'Status' }, in: { ru: 'за', en: 'in' },
  same: { ru: 'Та же ошибка, что в отчёте: падение воспроизводится.', en: 'Same error as in the report: the failure reproduces.' },
  different: { ru: 'Ошибка отличается от отчёта.', en: 'Different error than in the report.' },
  passedLocally: { ru: 'Тест ПРОШЁЛ локально: исходное падение связано с окружением / данными / таймингами или уже исправлено.', en: 'The test PASSED locally: the original failure is environment / data / timing related, or already fixed.' },
  rerunPage: { ru: 'Страница в момент падения при перезапуске', en: 'Page at failure in the re-run' },
  rerunNet: { ru: 'Упавшие запросы при перезапуске', en: 'Failed requests in the re-run' },
  failedIn: { ru: 'Падал в', en: 'Failed in' }, runs: { ru: 'прогонах', en: 'runs' }, newFailure: { ru: 'НОВОЕ падение.', en: 'NEW failure.' },
  oldNew: { ru: 'старые → новые', en: 'old → new' },
  blank: { ru: '**Тело страницы ПУСТОЕ в момент падения** (пустая страница: неожиданная навигация, редирект, падение или ничего не отрисовалось).', en: '**The page body is EMPTY at the moment of failure** (blank page: unexpected navigation, redirect, crash or nothing rendered).' },
  navigation: { ru: 'История навигации', en: 'Navigation history' },
  outline: { ru: 'Структура DOM (тег, ключевые атрибуты, текст)', en: 'DOM outline (tag, key attributes, text)' },
  truncated: { ru: '…(обрезано)', en: '…(truncated)' },
};

type PhraseKey = keyof typeof kPhrases;

const ansi = /\u001b\[[0-9;]*m/g;
const strip = (s: string) => (s || '').replace(ansi, '');

export function buildEvidence(input: EvidenceInput, maxChars: number): Evidence {
  const { test, trace, lang } = input;
  const T = (key: keyof typeof kTitles) => kTitles[key][lang];
  const P = (key: PhraseKey) => kPhrases[key][lang];
  const result = test.results[input.attempt] ?? test.results[test.results.length - 1];
  const failing = trace?.failingAction;
  const failingLocator = failing?.locator ?? matchLine(result?.errors[0]?.message, /^Locator: (.+)$/m);
  const expected = matchLine(result?.errors[0]?.message, /^Expected(?: string| pattern)?: (.+)$/m);
  const candidates = trace?.dom && failingLocator ? findLocatorCandidates(failingLocator, expected, trace.dom.elements, lang) : [];

  // Priority: lower number = kept first when the budget is tight.
  const sections: { priority: number, title: string, body: string }[] = [];
  const add = (priority: number, title: string, body: string | undefined) => {
    if (body && body.trim())
      sections.push({ priority, title, body: body.trim() });
  };

  add(0, T('test'), [
    `${P('title')}: ${[...test.path, test.title].join(' › ')}`,
    `${P('project')}: ${test.projectName || '—'}`,
    `${P('location')}: ${test.location.file}:${test.location.line}`,
    `${P('outcome')}: ${test.outcome}; ${P('analyzed')} #${input.attempt + 1} ${P('of')} ${test.results.length}`,
    `${P('attempts')}: ${test.results.map((r, i) => `#${i + 1} ${r.status} (${Math.round(r.duration)}ms)`).join(', ')}`,
  ].join('\n'));

  if (input.comment)
    add(0, T('hint'), input.comment);

  add(1, T('error'), (result?.errors || []).slice(0, 2).map(e => '```\n' + clip(strip(e.message), 40, 4000) + '\n```').join('\n'));

  if (failing) {
    add(1, T('failing'), [
      `${P('action')}: ${failing.title}`,
      failing.locator ? `${P('locator')}: ${failing.locator}` : '',
      failing.params ? `${P('params')}: ${failing.params}` : '',
      failing.endTime !== undefined ? `${P('duration')}: ${Math.round(failing.endTime - failing.startTime)}ms` : P('unfinished'),
      failing.logs.length ? `${P('callLog')}:\n\`\`\`\n` + failing.logs.slice(0, 30).join('\n') + '\n```' : '',
    ].filter(Boolean).join('\n'));
  }

  if (trace?.dom)
    add(2, T('page'), describeDom(trace.dom, trace.pageUrls, lang));

  if (candidates.length) {
    add(2, T('similar'), candidates.map(c => `- \`${c.code}\` — ${c.reason}; ${P('element')}: \`${c.element}\``).join('\n'));
  } else if (failingLocator && trace?.dom && !trace.dom.isBlank) {
    add(2, T('similar'), P('noneSimilar'));
  }

  if (input.lab?.length)
    add(2, T('lab'), describeLab(input.lab, lang));

  if (input.insight?.classification) {
    const c = input.insight.classification;
    add(3, T('classification'), `${c.kind} (${c.confidence}): ${c.reason}\n${c.evidence.map(e => `- ${e}`).join('\n')}`);
  }

  const failedRequests = trace?.failedRequests ?? [];
  if (failedRequests.length) {
    add(3, T('network'), failedRequests.map(n => `- ${n.method} ${n.url} → ${n.status || 'failed'} ${n.failure || n.statusText || ''}${n.requestBody ? `\n  request body: ${clip(n.requestBody, 3, 400)}` : ''}${n.responseBody ? `\n  response body: ${clip(n.responseBody, 5, 600)}` : ''}`).join('\n'));
  } else {
    const network = input.insight?.network ?? [];
    if (network.length)
      add(3, T('network'), network.map(n => `- ${n.method} ${n.url} → ${n.status || 'failed'} ${n.failure || n.statusText || ''}`).join('\n'));
  }

  const consoleIssues = trace?.console.length ? trace.console : input.insight?.console ?? [];
  if (consoleIssues.length)
    add(3, T('console'), consoleIssues.slice(0, 12).map(m => `- ${m.kind}: ${clip(m.text, 6, 600).replace(/\n/g, ' ⏎ ')}`).join('\n'));

  for (const source of input.sources || [])
    add(3, `${T('source')}: ${source.path}`, '```ts\n' + excerpt(source.content, source.focusLine, 45) + '\n```');

  if (result?.steps.length)
    add(4, T('steps'), renderSteps(result.steps).slice(0, 60).join('\n'));

  if (trace?.actions.length) {
    const failingIndex = failing ? trace.actions.indexOf(failing) : trace.actions.length - 1;
    const window = trace.actions.slice(Math.max(0, failingIndex - 25), failingIndex + 1);
    add(4, T('actions'), window.map(a => `- ${a.title}${a.locator ? ` ${a.locator}` : ''}${a.params ? ` (${a.params})` : ''}${a.endTime !== undefined ? ` — ${Math.round(a.endTime - a.startTime)}ms` : ''}${a.error ? ` ✘ ${clip(a.error, 1, 200)}` : ''}`).join('\n'));
  }

  if (trace?.requests.length)
    add(5, T('requests'), trace.requests.slice(-15).map(r => `- ${r.method} ${r.url} → ${r.status || r.failure || '?'}`).join('\n'));

  if (test.results.length > 1)
    add(4, T('attempts'), test.results.map((r, i) => `- #${i + 1}: ${r.status}${r.errors[0] ? ` — ${clip(strip(r.errors[0].message), 1, 200)}` : ''}`).join('\n'));

  const h = input.insight?.history;
  if (h && h.totalRuns > 1)
    add(5, T('history'), `${P('failedIn')} ${h.failedRuns} ${P('of')} ${h.totalRuns} ${P('runs')} (${P('oldNew')}: ${h.runs.map(r => r.outcome).join(' ')}).${h.isNewFailure ? ' ' + P('newFailure') : ''}`);

  if (input.rerun) {
    const r = input.rerun;
    const sameError = r.error && result?.errors[0] ? firstLine(r.error) === firstLine(strip(result.errors[0].message)) : undefined;
    add(1, T('rerun'), [
      `${P('status')}: ${r.status}${r.durationMs !== undefined ? ` ${P('in')} ${r.durationMs}ms` : ''}`,
      r.error ? `${T('error')}:\n\`\`\`\n` + clip(strip(r.error), 30, 3000) + '\n```' : '',
      sameError === true ? P('same') : sameError === false ? P('different') : '',
      r.status === 'passed' ? P('passedLocally') : '',
      r.trace?.dom ? `${P('rerunPage')}:\n` + describeDom(r.trace.dom, r.trace.pageUrls, lang) : '',
      r.trace?.network.length ? `${P('rerunNet')}:\n` + r.trace.network.map(n => `- ${n.method} ${n.url} → ${n.status || 'failed'}`).join('\n') : '',
    ].filter(Boolean).join('\n'));
  }

  if (input.errorContext && !trace?.dom)
    add(4, T('errorContext'), clip(input.errorContext, 200, 12000));

  // Fit into the budget: drop lowest-priority sections first, then cut the rest.
  sections.sort((a, b) => a.priority - b.priority);
  const render = (list: typeof sections) => list.map(s => `## ${s.title}\n\n${s.body}`).join('\n\n');
  let kept = [...sections];
  let truncated = false;
  while (render(kept).length > maxChars && kept.length > 2) {
    kept.pop();
    truncated = true;
  }
  let markdown = render(kept);
  if (markdown.length > maxChars) {
    markdown = markdown.slice(0, maxChars) + '\n' + P('truncated');
    truncated = true;
  }
  return { markdown, failingLocator, candidates, truncated };
}

function describeDom(dom: DomState, urls: string[], lang: Lang): string {
  const P = (key: PhraseKey) => kPhrases[key][lang];
  const lines = [`URL: ${dom.url}`];
  if (urls.length > 1)
    lines.push(`${P('navigation')}: ${urls.slice(-5).join(' → ')}`);
  if (dom.isBlank)
    lines.push(P('blank'));
  if (dom.outline)
    lines.push(`${P('outline')}:\n\`\`\`html\n` + clip(dom.outline, 150, 9000) + '\n```');
  return lines.join('\n');
}

function renderSteps(steps: ReportStep[], depth = 0, out: string[] = []): string[] {
  for (const s of steps) {
    out.push(`${'  '.repeat(depth)}- ${s.error ? '✘ ' : ''}${s.title} (${Math.round(s.duration)}ms)${s.location ? ` @${s.location.file}:${s.location.line}` : ''}${s.error ? ` — ${clip(strip(s.error), 1, 160)}` : ''}`);
    if (s.steps.length && depth < 3)
      renderSteps(s.steps, depth + 1, out);
  }
  return out;
}

// ---------- locator candidates ----------

type LocatorQuery = { kind: 'testid' | 'text' | 'role' | 'label' | 'placeholder' | 'css', value: string, role?: string };

export function parseLocator(locator: string): LocatorQuery | undefined {
  let m = locator.match(/getByTestId\(['"`](.+?)['"`]\)/);
  if (m)
    return { kind: 'testid', value: m[1] };
  m = locator.match(/getByRole\(['"`](\w+)['"`](?:,\s*\{\s*name:\s*['"`](.+?)['"`])?/);
  if (m)
    return { kind: 'role', role: m[1], value: m[2] ?? '' };
  m = locator.match(/getByText\(['"`](.+?)['"`]/);
  if (m)
    return { kind: 'text', value: m[1] };
  m = locator.match(/getByLabel\(['"`](.+?)['"`]/);
  if (m)
    return { kind: 'label', value: m[1] };
  m = locator.match(/getByPlaceholder\(['"`](.+?)['"`]/);
  if (m)
    return { kind: 'placeholder', value: m[1] };
  m = locator.match(/locator\(['"`](.+?)['"`]\)/);
  if (m)
    return { kind: 'css', value: m[1] };
  return undefined;
}

const kImplicitRoles: Record<string, string> = { button: 'button', a: 'link', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', input: 'textbox', select: 'combobox', li: 'listitem', ul: 'list', ol: 'list', table: 'table', tr: 'row', dialog: 'dialog', img: 'img', textarea: 'textbox', nav: 'navigation' };

export function findLocatorCandidates(locator: string, expectedText: string | undefined, elements: DomElement[], lang: Lang = 'ru'): LocatorCandidate[] {
  const ru = lang === 'ru';
  const query = parseLocator(locator);
  if (!query)
    return [];
  const wanted = normalize(query.value);
  const expected = expectedText ? normalize(expectedText.replace(/^"|"$/g, '')) : '';
  const scored: { score: number, candidate: LocatorCandidate }[] = [];
  for (const e of elements) {
    const testId = e.attrs['data-testid'] ?? e.attrs['data-test'] ?? e.attrs['data-qa'] ?? e.attrs['data-cy'] ?? e.attrs['data-test-id'];
    const role = e.attrs.role ?? kImplicitRoles[e.tag];
    const name = e.attrs['aria-label'] ?? e.text;
    let score = 0;
    const reasons: string[] = [];
    if (query.kind === 'testid' || query.kind === 'css') {
      const keys = [testId, e.attrs.id, ...(e.attrs.class ?? '').split(' ')].filter(Boolean) as string[];
      const best = Math.max(0, ...keys.map(k => similarity(wanted, normalize(k))));
      if (best >= 0.45) {
        score += best * 2;
        reasons.push(ru ? `атрибут похож на "${query.value}" (${Math.round(best * 100)}%)` : `attribute similar to "${query.value}" (${Math.round(best * 100)}%)`);
      }
    }
    if (query.kind === 'text' || query.kind === 'label' || query.kind === 'role') {
      const s = wanted ? Math.max(similarity(wanted, normalize(name)), normalize(name).includes(wanted) ? 0.9 : 0) : 0;
      if (s >= 0.5) {
        score += s * 2;
        reasons.push(ru ? `текст похож на "${query.value}" (${Math.round(s * 100)}%)` : `text similar to "${query.value}" (${Math.round(s * 100)}%)`);
      }
      if (query.kind === 'role' && role === query.role) {
        score += 0.5;
        reasons.push(ru ? `та же роль "${role}"` : `same role "${role}"`);
      }
    }
    if (query.kind === 'placeholder' && e.attrs.placeholder) {
      const s = similarity(wanted, normalize(e.attrs.placeholder));
      if (s >= 0.5) {
        score += s * 2;
        reasons.push(ru ? `placeholder похож (${Math.round(s * 100)}%)` : `placeholder similar (${Math.round(s * 100)}%)`);
      }
    }
    if (expected && e.text && normalize(e.text).length < 200) {
      const s = similarity(expected, normalize(e.text));
      if (s >= 0.6 || (normalize(e.text).includes(expected.split(' ')[0]) && expected.length > 2)) {
        score += Math.max(s, 0.6);
        reasons.push(ru ? `текст "${e.text.slice(0, 40)}" похож на ожидаемое значение` : `text "${e.text.slice(0, 40)}" resembles the expected value`);
      }
    }
    if (score > 0)
      scored.push({ score, candidate: { code: suggestLocator(e, testId, role, name), reason: reasons.join(', '), element: elementSummary(e) } });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return scored.filter(s => !seen.has(s.candidate.code) && seen.add(s.candidate.code)).slice(0, 5).map(s => s.candidate);
}

function suggestLocator(e: DomElement, testId: string | undefined, role: string | undefined, name: string): string {
  if (testId)
    return `page.getByTestId('${testId}')`;
  if (role && name && name.length <= 50 && ['button', 'link', 'heading', 'checkbox', 'tab', 'menuitem', 'option'].includes(role))
    return `page.getByRole('${role}', { name: '${name.replace(/'/g, '\\\'')}' })`;
  if (e.attrs.id)
    return `page.locator('#${e.attrs.id}')`;
  if (e.attrs['aria-label'])
    return `page.getByLabel('${e.attrs['aria-label']}')`;
  if (e.attrs.placeholder)
    return `page.getByPlaceholder('${e.attrs.placeholder}')`;
  if (e.attrs.class)
    return `page.locator('${e.tag}.${e.attrs.class.split(' ')[0]}')`;
  return `page.getByText('${name.slice(0, 40).replace(/'/g, '\\\'')}')`;
}

function elementSummary(e: DomElement): string {
  const attrs = Object.entries(e.attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<${e.tag}${attrs ? ' ' + attrs : ''}>${e.text ? e.text.slice(0, 60) : ''}`;
}

function normalize(text: string): string {
  return (text || '').toLowerCase().replace(/[-_\s]+/g, ' ').replace(/\d+/g, '0').trim();
}

/** Dice coefficient over character bigrams: robust for "cart-counter" vs "cart". */
function similarity(a: string, b: string): number {
  if (!a || !b)
    return 0;
  if (a === b)
    return 1;
  if (b.includes(a) || a.includes(b))
    return 0.6 + 0.4 * Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const bigrams = (s: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++)
      map.set(s.slice(i, i + 2), (map.get(s.slice(i, i + 2)) ?? 0) + 1);
    return map;
  };
  const x = bigrams(a);
  const y = bigrams(b);
  let overlap = 0;
  for (const [k, v] of x)
    overlap += Math.min(v, y.get(k) ?? 0);
  return (2 * overlap) / Math.max(1, a.length - 1 + b.length - 1);
}

// ---------- helpers ----------

export function excerpt(content: string, focusLine: number | undefined, radius: number): string {
  const lines = content.split('\n');
  const width = String(lines.length).length;
  const from = focusLine ? Math.max(0, focusLine - 1 - radius) : 0;
  const to = focusLine ? Math.min(lines.length, focusLine + radius) : Math.min(lines.length, radius * 2);
  return lines.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(width)}${from + i + 1 === focusLine ? ' >' : '  '} ${l}`).join('\n');
}

export function sourceForPath(trace: TraceData | undefined, absolutePath: string): string | undefined {
  return trace?.sources.get(sha1(absolutePath));
}

function matchLine(text: string | undefined, re: RegExp): string | undefined {
  return text ? strip(text).match(re)?.[1]?.trim() : undefined;
}

function firstLine(text: string): string {
  return text.split('\n').map(l => l.trim()).find(Boolean) ?? '';
}

function clip(text: string, maxLines: number, maxChars: number): string {
  const lines = (text || '').split('\n');
  let out = lines.slice(0, maxLines).join('\n');
  if (lines.length > maxLines)
    out += `\n… (${lines.length - maxLines} more lines)`;
  return out.length > maxChars ? out.slice(0, maxChars) + '…' : out;
}
