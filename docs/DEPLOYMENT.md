# Как это работает и как развернуть

## Из чего состоит

| Часть | Что это | Где живёт |
|---|---|---|
| **Репортёр** | npm-пакет `playwright-extended-report`, подключается в `playwright.config.ts`. Генерирует отчёт (`extended-report/`) рядом со штатным. | В проекте автотестов (зависимость из Nexus). |
| **Отчёт** | Статическая папка `index.html` + `data/` + `trace/`. Вкладки Insights и Failure analysis, кнопки Ask AI / Fix / Open in IDE. | Артефакт Jenkins (HTML Publisher) или локальная папка. |
| **AI-агент (бэкенд)** | Процесс `pw-extended-report …` из того же пакета: разбирает трейсы, ходит в модель и MCP-серверы, запускает тесты, правит код. В отчёте ключей и логики нет — только кнопки. | Локально у инженера (`agent`) и/или на виртуалке Jenkins в Docker (`ai-gateway`). |
| **Модель** | Ваш провайдер: GigaChat, Proxy LLM (OpenAI-compatible), GigaCode IFT SSL, GigaCode CLI. | Внутренний контур. |
| **MCP-серверы** (необязательно) | serena, code-index, codebase-memory, context7, playwright — инструменты, которые агент даёт модели. | Там же, где агент (локально или в Docker-образе). |

Агент — это **не отдельный продукт**, а команды того же npm-пакета. Отдельно «живёт» только экземпляр
на виртуалке Jenkins (Docker-контейнер), чтобы кнопки работали в отчётах, открытых прямо из Jenkins.

```
                         ┌──────────────── Jenkins VM ─────────────────┐
  git push ──► Jenkins ──► 1. npx playwright test                       │
                         │ 2. pw-extended-report analyze ──────────┐   │
                         │    (AI-разбор групп заранее)            │   │
                         │ 3. publishHTML extended-report          ▼   │
                         │                     ┌──────────────────────┐│
                         │                     │ Docker: pw-agent     ││──► модель (GigaChat / Proxy LLM / GigaCode)
                         │                     │ ai-gateway :8787     ││──► MCP: playwright, serena, code-index, ...
                         │                     └──────────▲───────────┘│
                         └────────────────────────────────┼────────────┘
                                                          │ Ask AI / Fix (анализ)
  Инженер ── браузер ── отчёт в Jenkins ──────────────────┘

  Инженер локально:  cd autotests && npx pw-extended-report agent ./extended-report
                     └─ тот же агент + перезапуск тестов + Apply & verify + Open in IDE
```

## Что где доступно

