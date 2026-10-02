# Архитектура

## Как устроен штатный HTML-отчёт Playwright

Отчёт состоит из двух независимых частей.

### 1. UI: `packages/html-reporter`

React-приложение на Vite. Сборка (`vite.config.ts`) выдаёт три файла:
`index.html`, `report.js`, `report.css` и кладёт их в `playwright-core/lib/vite/htmlReport/`.
Важные настройки: `inlineDynamicImports`, `cssCodeSplit: false`, `assetsInlineLimit: 100MB`.
Всё собирается в один JS и один CSS, картинки инлайнятся.

Ключевые файлы UI:

| Файл | Что делает |
|---|---|
| `index.tsx` | Точка входа. Читает `<template id="playwrightReportBase64">`, распаковывает zip (`@zip.js/zip.js`), рендерит `ReportView`. |
| `reportView.tsx` | Роутинг по hash: `#?` — список тестов, `#?testId=` — тест, `#?speedboard` — самые медленные тесты. |
| `headerView.tsx` | Панель `All / Passed / Failed / Flaky / Skipped`, кнопка Speedboard, настройки темы. |
| `links.tsx` | Мини-роутер: `navigate()` (pushState + popstate), `Route`, `useSearchParams`. |
| `filter.ts` | Язык поиска: `s:failed`, `p:chromium`, `@tag`, `annot:`, текст. |
| `testResultView.tsx` | Ошибки, шаги, вложения, скриншоты, diff, кнопка «Copy prompt». |
| `types.d.ts` | Формат данных `HTMLReport`, `TestFile`, `TestCase`… — контракт между репортёром и UI. |

Общие компоненты лежат в `packages/web/src` (`@web/*`), утилиты — в `packages/isomorphic` (`@isomorphic/*`).

### 2. Репортёр: `packages/playwright/src/reporters/html.ts`

1. В `onEnd` обходит дерево `Suite → project → file → describe → test`.
2. Для каждого файла строит `TestFile` (полные данные) и `TestFileSummary` (для списка).
3. Вложения копирует в `data/<sha1>.<ext>`; stdout/stderr склеивает; для шагов вырезает сниппеты кода (`@babel/code-frame`).
4. Все JSON (`report.json` + `<fileId>.json`) складывает в zip (`yazl`).
5. Пишет `index.html`: HTML, затем JS и CSS инлайн, затем
   `<template id="playwrightReportBase64">data:application/zip;base64,…</template>` в конец файла.
6. Если есть трейсы, копирует trace viewer из `playwright-core/lib/vite/traceViewer` в `trace/`.

Итог — самодостаточная папка: `index.html` + `data/` + `trace/`.

## Что сделано в этом проекте

```
              ┌─────────────────────────── npm-пакет ───────────────────────────┐
playwright    │ dist/reporter (Node)           dist/web (UI)                    │
test run ───► │  html.ts (порт штатного)  ──►  index.html/report.js/report.css  │
              │  + failureClusters             (UI штатного + extended/)        │
              │  + tabs.ts                                                       │
              └───────────────┬──────────────────────────────────────────────────┘
                              ▼
               extended-report/index.html
                 ├ UI (inline)
                 ├ <template id="playwrightReportBase64">  данные прогона
                 └ <template id="extendedReportTabs">      вкладки (base64 JSON), всегда последний
               extended-report/data/  trace/  tabs/<id>/  report-summary.json
                              ▲
   pw-extended-report add-tab ┘  (обрезает файл с начала блока вкладок и дописывает новый)
```

### Изменения в UI (минимальные, ради лёгкого мержа)

Патчи в upstream-файлах помечены `[extended-report]`:

- `headerView.tsx`: в панель добавлен `<ExtendedTabsNav />`; фильтры статусов сбрасывают параметр `tab`.
- `reportView.tsx`: новый маршрут `#?tab=<id>`; список тестов скрыт, пока открыта вкладка; горячие клавиши `p` и `f` сбрасывают `tab`.

Весь остальной код в `web/src/extended/`:

- `extendedTabs.ts` — чтение `<template id="extendedReportTabs">`;
- `extendedTabView.tsx` — навигация, вид вкладки, резолв ссылок `#?test=`;
- `markdown.ts` — `marked` + `DOMPurify` (контент от LLM недоверенный);
- `extendedTabs.css` — стили на CSS-переменных отчёта, светлая и тёмная темы работают автоматически.

### Изменения в репортёре (`src/reporter/html.ts`)

- Публичный Reporter API (`onBegin(config, suite)`) вместо внутреннего `ReporterV2`. Это и даёт
  совместимость между версиями Playwright.
- Внутренние `@utils/*`, `./base`, `../util` заменены на `compat.ts` (sha1, форматирование ошибок, ANSI и т. п.).
- UI берётся из `dist/web` этого пакета, trace viewer — из `playwright-core` проекта.
- Свои опции и переменные окружения (`EXTENDED_REPORT_*`).
- Дополнительно: вкладка Failure analysis, вкладки из опции `tabs`, `report-summary.json`.
- Не поддерживается: таймлайн шардов в Speedboard (`machines`). Для него нужен внутренний API
  `onReportConfigure/onReportEnd`, поэтому в merge-отчёте этот блок пустой. Остальное работает.

### Почему не патч поверх `node_modules/playwright`

Патч сломается при первом же обновлении Playwright. Здесь UI и репортёр — собственный код
со своим форматом данных. От Playwright нужен только публичный Reporter API, а он стабилен
между версиями. Новые возможности UI переносятся осознанно через [UPSTREAM_SYNC.md](UPSTREAM_SYNC.md).

## AI-агент

Агент — Node-код в `src/agent/`, запускается командами CLI (`agent`, `show --ai`, `ai-gateway`, `analyze`);
в отчёте только UI (`web/src/extended/agent`, `insights`). Подробно — [AGENT.md](AGENT.md), [DEPLOYMENT.md](DEPLOYMENT.md).

| Модуль | Что делает |
|---|---|
| `trace.ts` | Разбор `trace.zip`: действия и лог ожидания, упавшее действие, шаги, сеть (с телами), консоль, DOM в момент падения (восстановление снапшотов со ссылками), исходники из `src/`. |
| `evidence.ts` | Пакет доказательств для модели (приоритеты секций, бюджет `EXTENDED_REPORT_AI_MAX_CHARS`), поиск похожих элементов. |
| `locatorLab.ts` | Безопасный разбор цепочек локаторов, проверка на HTML страницы в момент падения в headless Chromium. |
| `llm.ts` | Провайдеры: OpenAI-compatible (proxy), GigaChat (OAuth, `functions`), GigaCode IFT SSL (mTLS), GigaCode CLI. |
| `mcp.ts` | Собственный MCP-клиент (stdio / Streamable HTTP / SSE), конфиг `mcpServers`, allowlist инструментов. |
| `toolLoop.ts` | MCP-путь: цикл вызовов инструментов; при сбое — простой путь в `service.ts`. |
| `edits.ts`, `repo.ts` | Правки SEARCH/REPLACE, дифф, поиск файлов в репозитории, запуск тестов (JSON-репортёр). |
| `service.ts` | HTTP API и задачи: analyze / debug / fix / apply / revert / lab, группы, Open in IDE. |
| `batch.ts` | `analyze` в CI: разбор групп и запись результатов в отчёт. |
