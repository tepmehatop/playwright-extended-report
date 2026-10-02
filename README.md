# playwright-extended-report

Клон штатного HTML-отчёта Playwright с дополнительными вкладками и **AI-агентом для упавших тестов**,
который работает с моделями закрытого контура (Proxy LLM, GigaChat, GigaCode):

- **Failure analysis** — анализ вашего скилла (логи Jenkins) и встроенная группировка ошибок в одной вкладке;
- **Insights** — классификация каждого падения, сеть и консоль из трейса, сравнение попыток, история;
- **Ask AI / Fix** — глубокий анализ по трейсу и DOM, перезапуск и отладка, правка с диффом, применение и откат по кнопке;
- свои вкладки с любым Markdown, HTML или страницей.

Это **отдельный репортёр**: штатный `html`-отчёт продолжает генерироваться как раньше,
а расширенный пишется в свою папку (`extended-report/` по умолчанию). Внешний вид, навигация,
фильтры, trace viewer, «Copy prompt» те же, что у штатного отчёта, потому что UI скопирован
из исходников Playwright.

![Вкладка Insights](docs/images/insights-light.png)

<details>
<summary>Ещё скриншоты (тёмная тема, Failure analysis, обзор)</summary>

![Вкладка с AI-анализом](docs/images/ai-tab-light.png)
![Failure analysis, тёмная тема](docs/images/failures-tab-dark.png)
![Обзор](docs/images/overview-light.png)

</details>

## Попробовать за минуту

```bash
npm ci && npm run build && npx playwright install chromium
npm run demo        # 5 прогонов демо-проекта (копится история), AI-вкладка, отчёт на http://localhost:9324
```

## Что умеет

- **Свои вкладки** в верхней панели рядом с `All / Passed / Failed / Flaky / Skipped`: иконка, счётчик (badge),
  порядок, описание, источник. Форматы: `markdown` (GFM: таблицы, чек-листы, `<details>`), `html` (санитизируется),
  `iframe` (любая страница со своим JS, например дашборд).
- **Добавление вкладок после прогона** через CLI: `pw-extended-report add-tab`. Это сценарий для Jenkins:
  тесты прошли, скилл подготовил MD, вы прицепили его к отчёту. Повторный вызов с тем же `--id` заменяет вкладку.
- **Ссылки из Markdown в отчёт**:
  - `[тест](#?test=Название теста)` открывает тест по названию (скилл знает названия из логов, а `testId` не знает);
  - `[упавшие](#?q=s:failed)` ведёт на любой фильтр штатного поиска;
  - `[вкладка](#?tab=failures)` открывает другую вкладку, `[раздел](#заголовок)` скроллит к заголовку.
- **Встроенная вкладка Insights** ([docs/INSIGHTS.md](docs/INSIGHTS.md)):
  1. классификация каждого падения: *Product bug / Test bug / Environment / UI change / Flaky*, с объяснением и доказательствами;
  2. история прогонов: новые и известные падения, нестабильные тесты, регрессии длительности, «починилось с прошлого прогона»;
  3. сравнение упавшей и успешной попытки бок о бок: где разошлись шаги, что стало медленнее, скриншоты;
  4. упавшие сетевые запросы (4xx/5xx) и ошибки браузера (`console.error`, необработанные исключения) прямо из `trace.zip`;
  5. кнопки **Ask AI** и **Fix ▾** — в карточках и на странице каждого упавшего теста рядом с «Copy prompt».
- **AI-агент** ([docs/AGENT.md](docs/AGENT.md)): читает трейс (действия, лог ожидания, DOM на момент падения,
  сеть, консоль, исходники), находит на странице элементы, похожие на упавший локатор, умеет перезапустить тест
  локально и сравнить, предлагает правку с диффом, применяет её по кнопке с проверочным прогоном и откатом.
  Поле «подсказка агенту» уводит его с ложного пути. Модели: Proxy LLM / OpenAI-compatible, GigaChat,
  GigaCode IFT SSL, GigaCode CLI. Native tool calling не нужен.
- **Вкладка Failure analysis**: вводное описание, **анализ вашего скилла** (`pw-extended-report add-analysis`)
  и под ним **встроенная группировка** упавших тестов по нормализованной ошибке (категория, процент падений,
  место в коде).
- **`report-summary.json`** — машиночитаемая сводка (статистика, упавшие тесты с ошибками и путями к вложениям,
  кластеры). Это готовый вход для LLM или вашего скилла, без парсинга HTML и логов Jenkins.
- **Совместимость**: использует только публичный Reporter API, проверено на Playwright **1.45, 1.52, 1.63**.
  Trace viewer берётся из `playwright-core` вашего проекта, поэтому версия всегда совпадает с трейсами.
- Работает с шардингом: `merge-reports` подходит и для нашего репортёра.

## Быстрый старт

### 1. Сборка и упаковка пакета

```bash
git clone <this-repo> && cd playwright-extended-report
npm ci
npm run build          # web UI (vite) -> dist/web, репортёр и CLI (tsc) -> dist/
npm test               # e2e: прогон example/, генерация отчёта, проверки в браузере
npm pack               # -> playwright-extended-report-<version>.tgz
```

