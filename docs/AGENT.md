# AI-агент для упавших тестов (закрытый контур)

Агент открывается кнопками **Ask AI** и **Fix ▾**. Они есть в каждой карточке вкладки Insights и на странице
любого упавшего теста, рядом со штатной «Copy prompt».

| Что умеет | Как |
|---|---|
| **Глубокий анализ** | Читает `trace.zip`: все действия с локаторами, лог ожидания упавшего действия, **DOM страницы на момент падения** (восстанавливается из снапшотов трейса), сетевые ошибки, `console.error`, необработанные исключения, исходники теста и page objects (лежат прямо в трейсе), шаги, попытки, историю. Ищет на странице элементы, похожие на упавший локатор. Всё это — «пакет доказательств» для модели. |
| **Run & debug** | Сам перезапускает тест локально (`--retries=0 --trace=on`), читает новый трейс и сравнивает с исходным падением: воспроизводится или нет, та же ошибка или другая. |
| **Propose fix** | Просит модель минимальную правку в формате SEARCH/REPLACE, проверяет, что она применима к файлу, и показывает **дифф**. |
| **Apply & verify** | По кнопке применяет правку (с бэкапом), перезапускает тест и показывает результат. **Revert** возвращает как было. |
| **Подсказка агенту** | Поле над кнопками. Если агент идёт по ложному пути («падает из-за авторизации»), напишите «авторизация в порядке, после редизайна поменялся локатор счётчика». Подсказка попадает в анализ, debug и fix как приоритетный контекст: модель обязана проверить её по доказательствам. |
| **Copy analysis / Copy prompt / Copy fix (diff)** | Всё можно скопировать и отдать в чат, Jira или любой IDE-агент. |
| **What the agent looked at** | Раскрывающийся блок с пакетом доказательств. Даже если модель ответила плохо, факты (DOM, лог, запросы) видны и проверяемы. |

## Почему агент устроен «наоборот»

Агенты Playwright (`init-agents`: planner, generator, healer) и большинство open-source агентов работают
через **native tool calling** (MCP-инструменты). С моделями внутреннего контура это ненадёжно. В истории
`shmoker-ai` это подтверждено: GigaChat игнорирует OpenAI-формат `tools`, а небольшие qwen делают 0 вызовов
инструментов.

Здесь всё делает **код**: читает трейс, восстанавливает DOM, ищет кандидатов-локаторы, запускает тест,
применяет и откатывает правку. **Модель только рассуждает** над собранными фактами и отвечает текстом в
заданной структуре. Это работает с любой моделью, которая умеет `chat/completions`.

## Режимы запуска

| Режим | Команда | Анализ | Run & debug | Apply fix |
|---|---|---|---|---|
| Локально, в репозитории тестов | `npx pw-extended-report agent <report-dir>` | ✓ | ✓ | ✓ |
| Локально, только отчёт | `npx pw-extended-report show <report-dir> --ai` | ✓ | — | — (дифф можно скопировать) |
| Отчёт в Jenkins + постоянный шлюз | `npx pw-extended-report ai-gateway --port 8787` на внутреннем хосте и `EXTENDED_REPORT_AI_ENDPOINT=http://<host>:8787/` при прогоне | ✓ | — | — |
| Демо без модели | любой из режимов с `--ai-mock` | шаблонные ответы, доказательства реальные | ✓ | ✓ |

Типичный сценарий: отчёт из Jenkins скачан (или прогон сделан локально), инженер открывает его в своём
клоне репозитория тестов:

```bash
cd my-autotests
npx pw-extended-report agent ./extended-report            # откроется http://localhost:9324
npx pw-extended-report agent ./extended-report --config playwright.config.ts   # если конфиг не по умолчанию
```

Сопоставление путей автоматическое: в трейсе пути с CI-агента (`/var/jenkins/workspace/.../tests/a.spec.ts`),
агент находит файл в локальном клоне по совпадению хвоста пути.

Для отчётов, опубликованных в Jenkins, браузер сам скачивает `trace.zip` из отчёта и отправляет его на
шлюз. Шлюзу не нужен доступ к Jenkins, но CSP Jenkins должен разрешать `connect-src` на хост шлюза.

## Подключение модели

Переменные окружения. Имена совпадают с `shmoker-ai`, поэтому можно переиспользовать тот же `.env`
(`set -a; source .env; set +a`). Переменные `EXTENDED_REPORT_AI_*` имеют приоритет.

### Proxy LLM / любой OpenAI-совместимый endpoint (vLLM, Ollama, LiteLLM, внутренний шлюз)

```bash
export EXTENDED_REPORT_AI_PROVIDER=openai          # или LLM_PROVIDER=proxy
export EXTENDED_REPORT_AI_BASE_URL=http://llm.internal:8080/v1     # или PROXY_BASE_URL
export EXTENDED_REPORT_AI_API_KEY=...              # или PROXY_API_KEY; "none" или пусто — без ключа
export EXTENDED_REPORT_AI_MODEL=qwen3-coder-30b    # или LLM_MODEL
```

