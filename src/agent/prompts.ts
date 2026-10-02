/**
 * Prompts of the agent. Written for mid-size internal models: explicit rules,
 * a fixed answer structure, a reminder to check the engineer's hint.
 * Russian by default (EXTENDED_REPORT_AI_LANGUAGE=English switches to English);
 * code, locators, commands and error texts always stay as they are.
 */

export type Lang = 'ru' | 'en';

const kRules: Record<Lang, string> = {
  ru: `Ты — опытный инженер по автоматизации тестирования на Playwright. Ты разбираешь упавшие end-to-end тесты, опираясь ТОЛЬКО на предоставленные доказательства.

Правила:
- Каждый вывод подкрепляй конкретным фактом (текст ошибки, лог ожидания, DOM на момент падения, сеть, консоль, исходный код) и цитируй его.
- Различай: ОШИБКА ТЕСТА (неверный/устаревший локатор, неправильное ожидание, неверное ожидаемое значение в тесте, плохие тестовые данные),
  БАГ ПРОДУКТА (приложение падает, показывает неверные данные, ведёт себя неправильно), ОКРУЖЕНИЕ (5xx бэкенда, сеть, стенд/авторизация/конфигурация недоступны),
  ИЗМЕНЕНИЕ UI (намеренное изменение интерфейса, тест должен за ним следовать), НЕСТАБИЛЬНЫЙ ТЕСТ (тайминги/гонки, проходит на ретрае).
- НЕ предполагай проблемы с авторизацией, если в доказательствах нет страницы логина, ответов 401/403 или редиректа на авторизацию.
- Если в DOM на момент падения есть элемент, который явно соответствует тому, что ищет тест, но под другим селектором, — скорее всего устарел локатор.
- Если страница на момент падения пустая — ищи причину в том, что произошло ДО этого (навигация, редирект, отправка формы, страница не отрисовалась), а не в локаторе.
- Если есть «Подсказка инженера» — это важный контекст от человека, который знает систему: сначала проверь её по доказательствам и явно напиши, подтверждается ли она.
- Предпочитай web-first проверки и пользовательские локаторы (getByRole, getByTestId, getByLabel). Никогда не предлагай waitForTimeout или networkidle.
- Никогда не «чини» баг продукта или проблему окружения ослаблением проверок.
- Отвечай на русском языке. Код, локаторы, команды и тексты ошибок оставляй как есть.`,
  en: `You are a senior Playwright test automation engineer. You debug failed end-to-end tests using ONLY the evidence provided.

Rules:
- Base every conclusion on concrete evidence (error text, call log, DOM at failure, network, console, source). Quote it.
- Distinguish: TEST BUG (wrong/outdated locator, wrong wait, wrong expected value in the test, bad test data),
  PRODUCT BUG (app throws, shows wrong data, broken behaviour), ENVIRONMENT (backend 5xx, network, stand/auth/config down),
  UI CHANGE (intentional UI change, test must follow), FLAKY (timing/race, passes on retry).
- Do NOT guess authentication problems unless the evidence shows a login page, 401/403 responses or an auth redirect.
- If the DOM at failure contains an element that clearly matches what the test looks for under another selector, it is most likely an outdated locator.
- If the page is empty at the moment of failure, look at what happened BEFORE (navigation, redirect, form submit, nothing rendered), not at the locator.
- If "Hint from the engineer" is present, treat it as strong context from a human who knows the system: check it against the evidence first, and say explicitly whether the evidence confirms it.
- Prefer web-first assertions and user-facing locators (getByRole, getByTestId, getByLabel). Never suggest waitForTimeout or networkidle.
- Never "fix" a product bug or an environment problem by weakening assertions.
- Answer in English.`,
};

export const kVerdicts: Record<Lang, string> = {
  ru: 'ОШИБКА ТЕСТА | БАГ ПРОДУКТА | ОКРУЖЕНИЕ | ИЗМЕНЕНИЕ UI | НЕСТАБИЛЬНЫЙ ТЕСТ',
  en: 'TEST BUG | PRODUCT BUG | ENVIRONMENT | UI CHANGE | FLAKY',
};

