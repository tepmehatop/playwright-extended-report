# Вкладка Insights

Создаётся автоматически при каждом прогоне (`insights: true` по умолчанию). Для каждого упавшего
или flaky теста показывает карточку:

```
✕ app › cart items are loaded from api  [chromium]                      [Environment]
  app.spec.ts:36 · 2 attempts · ■■■■■ failing 5 runs in a row
  Backend returned 500 for GET /api/cart; the UI could not get its data.
   • GET /api/cart → 500
  FAILED NETWORK REQUESTS   500 GET http://demo.local/api/cart  Internal Server Error  9ms
  BROWSER ERRORS            error Failed to load cart: HTTP 500
  ▸ Error
  [Compare attempts] [Ask AI] [Fix ▾] [Open test]
```

Сверху — фильтры по типу падения и «New in this run». Ниже — история прогонов: столбики по билдам,
нестабильные тесты, регрессии длительности, «починилось с прошлого прогона».

## 1. Классификация

Правила (порядок важен, первое совпадение побеждает), реализация в [`src/reporter/insights.ts`](../src/reporter/insights.ts):

| Сигнал | Тип | Уверенность |
|---|---|---|
| Тест flaky внутри прогона (упал, потом прошёл на ретрае) | Flaky | high |
| В истории ≥ 2 переключений pass ↔ fail | Flaky | medium |
| В трейсе есть ответ 5xx | Environment | high |
| Сетевой сбой (`net::ERR_*`, `ECONNREFUSED`…) в трейсе или ошибке | Environment | high |
| Браузер или страница упали / закрылись | Environment | medium |
| Необработанное исключение в приложении (`pageerror`) | Product bug | high |
| Расхождение скриншота или ARIA-снапшота | UI change | high |
| Элемент не найден, strict mode violation | Test bug (+ пометка, если падение новое) | medium |
| Элемент найден, но значение другое (`Expected` / `Received`) | Product bug | medium / low |
| Таймаут теста | Environment | low |
| Иначе | Unclassified | low |

Каждое решение сопровождается **reason** (одно предложение) и **evidence** (на чём основано),
чтобы человек мог быстро проверить вывод. Уточнять классификацию должна LLM через Ask AI.
Правила легко дополнять своими: например, «URL содержит `/auth` и статус 401 — Environment: истёк тестовый пользователь».

## 2. История прогонов

После каждого прогона в `extended-report-history.json` (рядом с папкой отчёта) дописывается строка
с исходом и длительностью каждого теста. Хранятся последние 30 прогонов. Копия кладётся в отчёт как `history.json`.

```ts
['playwright-extended-report', {
  insights: { history: { file: 'reports/history.json', maxRuns: 50 } },   // или history: false
}]
```

Идентификатор прогона: `EXTENDED_REPORT_RUN_ID`, иначе `BUILD_NUMBER` (Jenkins), иначе время старта.
`BUILD_URL` становится ссылкой у столбика прогона.

**В Jenkins файл нужно сохранять между билдами.** Варианты:

```groovy
// 1) Через артефакты предыдущего билда (плагин Copy Artifact)
copyArtifacts(projectName: env.JOB_NAME, selector: lastCompleted(), filter: 'extended-report/history.json',
              target: 'prev', optional: true)
sh 'cp prev/extended-report/history.json extended-report-history.json || true'
sh 'npx playwright test || true'
archiveArtifacts 'extended-report/**'

// 2) Общая папка на агенте или в сетевом хранилище
withEnv(['EXTENDED_REPORT_HISTORY_FILE=/var/lib/qa-history/regression.json']) { sh 'npx playwright test || true' }
```

Что вычисляется:
- **NEW failure** — упал сейчас, а во всех предыдущих прогонах с данными проходил;
- **failing N runs in a row** — известное падение;
- **Unstable tests** — тесты, которые то проходят, то падают, или были flaky (от 3 прогонов). Тесты, падающие стабильно, сюда не попадают: это «known failure»;
- **Duration regressions** — тест прошёл, но идёт > 2× медианы прошлых успешных прогонов и медленнее минимум на 500 мс;
- **Fixed since previous run** — в прошлом прогоне упал, сейчас прошёл.

