# AI-агент для упавших тестов

Кнопки **Ask AI**, **Fix ▾** и **Открыть в IDE** есть в каждой карточке вкладки Insights, в карточках групп
ошибок и на странице любого упавшего теста (рядом со штатной «Copy prompt»).
Всё, что генерирует агент — ответы, промпты, пакет доказательств, лог шагов, объяснения правок, — **на русском**
(английский: `EXTENDED_REPORT_AI_LANGUAGE=English` для агента и `language: 'en'` в репортёре).
Команды, код, локаторы и тексты ошибок не переводятся.

Как развернуть локально и на виртуалке Jenkins: **[DEPLOYMENT.md](DEPLOYMENT.md)**.

## Что умеет

| Действие | Как работает |
|---|---|
| **Ask AI** | Читает `trace.zip`: действия с локаторами, лог ожидания упавшего действия, **DOM страницы в момент падения**, сеть (с телами ответов), консоль, необработанные исключения, исходники теста и page objects (они лежат прямо в трейсе), шаги, попытки. Ищет на странице элементы, похожие на упавший локатор, и **проверяет их в Locator lab**. Всё это — пакет доказательств для модели. Сначала пробует **MCP-путь**, при неудаче — простой (см. ниже). |
| **Запустить и отладить** | Перезапускает тест локально (`--retries=0 --trace=on`), читает новый трейс, сравнивает с падением из CI: воспроизвелось ли, та же ли ошибка. |
| **Предложить фикс** | Минимальная правка в формате SEARCH/REPLACE → проверка, что она применима к файлу → **дифф**. Новые локаторы из правки сразу проверяются в Locator lab на DOM момента падения. |
| **Применить и проверить / Откатить** | Применяет правку (с бэкапом), прогоняет тест (для группы — все тесты группы) и показывает результат по каждому. Откат одной кнопкой. |
| **Подсказка агенту** | Поле над кнопками. Агент решил, что «падает из-за авторизации», а дело в локаторе? Напишите «авторизация в порядке, после редизайна поменялся локатор счётчика корзины» — подсказка идёт приоритетным контекстом в анализ, отладку и фикс; модель обязана проверить её по фактам. |
| **Разобрать группу / Исправить группу** | Вкладка Insights → «По группам ошибок» (или ссылка «Разобрать группу с AI-агентом →» в Failure analysis). Один запрос к модели на всю группу: подробные доказательства по одному тесту + краткие по остальным. Одна правка на все тесты, проверка прогоном всех. Поштучный разбор и фикс в карточке каждого теста остаются. |
| **Locator lab** | Раскрывающийся блок в панели агента: введите локаторы (по одному в строке) — агент проверит их на HTML страницы в момент падения в headless-браузере: сколько элементов, видим ли, текст. Принимаются только цепочки `page.getBy…/locator/filter/first/last/nth` с литералами — произвольный код не исполняется. JS страницы и внешний CSS не загружаются, поэтому «видимость» приблизительная. |
| **cURL / Баг-репорт** | У каждого упавшего запроса (4xx/5xx, сетевая ошибка): готовая команда cURL и Markdown баг-репорт для бэкенда (запрос, ответ, тело ответа, тест, время). Секреты (`Authorization`, `Cookie`, токены) маскируются (`EXTENDED_REPORT_UNMASK_SECRETS=1` при генерации отчёта — не маскировать). |
| **Разбор из CI** | Если в пайплайне выполнен `pw-extended-report analyze`, разбор групп уже лежит в отчёте: показывается сразу, без ожидания модели и даже без агента. «Анализ заново» запускает живой разбор. |
| **Копировать анализ / промпт / фикс** | Всё можно скопировать в чат, Jira, любой IDE-агент. |
| **Что изучил агент** | Раскрывающийся блок с пакетом доказательств — проверяемые факты, даже если модель ответила слабо. |

## MCP сначала, простой путь — запасной