export function systemPrompt(lang: Lang): string {
  return kRules[lang];
}

export function analyzePrompt(lang: Lang, evidence: string): string {
  if (lang === 'ru') {
    return `Разбери, почему упал этот тест Playwright.

${evidence}

Ответь в Markdown строго с такими разделами:
## Вердикт
Одна строка: **<${kVerdicts.ru}>** — краткая причина. Уверенность: высокая/средняя/низкая.
## Что произошло
2–5 предложений по шагам: что делал тест и где/почему сломался. Укажи упавший шаг и file:line.
## Доказательства
Список фактов, которые это подтверждают (цитаты ошибки, строк лога, элементов DOM, запросов).
## Как исправить
Конкретные действия. Для ошибки теста — исправленный код Playwright (TypeScript). Для бага продукта / окружения — что и кому сообщить, что проверить; никаких правок теста, скрывающих проблему.
## Как проверить
Команда или проверка, подтверждающая исправление.`;
  }
  return `Analyze why this Playwright test failed.

${evidence}

Answer in Markdown with exactly these sections:
## Verdict
One line: **<${kVerdicts.en}>** — short reason. Confidence: high/medium/low.
## What happened
2–5 sentences, step by step, what the test did and where/why it broke. Reference the failing step and file:line.
## Evidence
Bullet list of the facts that prove it (quote error, log lines, DOM elements, requests).
## How to fix
Concrete actions. For a test bug give the corrected Playwright code (TypeScript). For a product bug / environment: what to report and to whom, what to check; no test changes that hide the problem.
## How to verify
The command or check that confirms the fix.`;
}

export function debugPrompt(lang: Lang, evidence: string): string {
  if (lang === 'ru') {
    return `Агент только что перезапустил этот тест локально (см. раздел «Локальный перезапуск»). Сравни исходное падение с перезапуском и определи первопричину.

${evidence}

Ответь в Markdown с разделами: ## Вердикт, ## Результат перезапуска (воспроизвелось или нет, та же ошибка или нет, что это значит), ## Первопричина, ## Как исправить, ## Как проверить.`;
  }
  return `The agent has just re-run this test locally (see "Local re-run" section). Compare the original failure with the re-run and determine the root cause.

${evidence}

Answer in Markdown with sections: ## Verdict, ## Re-run result (reproduced or not, same error or not, what it means), ## Root cause, ## How to fix, ## How to verify.`;
}

export function clusterPrompt(lang: Lang, evidence: string, others: string): string {
  if (lang === 'ru') {
    return `Несколько тестов упали с одной и той же ошибкой. Ниже — подробные доказательства по одному представителю группы и краткие данные по остальным. Найди общую первопричину.

${evidence}

## Остальные тесты группы
${others}

Ответь в Markdown с разделами: ## Вердикт (для всей группы), ## Общая причина, ## Чем тесты отличаются (если отличаются), ## Как исправить (одно исправление для всех, где возможно), ## Как проверить.`;
  }
  return `Several tests failed with the same error. Below is the full evidence for one representative test and short data for the others. Find the common root cause.

${evidence}

## Other tests of the group
${others}

Answer in Markdown with sections: ## Verdict (for the whole group), ## Common cause, ## How the tests differ (if they do), ## How to fix (one fix for all where possible), ## How to verify.`;
}