## 3. Сравнение попыток

Кнопка **Compare attempts** (если было больше одной попытки). Слева упавшая попытка, справа успешная
(для flaky) или предыдущая. Подсвечиваются: шаг, где попытки разошлись; шаг с ошибкой; шаги, ставшие
в 2+ раза медленнее. Ниже — скриншоты обеих попыток. Если все попытки упали с одной ошибкой, это сказано
явно: стабильное падение, а не flaky.

## 4. Сеть и консоль из трейса

Для упавшей попытки читается её `trace.zip`: запросы со статусом ≥ 400 или сетевым сбоем, `console.error`
и `console.warning`, необработанные исключения страницы. Нужен `trace: 'on'` или `'retain-on-failure'` /
`'on-first-retry'` в конфиге. Отключить: `insights: { traces: false }`.

## 6. Ask AI и Fix

**Ask AI** собирает промпт: тест, классификация, ошибка, сеть, консоль, история и `error-context`
(снапшот страницы и код теста), затем:

- если задан `insights.aiEndpoint` / `EXTENDED_REPORT_AI_ENDPOINT`, отправляет `POST {prompt, test}` туда
  и показывает Markdown-ответ прямо в карточке;
- если отчёт открыт через `pw-extended-report show --ai`, использует встроенный шлюз;
- иначе показывает промпт и кнопку **Copy prompt** — для чата или IDE-агента.

Шлюз (`src/aiGateway.ts`) умеет говорить с любым **OpenAI-совместимым** API: OpenAI, vLLM, Ollama, LiteLLM,
внутренний gateway.

```bash
export EXTENDED_REPORT_AI_BASE_URL=http://llm.internal/v1     # по умолчанию https://api.openai.com/v1
export EXTENDED_REPORT_AI_API_KEY=...                         # не нужен для внутренней модели без ключа
export EXTENDED_REPORT_AI_MODEL=qwen2.5-coder-32b
export EXTENDED_REPORT_AI_LANGUAGE=Russian
npx pw-extended-report show extended-report --ai               # локально
npx pw-extended-report ai-gateway --port 8787                  # постоянный шлюз с CORS для отчётов в Jenkins
```

Для отчётов, опубликованных в Jenkins: поднимите `ai-gateway` на внутреннем хосте и задайте при прогоне
`EXTENDED_REPORT_AI_ENDPOINT=http://ai-gw.internal:8787/api/ai/ask`. В CSP Jenkins должен быть разрешён
`connect-src` на этот хост. Свой шлюз должен принимать `POST {prompt, test}` и отвечать `{markdown, model?}`
(типы `AskAiRequest` и `AskAiResponse` в [`src/shared/insightsFormat.ts`](../src/shared/insightsFormat.ts)).

Для демо без модели: `pw-extended-report show --ai-mock` (ответы явно помечены как mock).

**Fix ▾**:
- **Copy prompt for healer agent** — промпт для `playwright-test-healer` (Claude Code / VS Code / OpenCode;
  один раз выполнить `npx playwright init-agents --loop=claude` в репозитории тестов). Промпт запрещает
  ослаблять проверки, если это баг продукта или окружения.
- **Copy rerun command** — `npx playwright test "file:line" --project=… --retries=0 --trace=on`.
- **Run fix job ↗** — если задан `insights.fixUrlTemplate` / `EXTENDED_REPORT_FIX_URL`, например
  `https://jenkins/job/heal-test/buildWithParameters?TEST={file}:{line}&PROJECT={project}`.
  Подстановки: `{file} {line} {title} {project} {testId}`.

## Данные

Всё, что видно во вкладке, также лежит в `report-summary.json` → `insights` (формат `InsightsData`).
Его можно отдать вашему скиллу или LLM вместо логов Jenkins.
