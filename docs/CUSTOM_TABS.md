# Свои вкладки

## Анализ скилла — во вкладку Failure analysis

Для вывода вашего скилла отдельная вкладка не нужна: он ложится секцией во встроенную Failure analysis,
над автоматической группировкой ошибок.

```bash
npx pw-extended-report add-analysis extended-report --file analysis.md --source "jenkins-log-skill #123"
```

Секции можно добавлять в любую Markdown/HTML-вкладку: `add-section --tab <tab-id> --id <id> --title ... --file ...`
(повтор с тем же id заменяет секцию), удалять — `remove-section`. Программно: `upsertSection(reportDir, tabId, {...})`.
На этапе генерации: `failureClusters: { sections: [{ id: 'skill', title: 'Skill analysis', file: './analysis.md', optional: true }] }`.

## Три способа добавить свою вкладку

1. **CLI после прогона**: основной сценарий для Jenkins.
   ```bash
   npx pw-extended-report add-tab extended-report --id ai --title "AI анализ" --icon sparkle --file analysis.md
   ```
2. **Опция репортёра**, если файл уже существует на момент окончания прогона:
   ```ts
   ['playwright-extended-report', { tabs: [
     { id: 'env', title: 'Окружение', file: './env.md', optional: true },
     { id: 'links', title: 'Ссылки', content: '- [Grafana](https://grafana/...)' },
   ] }]
   ```
3. **Программно** из Node-скрипта (например, из вашего скилла или LLM-агента):
   ```ts
   import { upsertTab } from 'playwright-extended-report';
   await upsertTab('extended-report', { id: 'ai', title: 'AI', content: markdown, icon: 'sparkle', badge: 3, badgeKind: 'danger' });
   ```

Повторное добавление с тем же `id` заменяет вкладку. Удаление: `pw-extended-report remove-tab --id ai`.

## Формат вкладки

```ts
type ExtendedTab = {
  id: string;                 // [A-Za-z0-9_-]+, URL: #?tab=<id>
  title: string;
  format: 'markdown' | 'html' | 'iframe';
  content: string;            // markdown/html-текст или URL для iframe
  icon?: 'sparkle' | 'bug' | 'graph' | 'note' | 'list' | 'none';
  badge?: string | number;
  badgeKind?: 'default' | 'danger' | 'attention' | 'success';
  order?: number;             // встроенная Failure analysis = 100
  description?: string;
  generatedAt?: string;       // ISO
  source?: string;
};
```

Исходник: [`src/shared/tabsFormat.ts`](../src/shared/tabsFormat.ts). В `index.html` вкладки хранятся
последним блоком: `<template id="extendedReportTabs">BASE64(JSON)</template>`.

## Форматы

| Формат | Когда использовать | Безопасность |
|---|---|---|
| `markdown` | Вывод скилла или LLM, отчёты, таблицы, чек-листы | Рендер `marked` (GFM), затем `DOMPurify` |
| `html` | Готовый HTML-фрагмент без скриптов | `DOMPurify`: `<script>`, `on*`, `<style>`, формы вырезаются |
| `iframe` | Страница со своим JS (графики, дашборд) | Копируется в `tabs/<id>/`, открывается в `sandbox`-iframe |

Для `iframe` передайте папку с `index.html` (`--file ./my-dashboard/`); она целиком копируется в отчёт.
Страница должна быть самодостаточной: относительные пути внутри папки, без внешних CDN, если отчёт смотрят в закрытом контуре.

## Ссылки из Markdown в отчёт

| Ссылка | Что делает |
|---|---|
| `[x](#?test=cart › adds item)` | Открывает тест по названию. Ищет точное совпадение полного пути `describe › title`, затем по названию, затем по суффиксу и подстроке. Если упавших копий несколько (проекты), берёт упавшую. Если ничего не найдено, переходит к поиску. |
| `[x](#?test=login&project=firefox)` | То же, но только в указанном проекте. |
| `[x](#?testId=<id>)` | Точный переход (id есть в `report-summary.json`). |
| `[x](#?q=s:failed @smoke)` | Любой фильтр штатного поиска. |
| `[x](#?tab=failures)` | Другая вкладка. |
| `[x](#section-name)` | Скролл к заголовку внутри вкладки. id заголовков генерируются из текста. |
| `https://…` | Открывается в новой вкладке браузера. |

Пробелы в Markdown-ссылке кодируйте как `%20` или берите адрес в угловые скобки:
`[x](<#?test=cart › adds item>)`. Внутри угловых скобок нельзя использовать `>`, поэтому
разделитель `describe › title` пишите символом `›`. В закодированном виде допустим и ` > `:
`#?test=cart%20>%20adds%20item`.

## Как добавить свой тип вкладки в UI (для разработчиков пакета)

Например, нужна вкладка с интерактивной таблицей, которая читает данные отчёта.

1. Добавьте значение в `ExtendedTabFormat` в `src/shared/tabsFormat.ts` и в `validateTab`.
2. В `web/src/extended/extendedTabView.tsx`, в `TabContent`, отрендерите новый формат.
   Компоненту доступны `report.json()` (вся сводка прогона) и `report.entry('<fileId>.json')` (детали тестов).
3. Переиспользуйте компоненты штатного отчёта: `AutoChip`, `TestFileView`, `Link`, `navigate`, `statusIcon`.
   Так стиль останется единым.
4. `npm run build && npm test`.

Для новой встроенной вкладки, которая вычисляется на стороне репортёра (как Failure analysis),
добавьте её в `_buildExtras()` в `src/reporter/html.ts`. Данные `api.Suite` там уже доступны.