Публикация во внутренний Nexus описана в [docs/PUBLISHING.md](docs/PUBLISHING.md). Перед публикацией
стоит дать пакету свой scope, например `@qa/playwright-extended-report`.

### 2. Подключение в проект с автотестами

```bash
npm i -D playwright-extended-report      # или @your-scope/playwright-extended-report из Nexus
```

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [
    ['html'],                                   // штатный отчёт без изменений
    ['playwright-extended-report', {
      outputFolder: 'extended-report',          // своя папка
      title: 'Regression',
      // необязательно: вкладки, которые уже есть на момент генерации
      tabs: [{ id: 'notes', title: 'Notes', file: './run-notes.md', optional: true }],
    }],
  ],
});
```

### 3. После прогона: добавить анализ скилла

```bash
npx playwright test || true

# ваш скилл анализа логов Jenkins пишет analysis.md, затем — во вкладку Failure analysis:
npx pw-extended-report add-analysis extended-report --file analysis.md --source "jenkins-log-skill #123"

npx pw-extended-report show extended-report      # просто посмотреть
```

### 4. Разобрать падения с AI-агентом

```bash
cd my-autotests                                   # клон репозитория тестов
export EXTENDED_REPORT_AI_PROVIDER=gigachat GIGACHAT_AUTHORIZATION_KEY=... EXTENDED_REPORT_AI_LANGUAGE=Russian
npx pw-extended-report agent ./extended-report    # Ask AI, Run & debug, Propose fix, Apply & verify
```

Настройка всех провайдеров (Proxy LLM, GigaChat, GigaCode IFT SSL, GigaCode CLI) и режим для отчётов в Jenkins —
в [docs/AGENT.md](docs/AGENT.md).

Пример `Jenkinsfile` и настройка CSP для HTML Publisher: [docs/JENKINS.md](docs/JENKINS.md).

## CLI

```
pw-extended-report add-analysis   [report-dir] --file <path> [--title] [--source] [--optional]
pw-extended-report add-section    [report-dir] --tab <tab-id> --id <id> (--file|--content) [--title]
pw-extended-report remove-section [report-dir] --tab <tab-id> --id <id>
pw-extended-report add-tab        [report-dir] --id <id> (--file <path>|--content <text>) [options]
pw-extended-report remove-tab     [report-dir] --id <id>
pw-extended-report list-tabs      [report-dir]
pw-extended-report show           [report-dir] [--host] [--port] [--no-open] [--ai | --ai-mock] [--repo <dir>] [--config <file>]
pw-extended-report agent          [report-dir] [--repo <dir>] [--config <file>] [--ai-mock]
pw-extended-report ai-gateway     [--host] [--port] [--ai-mock]
```

| Опция `add-tab` | Описание |
|---|---|
| `--id` | id вкладки, попадает в URL: `#?tab=<id>`. Буквы, цифры, `-`, `_`. |
| `--title` | Подпись в панели. |
| `--file` | `.md`, `.html` или папка с `index.html` (iframe). `-` означает stdin. |
| `--content` | Содержимое строкой вместо файла. |
| `--format` | `markdown` \| `html` \| `iframe`. По умолчанию определяется по расширению. |
| `--icon` | `sparkle` \| `bug` \| `graph` \| `note` \| `list` \| `none`. |
| `--badge`, `--badge-kind` | Счётчик и его цвет: `default` \| `danger` \| `attention` \| `success`. |
| `--order` | Сортировка: меньше значит левее. Встроенная Failure analysis имеет `100`. |
| `--description`, `--source` | Подзаголовок и источник, показываются над содержимым. |
| `--optional` | Если файла нет, тихо пропустить (exit 0). Удобно в пайплайне. |

`report-dir` по умолчанию `./extended-report`. Та же функциональность доступна программно:

```ts
import { upsertTab, readTabs, removeTab } from 'playwright-extended-report';
await upsertTab('extended-report', { id: 'ai', title: 'AI', file: 'analysis.md', icon: 'sparkle' });
```

## Опции репортёра

| Опция | По умолчанию | Env | |
|---|---|---|---|
| `outputFolder` | `extended-report` | `EXTENDED_REPORT_OUTPUT_DIR` | Папка отчёта, очищается перед генерацией. |
| `title` | — | `EXTENDED_REPORT_TITLE` | Заголовок отчёта. |
| `open` | `never` | `EXTENDED_REPORT_OPEN` | `always` \| `never` \| `on-failure`. |
| `host`, `port` | — | `EXTENDED_REPORT_HOST/PORT` | Для `open`. |
| `tabs` | `[]` | — | Вкладки на момент генерации: `{ id, title, file \| content, format?, icon?, badge?, order?, optional? }`. |
| `failureClusters` | `true` | — | `false` или `{ title?, order? }`. |
| `summaryJson` | `true` | — | Писать `report-summary.json`. |
| `insights` | `true` | `EXTENDED_REPORT_HISTORY_FILE`, `EXTENDED_REPORT_RUN_ID`, `EXTENDED_REPORT_AI_ENDPOINT`, `EXTENDED_REPORT_FIX_URL` | `false` или `{ title?, order?, history?: false \| { file?, maxRuns? }, traces?, aiEndpoint?, fixUrlTemplate? }`, см. INSIGHTS.md. |
| `noSnippets`, `noCopyPrompt`, `doNotInlineAssets`, `mergeFiles`, `attachmentsBaseURL` | как у `html` | `EXTENDED_REPORT_*` | Те же опции, что у штатного репортёра. |