| Возможность | Отчёт без агента (file://, Jenkins) | Отчёт в Jenkins + Docker-агент | Локально `pw-extended-report agent` |
|---|---|---|---|
| Insights, классификация, сеть/консоль, cURL, баг-репорт, сравнение попыток | ✓ | ✓ | ✓ |
| AI-разбор групп, подготовленный в CI (`analyze`) | ✓ | ✓ | ✓ |
| Ask AI (живой анализ теста / группы), MCP-путь | — (копировать промпт) | ✓ | ✓ |
| Locator lab | — | ✓ | ✓ |
| Propose fix (дифф, копировать) | — (копировать промпт) | ✓ | ✓ |
| Run & debug, Apply & verify, Revert | — | — (или `AGENT_ALLOW_RUN=1`, см. ниже) | ✓ |
| Open in IDE | URL-схема (VS Code, IDEA, WebStorm…) | URL-схема | URL-схема или любая IDE через агента (GigaIDE и т.п.) |

## 1. Локально: написание, отладка и починка тестов

1. Установить пакет в проект автотестов (из Nexus): `npm i -D @qa/playwright-extended-report`.
2. Подключить репортёр в `playwright.config.ts` (см. README).
3. Настроить модель — переменные окружения (можно взять `.env` из shmoker-ai, имена совпадают):
   ```bash
   export EXTENDED_REPORT_AI_PROVIDER=gigachat GIGACHAT_AUTHORIZATION_KEY=... GIGACHAT_SCOPE=GIGACHAT_API_CORP
   ```
4. (Необязательно) MCP: положить `.pw-extended-report/mcp.json` в репозиторий автотестов
   (пример — [examples/mcp.local.json](examples/mcp.local.json)) или переиспользовать ваш `.mcp.json`.
5. Прогнать тесты: `npx playwright test` — или скачать отчёт из Jenkins (архив `extended-report`).
6. Открыть отчёт с агентом:
   ```bash
   npx pw-extended-report agent ./extended-report
   ```
   Откроется `http://localhost:9324`. В отчёте:
   - **Ask AI** — анализ (сначала с MCP-инструментами, при сбое — простой путь); поле «Подсказка агенту»;
   - **Запустить и отладить** — агент перезапускает тест у вас и сравнивает с падением из CI;
   - **Fix ▾ → Предложить фикс** — дифф + проверка новых локаторов в Locator lab → **Применить и проверить** → **Откатить**;
   - **По группам ошибок → Разобрать группу / Исправить группу** — один запрос и одна правка на всю группу;
   - **Открыть в IDE** — выберите IDE в ⚙ (для GigaIDE и других — «через локального агента»).

Пути из CI (`/var/jenkins/workspace/...`) сопоставляются с вашим клоном автоматически.

## 2. Jenkins: отчёт с готовым AI-разбором и кнопками

### 2.1. Бэкенд агента на виртуалке Jenkins (Docker)

```bash
git clone <этот репозиторий> pw-agent && cd pw-agent
cp docker/.env.example docker/.env               # модель: GigaChat / Proxy LLM / GigaCode
cp docker/mcp.json.example docker/mcp.json       # MCP-серверы (необязательно)
docker compose -f docker/docker-compose.yml up -d --build
curl http://localhost:8787/api/agent/status       # {"enabled":true,"model":"gigachat · GigaChat-Pro", ...}
```

Образ (`docker/Dockerfile`):
- основан на `mcr.microsoft.com/playwright:v<версия>-noble` (браузеры для Locator lab и Playwright MCP);
  версию берите как у ваших тестов: `--build-arg PLAYWRIGHT_VERSION=1.5x.0`;
- в закрытом контуре: `BASE_IMAGE` → зеркало реестра, `NPM_REGISTRY` / `PIP_INDEX_URL` → Nexus;
- MCP в образе: `WITH_PLAYWRIGHT_MCP=1` (по умолчанию), `WITH_SERENA`, `WITH_CODE_INDEX`, `WITH_CONTEXT7` = 1 по желанию;
  codebase-memory-mcp — готовый бинарник монтируется в `/opt/mcp/codebase-memory-mcp`;
- serena / code-index работают с кодом: смонтируйте клон автотестов в `/workspace` (read-only),
  например каталог, который пайплайн обновляет `git pull`. Без него агент берёт исходники из трейсов.

`AGENT_ALLOW_RUN=1` разрешает контейнеру перезапускать тесты и применять правки в `/workspace` —
обычно **не нужно** для общего сервера: правки в общий workspace никому не помогут. Запуск и починка — локально.

### 2.2. Пайплайн

```groovy
environment {
  // Отчёт будет обращаться к агенту по этому адресу (из браузера инженера!)
  EXTENDED_REPORT_AI_ENDPOINT = 'http://jenkins-vm.internal:8787/'
}
stages {
  stage('Test')    { steps { sh 'npx playwright test || touch .tests-failed' } }
  stage('Analyze') { steps {
    // 1. Ваш скилл анализа логов -> analysis.md -> секция во вкладке Failure analysis
    sh 'node tools/jenkins-log-skill.js --out analysis.md || true'
    sh 'npx pw-extended-report add-analysis extended-report --file analysis.md --optional'
    // 2. AI-разбор групп ошибок заранее, через Docker-агента (одна модель и MCP для всех)
    sh 'npx pw-extended-report analyze extended-report --agent-url http://localhost:8787/ --max 10 || true'
  } }
}
post { always { publishHTML(target: [reportName: 'Extended Report', reportDir: 'extended-report', reportFiles: 'index.html', keepAll: true]) } }
```

Что происходит:
1. Тесты прогоняются, репортёр пишет `extended-report/` (и штатный `playwright-report/`).
2. `add-analysis` кладёт вывод вашего скилла во вкладку **Failure analysis**.
3. `analyze` для каждой группы ошибок (крупные первыми, до `--max`) отправляет агенту трейс
   представителя группы + краткие данные остальных; ответ сохраняется **в сам отчёт**: в карточку группы
   во вкладке Insights, в «Ask AI» каждого теста группы и секцией «AI-разбор групп ошибок» в Failure analysis.
   Поэтому отчёт открывается **с готовым разбором**, даже если агент потом недоступен.
4. Инженер открывает отчёт в Jenkins. «Ask AI» / «Предложить фикс» / Locator lab — живые запросы
   в Docker-агента (`EXTENDED_REPORT_AI_ENDPOINT`): браузер сам скачивает трейс из отчёта и отправляет агенту.
5. Чтобы применить правку и прогнать тест — инженер открывает тот же отчёт локально через `pw-extended-report agent`
   (или копирует дифф из отчёта).

Без Docker-агента `analyze` можно запускать прямо в джобе (модель вызывается из процесса Jenkins):
`npx pw-extended-report analyze extended-report --max 10` с переменными модели в окружении джобы.

### 2.3. Сеть и CSP

- Браузер инженера должен видеть `http://jenkins-vm:8787` (агент слушает `0.0.0.0:8787`).
- CSP Jenkins: кроме того, что нужно штатному отчёту (см. [JENKINS.md](JENKINS.md)), добавьте
  `connect-src 'self' http://jenkins-vm.internal:8787`.
- `EXTENDED_REPORT_AI_CORS_ORIGIN` в `docker/.env` — адрес Jenkins (например `https://jenkins.internal`), чтобы
  к агенту могли обращаться только отчёты из Jenkins.
- Агент не хранит отчёты и трейсы: всё приходит в запросе и живёт в памяти, пока идёт задача.

## 3. Обновление

- Пакет: новая версия в Nexus → `npm i -D @qa/playwright-extended-report@latest` в автотестах.
- Docker-агент: `git pull && docker compose -f docker/docker-compose.yml up -d --build`.
- Версия Playwright в образе — та же, что у тестов (build-arg `PLAYWRIGHT_VERSION`).

## 4. Диагностика

| Симптом | Что проверить |
|---|---|
| «AI-агент недоступен» в отчёте из Jenkins | Отчёт сгенерирован с `EXTENDED_REPORT_AI_ENDPOINT`? `curl <endpoint>api/agent/status` с машины инженера; CSP `connect-src`; CORS. |
| Ответ модели пустой / ошибка 401/404 | `curl …/api/agent/status` показывает провайдера и модель; лог шагов в панели агента («Ошибка: LLM gigachat HTTP 401 …»). |
| MCP не используется | В панели агента строка «MCP: …»; в логе «MCP serena: connected, N tool(s)» или текст ошибки подключения. `GET /api/agent/status` → `mcp.servers[].status/error`. |
| Модель «не вызывает инструменты» | Нормально для части моделей: агент автоматически переходит на простой путь («MCP-путь не сработал… Перехожу на простой путь»). Отключить MCP: `--no-mcp` или `EXTENDED_REPORT_AI_TOOLS=off`. |
| Locator lab «недоступен» | В окружении агента нет `@playwright/test`/браузера: локально — `npx playwright install chromium`; в Docker — уже есть. |
| Open in IDE не открывает | URL-схемы требуют пути к клону в ⚙. «Через агента» — нужен консольный лаунчер IDE в PATH (`idea`, `webstorm`, `gigaide`, `code`), либо `EXTENDED_REPORT_IDE_COMMAND`. |