export function fixPrompt(lang: Lang, evidence: string, files: { path: string, content: string }[], analysis?: string, previousAttempt?: string, group?: string): string {
  const fileBlock = files.map(f => `FILE: ${f.path}\n\`\`\`ts\n${f.content}\n\`\`\``).join('\n\n');
  const format = `FILE: <path>
<<<<<<< SEARCH
<lines>
=======
<lines>
>>>>>>> REPLACE`;
  if (lang === 'ru') {
    return `Предложи минимальное изменение кода, которое исправит ${group ? 'ВСЕ тесты группы' : 'этот упавший тест Playwright'}.

${evidence}
${group ? `\n## Остальные тесты группы (исправь их тоже)\n${group}\n` : ''}${analysis ? `\n## Предыдущий анализ\n\n${analysis}\n` : ''}${previousAttempt ? `\n## Предыдущая попытка исправления НЕ помогла\n\n${previousAttempt}\n\nПредложи другое исправление.\n` : ''}
## Файлы, которые можно менять

${fileBlock}

Инструкции:
- Меняй только необходимое (обычно локатор, ожидание или ожидаемое значение). Сохраняй стиль файла.
- Если это БАГ ПРОДУКТА или проблема ОКРУЖЕНИЯ — не меняй проверки: оберни тест в test.fixme() с комментарием, почему.
- Ответ: короткий раздел «## Объяснение» на русском, затем один или несколько блоков правок СТРОГО в таком формате:

${format.replace('<path>', '<путь ровно как в списке выше>').replace('<lines>', '<строки, скопированные из файла ДОСЛОВНО, с отступами, достаточно для уникальности>').replace('<lines>', '<новые строки>')}`;
  }
  return `Propose a minimal code change that fixes ${group ? 'ALL tests of the group' : 'this failing Playwright test'}.

${evidence}
${group ? `\n## Other tests of the group (fix them too)\n${group}\n` : ''}${analysis ? `\n## Previous analysis\n\n${analysis}\n` : ''}${previousAttempt ? `\n## Previous fix attempt FAILED\n\n${previousAttempt}\n\nPropose a different fix.\n` : ''}
## Files you may change

${fileBlock}

Instructions:
- Change only what is needed (usually a locator, a wait or an expected value). Keep the style of the file.
- If the failure is a PRODUCT BUG or ENVIRONMENT problem, do not change assertions: instead wrap the test with test.fixme() and a comment explaining why.
- Answer with a short "## Explanation" section, then one or more edit blocks in EXACTLY this format:

${format.replace('<path>', '<path exactly as listed above>').replace('<lines>', '<lines copied EXACTLY from the file, including indentation, enough to be unique>').replace('<lines>', '<replacement lines>')}`;
}

export function fixRetryMessage(lang: Lang, problems: string[]): string {
  if (lang === 'ru')
    return `Твои блоки правок не удалось применить:\n${problems.map(p => `- ${p}`).join('\n')}\n\nОтветь заново только исправленными блоками правок. Часть SEARCH должна быть скопирована из содержимого файла выше символ в символ.`;
  return `Your edit blocks could not be applied:\n${problems.map(p => `- ${p}`).join('\n')}\n\nReply again with corrected edit blocks only. The SEARCH part must be copied character by character from the file content above.`;
}

/** Added to the user prompt when MCP / built-in tools are offered to the model. */
export function toolsGuide(lang: Lang, toolNames: string[]): string {
  if (lang === 'ru') {
    return `\n\n## Инструменты\nТебе доступны инструменты: ${toolNames.join(', ')}.
Используй их, если доказательств выше недостаточно: найди код page object / хелпера / фикстуры, которые использует упавший шаг (serena, code-index, codebase-memory), уточни API Playwright (context7), проверь локатор на DOM момента падения (agent__locator_lab), прочитай файл (agent__read_source).
Не вызывай инструменты без необходимости: обычно хватает 1–4 вызовов. Когда информации достаточно — дай финальный ответ в требуемом формате без вызова инструментов.`;
  }
  return `\n\n## Tools\nYou can use these tools: ${toolNames.join(', ')}.
Use them when the evidence above is not enough: find the page object / helper / fixture code used by the failing step (serena, code-index, codebase-memory), check the Playwright API (context7), verify a locator against the DOM at failure (agent__locator_lab), read a file (agent__read_source).
Do not call tools without need: 1–4 calls are usually enough. When you have enough information, give the final answer in the required format without calling tools.`;
}

export function finalAnswerNudge(lang: Lang): string {
  return lang === 'ru' ? 'Достаточно. Дай финальный ответ в требуемом формате, без вызова инструментов.' : 'That is enough. Give the final answer in the required format without calling tools.';
}