1. **MCP-путь.** Если настроены MCP-серверы, модель получает пакет доказательств **и инструменты**:
   ваши MCP (serena, code-index, codebase-memory, context7, playwright…) и встроенные инструменты агента
   (`agent__locator_lab` — проверить локатор на DOM момента падения, `agent__read_source` — прочитать файл).
   Модель может сделать несколько вызовов (обычно 1–4, максимум 8), потом отвечает.
   Формат вызовов — OpenAI `tools` для Proxy LLM / GigaCode и **`functions` / `function_call` для GigaChat**
   (GigaChat игнорирует `tools`; формат как в MCP-движке shmoker-ai).
2. **Простой путь.** Если MCP не настроен, провайдер отклонил инструменты, модель зациклилась или не дала
   ответа — агент автоматически повторяет запрос **без инструментов** с теми же доказательствами.
   Это работает с любой моделью, умеющей `chat/completions`. Для фикса: если ответ с MCP не содержит
   применимой правки, запрос тоже повторяется простым путём.

В ответе видно, какой путь сработал: «Анализ · модель · через MCP, вызовов инструментов: 2». В логе шагов —
каждый вызов инструмента. Отключить MCP: `--no-mcp` или `EXTENDED_REPORT_AI_TOOLS=off`.

### Подключение MCP-серверов

Формат — обычный `mcpServers` (как у Claude Code, Cursor, GigaCode CLI), поэтому подойдёт ваш существующий
конфиг. Где ищется (первый найденный):

1. `--mcp-config <file>`
2. `EXTENDED_REPORT_MCP_CONFIG`
3. `<репозиторий автотестов>/.pw-extended-report/mcp.json`
4. `<репозиторий автотестов>/.mcp.json`
5. `~/.pw-extended-report/mcp.json`

Пример для локальной машины — [examples/mcp.local.json](examples/mcp.local.json), для Docker —
[`docker/mcp.json.example`](../docker/mcp.json.example).

```jsonc
{
  "mcpServers": {
    "serena": { "command": "uvx", "args": ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server",
                "--project", "${REPO}", "--context", "ide-assistant", "--enable-web-dashboard", "false"], "timeout": 240 },
    "code-index": { "command": "uvx", "args": ["code-index-mcp", "--project-path", "${REPO}"] },
    "context7": { "type": "http", "url": "http://context7.internal/mcp", "headers": { "Authorization": "Bearer ..." } },
    "codebase-memory": { "command": "codebase-memory-mcp" }
  }
}
```

- Транспорты: stdio (`command`/`args`/`env`), Streamable HTTP (`"type": "http"`, `url`, `headers`), SSE (`"type": "sse"`).
- `${REPO}` — путь к репозиторию автотестов, `${HOME}`, `${ЛЮБАЯ_ПЕРЕМЕННАЯ}`.
- `"tools": [...]` — какие инструменты сервера показывать модели. Для известных серверов уже выбраны
  read-only инструменты, полезные для отладки (serena: `find_symbol`, `find_referencing_symbols`, `get_symbols_overview`,
  `search_for_pattern`…; playwright: `browser_navigate`, `browser_snapshot`, `browser_console_messages`…;
  context7; code-index). Остальные серверы — до 20 инструментов. Это важно для локальных моделей:
  слишком много схем раздувает контекст (тот же инцидент, что был в shmoker-ai).
- `"disabled": true` — временно выключить сервер.
- Состояние подключения: в панели агента («MCP: serena, playwright», подсказка с деталями) и `GET /api/agent/status`.

**Можно ли не устанавливать MCP-серверы отдельно?** Наш MCP-клиент встроен в пакет (без зависимостей),
а сами серверы — внешние программы:
- в **Docker-образе** агента они ставятся при сборке (`WITH_PLAYWRIGHT_MCP`, `WITH_SERENA`, `WITH_CODE_INDEX`,
  `WITH_CONTEXT7`; codebase-memory — бинарник монтируется) — на виртуалке Jenkins ничего ставить не нужно;