Переменные окружения намеренно не `PLAYWRIGHT_HTML_*`: иначе оба отчёта писали бы в одну папку.

## Что учесть

- **Jenkins и CSP.** HTML Publisher по умолчанию блокирует скрипты отчёта. Если штатный отчёт Playwright у вас
  уже открывается в Jenkins, CSP уже ослаблен и этот отчёт тоже заработает. Иначе см. [docs/JENKINS.md](docs/JENKINS.md).
- **`file://`.** При открытии `index.html` как локального файла не работают trace viewer, «Copy prompt» и снапшот
  страницы в «Ask AI»: браузер запрещает `fetch` на `file://`. У штатного отчёта так же. Смотрите через HTTP:
  `pw-extended-report show` или публикация в Jenkins.
- **Шарды.** В объединённом (`merge-reports`) отчёте пустой таймлайн шардов в Speedboard: эти данные доступны
  только через внутренний API Playwright. Остальное работает.
- **История между прогонами выключена по умолчанию** (`insights: { history: {} }` — включить; файл нужно
  сохранять между билдами, см. [docs/INSIGHTS.md](docs/INSIGHTS.md)). Сравнение попыток (ретраев) работает
  внутри текущего прогона и без неё.
- **AI-агент** запускает тесты и меняет файлы только в режиме `pw-extended-report agent` (локально, в репозитории
  тестов) и только по кнопке Apply, с бэкапом и Revert. Добавьте `.pw-extended-report/` в `.gitignore`.
- **Nexus.** `package-lock.json` в репозитории указывает на registry.npmjs.org. Во внутреннем контуре выполните
  `npm install` через ваш registry, чтобы lockfile пересоздался, и задайте пакету свой scope, например `@qa/…`
  ([docs/PUBLISHING.md](docs/PUBLISHING.md)).
- **Классификация эвристическая**: правила объясняют решение через «evidence», а уточнять его должен AI-агент (Ask AI).
- **AI-ответы в демо** (`--ai-mock`) — шаблоны: доказательства (DOM, лог, сеть, код) реальные, рассуждение — нет.
  Качество настоящего анализа зависит от вашей модели и `EXTENDED_REPORT_AI_MAX_CHARS`.

## Документация

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — как устроен штатный отчёт Playwright и что изменено здесь.
- [docs/AGENT.md](docs/AGENT.md) — AI-агент: подключение GigaChat / GigaCode / Proxy LLM, анализ, отладка, починка.
- [docs/INSIGHTS.md](docs/INSIGHTS.md) — вкладка Insights: классификация, история, сеть и консоль, сравнение попыток, Ask AI, Fix.
- [docs/CUSTOM_TABS.md](docs/CUSTOM_TABS.md) — формат вкладок, ссылки, как добавить свой тип вкладки в UI.
- [docs/JENKINS.md](docs/JENKINS.md) — пайплайн, публикация отчёта, CSP.
- [docs/LLM_INTEGRATION.md](docs/LLM_INTEGRATION.md) — как подключить LLM / скилл: входные данные, промпт, вывод во вкладку.
- [docs/UPSTREAM_SYNC.md](docs/UPSTREAM_SYNC.md) — как подтягивать новые версии UI из Playwright.
- [docs/PUBLISHING.md](docs/PUBLISHING.md) — сборка, версионирование, публикация в Nexus.
- [docs/IDEAS.md](docs/IDEAS.md) — исследование существующих решений и идеи развития отчёта.

## Структура репозитория

```
web/                 UI отчёта (React + Vite)
  src/               копия packages/html-reporter/src из Playwright + патчи с маркером [extended-report]
  src/extended/      наш код: вкладки, Markdown, иконки, стили
  vendor/            нужные файлы из packages/web и packages/isomorphic (без изменений)
src/
  reporter/html.ts   порт packages/playwright/src/reporters/html.ts на публичный API
  reporter/compat.ts замены внутренних утилит Playwright
  reporter/failureClusters.ts  группировка падений
  tabs.ts            чтение и запись вкладок в index.html
  cli/index.ts       CLI pw-extended-report
  server.ts          локальный просмотр
  shared/tabsFormat.ts  формат вкладок (общий для Node и UI)
upstream/            эталонная копия html.ts и версия Playwright, с которой синхронизировано
example/             демо-проект с намеренно падающими тестами
tests/               e2e-проверки пакета
scripts/sync-upstream.mjs    синхронизация с исходниками Playwright
```

## Лицензия

Apache-2.0. Код UI и репортёра основан на [Playwright](https://github.com/microsoft/playwright)
(© Microsoft Corporation), подробности в [NOTICE](NOTICE).