### GigaChat

```bash
export EXTENDED_REPORT_AI_PROVIDER=gigachat
export GIGACHAT_AUTHORIZATION_KEY=<base64 client_id:secret>
export GIGACHAT_SCOPE=GIGACHAT_API_CORP             # по умолчанию GIGACHAT_API_PERS
export GIGACHAT_AUTH_URL=https://ngw.devices.sberbank.ru:9443/api/v2/oauth
export GIGACHAT_API_URL=https://gigachat.devices.sberbank.ru/api/v1
export GIGACHAT_VERIFY_SSL=false                    # если сертификат Минцифры не установлен в системе
export EXTENDED_REPORT_AI_MODEL=GigaChat-Pro       # при 404 (модель недоступна / токены кончились) — повтор на GigaChat
```

OAuth-токен получается и кешируется автоматически (Basic-ключ, `RqUID`, `scope`) — как в `gigachat_provider.py`.

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
export EXTENDED_REPORT_AI_MODEL=<model из списка CLI>   # по умолчанию первая модель
# токен и URL моделей берутся из ~/.gigacode/gigacode_token.json (config.chat.models[].url),
# другой путь: GIGACODE_TOKEN_FILE=/path/gigacode_token.json
```

### Общие настройки

| Переменная | По умолчанию | |
|---|---|---|
| `EXTENDED_REPORT_AI_LANGUAGE` | — | Язык ответов, например `Russian`. |
| `EXTENDED_REPORT_AI_MAX_CHARS` | `48000` | Бюджет пакета доказательств в символах. Для моделей с контекстом 8–16k ставьте 16000–24000: секции с низким приоритетом отбрасываются первыми. |
| `EXTENDED_REPORT_AI_MAX_TOKENS` | `2500` | `max_tokens` ответа. |
| `EXTENDED_REPORT_AI_TEMPERATURE` | `0.2` | |
| `EXTENDED_REPORT_AI_TIMEOUT_MS` | `180000` | Таймаут запроса к модели. |
| `EXTENDED_REPORT_AI_INSECURE` | — | `1` — не проверять TLS-сертификат (внутренние CA). |
| `EXTENDED_REPORT_AI_CORS_ORIGIN` | `*` | Для `ai-gateway`: с какого origin (Jenkins) разрешены запросы. |

Ответы вида `<think>…</think>` (qwen3, deepseek) вырезаются автоматически.

Проверить, что модель отвечает, можно без браузера:

```bash
node -e "require('playwright-extended-report').chat(require('playwright-extended-report').llmConfigFromEnv(), [{role:'user',content:'ping'}]).then(r => console.log(r.model, r.content))"
```

## Безопасность

- Агент меняет файлы **только** в указанном репозитории, **только** существующие файлы, никогда
  в `node_modules` и `.git`, и **только** по кнопке Apply. Перед записью проверяется, что файл не менялся с
  момента предложения правки. Бэкапы лежат в `.pw-extended-report/backups/` (добавьте в `.gitignore`).
- Промпт запрещает «чинить» баги продукта и окружения ослаблением проверок. Вместо этого предлагается `test.fixme()`
  с объяснением.
- `ai-gateway` (для Jenkins) только анализирует: запуск тестов и правка файлов доступны только локальному `agent`.
- В модель уходят ошибки, логи, DOM и исходники теста. Убедитесь, что это допустимо политикой контура
  (в планах — маскировка секретов, см. IDEAS.md).

## HTTP API (для своих интеграций)

```
GET  /api/agent/status               → { model, canRun, canApply, tracesFromDisk }
POST /api/agent/jobs                 { kind: 'analyze'|'debug'|'fix'|'apply'|'revert', test, attempt?, insight?,
                                       tracePath? | traceBase64?, errorContext?, comment?, analysis?, fixId? } → { id }
GET  /api/agent/jobs/<id>            → { status: running|done|error, log[], result: { markdown, evidence, prompt, fix? } }
POST /api/ai/ask                     { prompt } → { markdown }   (простой режим)
```

Программно: `import { AgentService, Repo, llmConfigFromEnv, readTrace } from 'playwright-extended-report'`.

## Альтернатива: агенты Playwright через OpenCode

Если во внутреннем контуре есть модель, **уверенно** работающая с tool calling, можно использовать штатного
healer-агента Playwright через OpenCode с собственным провайдером:

```bash
npx playwright init-agents --loop=opencode        # создаст opencode.json и агентов, MCP: npx playwright run-test-mcp-server
```

В `opencode.json` добавьте провайдер с `baseURL` вашей модели (OpenAI-compatible). Тот же MCP-сервер
`npx playwright run-test-mcp-server` можно подключить к любому MCP-клиенту, например к MCP-движку `shmoker-ai`.
Наш агент и healer не конфликтуют: «Copy fix prompt» в меню Fix даёт готовый промпт для любого из них.