- **локально** используются те, что у вас уже стоят (`uvx`, `npx`, бинарники), через ваш `mcp.json`.

Проверено с реальными `@playwright/mcp` (stdio) и Serena (`find_symbol` по TypeScript-тестам).

## Подключение модели

Имена переменных совпадают с shmoker-ai, поэтому подходит тот же `.env` (`set -a; source .env; set +a`).
`EXTENDED_REPORT_AI_*` имеют приоритет.

### Proxy LLM / любой OpenAI-совместимый endpoint (vLLM, Ollama, LiteLLM, внутренний шлюз)

```bash
export EXTENDED_REPORT_AI_PROVIDER=proxy           # или openai
export PROXY_BASE_URL=http://llm.internal:8080/v1  # или EXTENDED_REPORT_AI_BASE_URL
export PROXY_API_KEY=...                           # "none" или пусто — без ключа
export LLM_MODEL=qwen3-coder-30b                   # или EXTENDED_REPORT_AI_MODEL
```

### GigaChat

```bash
export EXTENDED_REPORT_AI_PROVIDER=gigachat
export GIGACHAT_AUTHORIZATION_KEY=<base64 client_id:secret>
export GIGACHAT_SCOPE=GIGACHAT_API_CORP             # по умолчанию GIGACHAT_API_PERS
export GIGACHAT_AUTH_URL=https://ngw.devices.sberbank.ru:9443/api/v2/oauth
export GIGACHAT_API_URL=https://gigachat.devices.sberbank.ru/api/v1
export GIGACHAT_VERIFY_SSL=false
export EXTENDED_REPORT_AI_MODEL=GigaChat-Pro       # при 404 — повтор на GigaChat
```

### GigaCode IFT SSL (mTLS)

```bash
export EXTENDED_REPORT_AI_PROVIDER=gigacode-ift-ssl
export EXTENDED_REPORT_AI_BASE_URL=https://<ift-gateway>/v1
export EXTENDED_REPORT_AI_CERT=/path/client-cert.pem
export EXTENDED_REPORT_AI_KEY=/path/client-key.pem
export EXTENDED_REPORT_AI_MODEL=<model>
```

### GigaCode CLI

```bash
export EXTENDED_REPORT_AI_PROVIDER=gigacode-cli
export EXTENDED_REPORT_AI_MODEL=<модель из списка CLI>   # по умолчанию первая
# токен и URL моделей — из ~/.gigacode/gigacode_token.json (config.chat.models[].url);
# другой путь: GIGACODE_TOKEN_FILE=/path/gigacode_token.json
```

### Общие настройки

| Переменная | По умолчанию | |
|---|---|---|
| `EXTENDED_REPORT_AI_LANGUAGE` | `Russian` | Язык всего, что генерирует агент. `English` — английский. |
| `EXTENDED_REPORT_AI_MAX_CHARS` | `48000` | Бюджет пакета доказательств. Для моделей с контекстом 8–16k — 16000–24000. |
| `EXTENDED_REPORT_AI_MAX_TOKENS` | `2500` | `max_tokens` ответа. |
| `EXTENDED_REPORT_AI_TEMPERATURE` | `0.2` | |
| `EXTENDED_REPORT_AI_TIMEOUT_MS` | `180000` | Таймаут запроса к модели. |
| `EXTENDED_REPORT_AI_INSECURE` | — | `1` — не проверять TLS (внутренние CA). |
| `EXTENDED_REPORT_AI_TOOLS` | — | `off` — не использовать MCP-путь. |
| `EXTENDED_REPORT_AI_CORS_ORIGIN` | `*` | Для `ai-gateway`: origin Jenkins. |
| `EXTENDED_REPORT_TESTID_ATTRIBUTE` | `data-testid` | Атрибут для `getByTestId` в Locator lab, если у вас другой. |
| `EXTENDED_REPORT_IDE_COMMAND` | — | Своя команда открытия файла, напр. `gigaide --line {line} {file}`. |

