# Подключение LLM и скилла анализа

> Для разбора **отдельных** упавших тестов и **групп ошибок** в отчёте есть встроенный AI-агент (GigaChat, GigaCode,
> Proxy LLM, MCP): см. [AGENT.md](AGENT.md). Разбор групп можно подготовить прямо в CI командой
> `pw-extended-report analyze` ([DEPLOYMENT.md](DEPLOYMENT.md)). Этот документ — про анализ **прогона целиком** вашим скиллом.

Пакет не вызывает LLM сам. Это сделано сознательно: в закрытом контуре своя модель, свои ключи
и свои правила передачи данных. Пакет готовит **входные данные** и **точку вывода** (вкладку).

```
playwright test ──► extended-report/
                     ├ report-summary.json   ──┐  вход для скилла или LLM
                     ├ data/*.md (error-context)│
                     └ index.html               │
                                                ▼
                               ваш скилл / LLM ──► analysis.md
                                                ▼
                     pw-extended-report add-analysis --file analysis.md
```

## Входные данные

### `report-summary.json`

```jsonc
{
  "status": "failed",
  "stats": { "total": 9, "expected": 2, "unexpected": 5, "flaky": 1, "skipped": 1, "failureRate": 0.625 },
  "projects": ["chromium"],
  "metadata": { /* config.metadata, в т.ч. git-коммит, если включён captureGitInfo */ },
  "failedTests": [{
    "testId": "f3cf…",                 // для точной ссылки #?testId=
    "title": "adds item to cart",
    "titlePath": ["cart", "adds item to cart"],
    "projectName": "chromium",
    "file": "shop.spec.ts", "line": 20,
    "outcome": "unexpected",           // или "flaky"
    "status": "failed", "retries": 1,
    "error": "Error: expect(locator).toHaveText(expected) failed\n\nLocator: …",
    "errorLocation": "shop.spec.ts:23",
    "attachments": [{ "name": "error-context", "contentType": "text/markdown", "path": "/abs/path/error-context.md" },
                    { "name": "trace", "path": "…/trace.zip" }, { "name": "screenshot", "path": "…png" }],
    "clusterId": 1
  }],
  "clusters": [{ "id": 1, "category": "Assertion", "signature": "…", "sampleError": "…", "testIds": ["…"], "topLocation": "shop.spec.ts:23" }]
}
```

Пути во `attachments` абсолютные, внутри `test-results/` (на агенте Jenkins они существуют до очистки workspace).

### `error-context.md`

В свежих версиях Playwright (1.5x+) для каждого упавшего теста создаётся вложение `error-context`. В нём ARIA-снапшот
страницы на момент падения, ошибка и код теста. Именно его штатный отчёт кладёт в «Copy prompt».
Для LLM это **самый ценный контекст**: модель видит, какие элементы реально были на странице.

## Рекомендуемый промпт

```text
Ты — QA-инженер, анализируешь результаты прогона Playwright.
Даны: сводка прогона (JSON) и для каждого кластера ошибок — пример ошибки и error-context (ARIA-снапшот).

Для каждого кластера:
1. Классифицируй: Product bug / Test bug (локатор, ожидание) / Environment (сеть, стенд, данные) / Flaky.
2. Объясни вероятную причину в 1–2 предложениях, опираясь на снапшот.
3. Предложи конкретное исправление (код), если это Test bug.

Формат ответа — Markdown:
## <N>. <краткое название> — <категория>, <кол-во> тестов
Список тестов ссылками вида [название](#?testId=<testId>)
Причина, исправление.
В конце — таблица «Категория / Кол-во тестов» и чек-лист действий.
```

Ссылки `#?testId=…` делают вывод кликабельным внутри отчёта. Если модель знает только название теста,
подойдёт `#?test=<название>` (см. CUSTOM_TABS.md).

## Пример скрипта-обёртки

```ts
// tools/ai-analyze.ts — запуск: npx tsx tools/ai-analyze.ts
import fs from 'fs';
import { upsertSection } from 'playwright-extended-report';

const summary = JSON.parse(fs.readFileSync('extended-report/report-summary.json', 'utf-8'));
if (!summary.failedTests.length)
  process.exit(0);

const context = summary.clusters.slice(0, 10).map((c: any) => {
  const sample = summary.failedTests.find((t: any) => t.clusterId === c.id);
  const ec = sample.attachments.find((a: any) => a.name === 'error-context')?.path;
  return { cluster: c, tests: summary.failedTests.filter((t: any) => t.clusterId === c.id).map((t: any) => ({ testId: t.testId, title: t.titlePath.join(' › ') })),
           errorContext: ec && fs.existsSync(ec) ? fs.readFileSync(ec, 'utf-8').slice(0, 20000) : undefined };
});

const markdown = await callYourLLM(PROMPT, JSON.stringify({ stats: summary.stats, clusters: context }));  // ваша модель

// Во вкладку Failure analysis, секцией над автоматической группировкой.
await upsertSection('extended-report', 'failures', {
  id: 'skill', title: 'Skill analysis', order: 10,
  content: markdown, source: 'internal-llm', generatedAt: new Date().toISOString(),
});
```

Советы:

- Отправляйте в модель **кластеры, а не все тесты**: 40 одинаковых падений — это один запрос, а не сорок.
- Обрезайте снапшоты и логи (лимит контекста, стоимость). Убирайте секреты и токены из логов до отправки.
- Кешируйте ответ по `cluster.signature`: та же ошибка в следующем прогоне не требует нового запроса.

## «Агент по клику» в отчёте

Реализован: кнопки **Ask AI** и **Fix ▾** в карточках Insights и на странице каждого упавшего теста.
Агент сам читает трейс, перезапускает тест, предлагает и применяет правку. Ключи модели остаются в процессе
`pw-extended-report agent` / `ai-gateway`, в отчёт не попадают. Подробнее: [AGENT.md](AGENT.md).
