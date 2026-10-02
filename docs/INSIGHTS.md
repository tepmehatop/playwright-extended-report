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
| Элемент не найден, а **страница на момент падения пустая** | Unclassified: «смотрите, что случилось до — навигация, редирект, submit, страница не отрисовалась», а не локатор | medium |
| Элемент не найден, strict mode violation | Test bug (+ пометка, если падение новое) | medium |
| Элемент найден, но значение другое (`Expected` / `Received`) | Product bug | medium / low |
| Таймаут теста | Environment | low |
| Иначе | Unclassified | low |

Каждое решение сопровождается **reason** (одно предложение) и **evidence** (на чём основано),
чтобы человек мог быстро проверить вывод. Уточнять классификацию должен AI-агент (Ask AI).
Правила легко дополнять своими: например, «URL содержит `/auth` и статус 401 — Environment: истёк тестовый пользователь».

## 2. История прогонов (по умолчанию выключена)

Без истории всё остальное работает: классификация, сеть и консоль, **сравнение попыток (ретраев) внутри
текущего прогона**, агент. История нужна только для сигналов «между прогонами» — новые и известные падения,
нестабильные тесты, регрессии длительности. Если у вас прошлые прогоны хранятся в TestOps, историю здесь
можно не включать. Чтобы включить:

После каждого прогона в `extended-report-history.json` (рядом с папкой отчёта) дописывается строка
с исходом и длительностью каждого теста. Хранятся последние 30 прогонов. Копия кладётся в отчёт как `history.json`.

```ts
['playwright-extended-report', {
  insights: { history: {} },                                              // файл по умолчанию
  // insights: { history: { file: 'reports/history.json', maxRuns: 50 } },
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

Сравниваются **попытки одного теста внутри текущего прогона** (первый запуск и ретраи, `retries` в конфиге),
история не нужна. Кнопка **Compare attempts** появляется, если было больше одной попытки. Слева упавшая попытка, справа успешная
(для flaky) или предыдущая. Подсвечиваются: шаг, где попытки разошлись; шаг с ошибкой; шаги, ставшие
в 2+ раза медленнее. Ниже — скриншоты обеих попыток. Если все попытки упали с одной ошибкой, это сказано
явно: стабильное падение, а не flaky.

## 4. Сеть и консоль из трейса

Для упавшей попытки читается её `trace.zip`: запросы со статусом ≥ 400 или сетевым сбоем, `console.error`
и `console.warning`, необработанные исключения страницы. Нужен `trace: 'on'` или `'retain-on-failure'` /
`'on-first-retry'` в конфиге. Отключить: `insights: { traces: false }`.

## 6. Ask AI и Fix

Это AI-агент: глубокий анализ по трейсу, локальный перезапуск, предложение правки с диффом, применение
с проверкой и откат, а также поле «подсказка агенту». Кнопки есть в карточках Insights и на странице
каждого упавшего теста. Подробности и подключение внутренних моделей (Proxy LLM, GigaChat, GigaCode IFT SSL,
GigaCode CLI) описаны в **[AGENT.md](AGENT.md)**.

Коротко:

```bash
cd my-autotests
export EXTENDED_REPORT_AI_PROVIDER=gigachat GIGACHAT_AUTHORIZATION_KEY=... EXTENDED_REPORT_AI_LANGUAGE=Russian
npx pw-extended-report agent ./extended-report
```

Без агента кнопка Ask AI показывает готовый промпт с кнопкой **Copy prompt**.

**Fix ▾**:
- **Propose fix with AI agent** — правка с диффом, затем Apply & verify и Revert (см. AGENT.md).
- **Copy fix prompt** — готовый промпт для любого LLM-чата или IDE-агента. Запрещает ослаблять проверки,
  если это баг продукта или окружения.
- **Copy rerun command** — `npx playwright test "file:line" --project=… --retries=0 --trace=on`.
- **Run fix job ↗** — если задан `insights.fixUrlTemplate` / `EXTENDED_REPORT_FIX_URL`, например
  `https://jenkins/job/heal-test/buildWithParameters?TEST={file}:{line}&PROJECT={project}`.
  Подстановки: `{file} {line} {title} {project} {testId}`.

## Данные

Всё, что видно во вкладке, также лежит в `report-summary.json` → `insights` (формат `InsightsData`).
Его можно отдать вашему скиллу или LLM вместо логов Jenkins.