Ответы `<think>…</think>` (qwen3, deepseek) вырезаются автоматически.

## Команды

```bash
npx pw-extended-report agent ./extended-report                 # локально, в репозитории автотестов: всё
npx pw-extended-report show ./extended-report --ai             # только анализ (без перезапуска и правок)
npx pw-extended-report ai-gateway --port 8787 [--repo /ws]     # бэкенд для отчётов в Jenkins (обычно в Docker)
npx pw-extended-report analyze ./extended-report --max 10      # AI-разбор групп в CI (локально или --agent-url)
# общие флаги: --mcp-config <file>, --no-mcp, --ai-mock (шаблонные ответы без модели), --config <playwright.config>
```

## Открыть в IDE

⚙ справа вверху в отчёте → «Открывать файлы в»:
- **VS Code, Cursor, IntelliJ IDEA, WebStorm, PyCharm** по URL-схеме — укажите путь к локальному клону
  репозитория автотестов (один раз, хранится в браузере);
- **«через локального агента»** — любая IDE с консольным лаунчером: IntelliJ/WebStorm/PyCharm/GigaIDE
  (`idea`, `webstorm`, `gigaide` — в JetBrains-IDE: Tools → Create Command-line Launcher), VS Code (`code`), Cursor.
  Работает, когда отчёт открыт через `pw-extended-report agent`; агент сам находит файл в репозитории.
  На macOS без лаунчера JetBrains-IDE открываются через `open -na "<App>.app"`;
- **свой шаблон URL** — `{path}`, `{relative}`, `{line}`, `{column}`.

Своя команда для всех: `EXTENDED_REPORT_IDE_COMMAND="gigaide --line {line} {file}"` в окружении агента.

## Безопасность

- Файлы меняются **только** в указанном репозитории, **только** существующие, никогда в `node_modules`/`.git`,
  **только** по кнопке «Применить и проверить». Перед записью проверяется, что файл не менялся; бэкапы —
  `.pw-extended-report/backups/*.bak` (добавьте каталог в `.gitignore`).
- Docker-агент на общей виртуалке по умолчанию **только анализирует** (`AGENT_ALLOW_RUN=0`).
- Промпты запрещают «чинить» баги продукта и окружения ослаблением проверок (вместо этого — `test.fixme()` с объяснением).
- Locator lab не исполняет код: принимает только цепочки локаторов с литералами, страница открывается с выключенным JS.
- В модель уходят ошибки, логи, DOM, исходники теста и тела упавших ответов. Секретные заголовки в cURL
  маскируются; тела ответов — нет. Убедитесь, что это допустимо политикой контура.

## HTTP API (для своих интеграций)

```
GET  /api/agent/status          → { model, language, canRun, canApply, canOpenInIde, tracesFromDisk, mcp }
POST /api/agent/jobs            { kind: analyze|debug|fix|apply|revert|lab, test, attempt?, insight?,
                                  tracePath? | traceBase64?, errorContext?, comment?, analysis?, fixId?,
                                  group?: { tests, insights }, locators?, useTools? } → { id }
GET  /api/agent/jobs/<id>       → { status, log[], result: { markdown, evidence, prompt, model, path, toolCalls, fix?, lab? } }
POST /api/ide/open              { file, line, column?, ide }       (локальный агент)
POST /api/ai/ask                { prompt } → { markdown }
```

Программно: `import { AgentService, McpHub, loadMcpConfig, Repo, llmConfigFromEnv, analyzeReport, runLocatorLab } from 'playwright-extended-report'`.

## Альтернатива: агенты Playwright через OpenCode

Если в контуре есть модель, уверенно работающая с tool calling, можно использовать штатного healer-агента
Playwright: `npx playwright init-agents --loop=opencode` (OpenCode + свой OpenAI-совместимый провайдер), MCP-сервер
`npx playwright run-test-mcp-server`. Его же можно подключить к MCP-движку shmoker-ai. «Fix ▾ → Копировать промпт
для фикса» даёт готовый промпт для любого из них.
