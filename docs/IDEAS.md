# Идеи развития отчёта: обзор рынка

Фокус: что сделать **в самом отчёте**, чтобы быстрее разбирать падения и отлаживать тесты.
Генерация тестов через AI за рамками.

## Что изучено

| Источник | Главное для нас |
|---|---|
| [TestDino docs](https://docs.testdino.com/), [AI-native test intelligence](https://testdino.com/blog/ai-native-test-intelligence), [обзор инструментов](https://testdino.com/blog/playwright-reporting-tools) | Группировка ошибок по сообщению и причине; AI-классификация **Actual Bug / UI Change / Unstable Test / Misc**; flaky по истории; тренды по веткам и PR; MCP-сервер для запросов к результатам; перезапуск только упавших. |
| [playwright-smart-reporter](https://github.com/qa-gary-parker/playwright-smart-reporter) ([статья](https://medium.com/@qa.gary.parker/playwright-smart-reporter-building-an-intelligent-test-reporter-with-ai-df559d8b94d7)) | История в JSON рядом с репо; **stability grade A–F**; flaky-классы (<10% / 10–30% / >30%); алерты регрессии длительности; аномалии (2σ); сравнение двух прогонов; галерея скриншотов, видео и трейсов; сетевые логи из trace.zip; quality gates; auto-quarantine; flamechart шагов. |
| [Ortoni Report](https://github.com/ortoniKC/ortoni-report) | **Error Similarity Grouping**; сравнение упавшей и успешной попытки бок о бок; heatmap надёжности; ⌘K-палитра, J/K-навигация; «Suggest Fix» через OpenAI, Gemini, Claude, Ollama. |
| [Monocart reporter](https://github.com/cenfun/monocart-reporter) | Tree-grid на тысячи тестов; пользовательские колонки (владелец, Jira) из комментариев и аннотаций; Mermaid в Markdown; HAR и Lighthouse; coverage; **редакция секретов**. |
| [Playwright Pulse](https://github.com/Arghajit47/playwright-pulse) (+ [статья про AI analyzer](https://medium.com/@arghajitsingha47/introducing-ai-analyzer-integrated-into-playwright-pulse-report-by-arghajit-singha-f4c4ca839ce0)) | Тренды; AI-анализ паттернов падений и узких мест; email-версия отчёта с таблицей статистики. |
| [deepakkamboj/playwright-ai-reporter](https://github.com/deepakkamboj/playwright-ai-reporter) | Категории Timeout / Selector / Network; AI fix suggestions; автосоздание Jira, GitHub и Azure DevOps задач; draft PR с фиксом; история в SQL. |
| [sechavarriar/playwright-ai-reporter](https://github.com/sechavarriar/playwright-ai-reporter) | Простейшая схема: репортёр, LLM, `ai-diagnosis.md` (причина, фикс, профилактика); провайдер переключается env-переменной. |
| [Хабр: @playwright-ai/auto-debug](https://habr.com/ru/articles/942226/) | После прогона ищет error-файлы, отправляет в LLM и встраивает ответы прямо в HTML или Allure; сопоставление ответа с тестом; MCP заметно повышает точность за счёт DOM. |
| [dev.to: Debugging with AI](https://dev.to/playwright/debugging-playwright-tests-with-ai-a-smarter-faster-workflow-4501) | «Copy prompt» и «Fix with AI» в UI mode, VS Code, HTML-отчёте и trace viewer: контекст = снапшот, ошибка, код. |
| [bug0: Playwright Test Agents](https://bug0.com/blog/playwright-test-agents), [Bondar Academy review](https://bondaracademy.com/blog/playwright-ai-agents-review) | Из трёх агентов (planner, generator, healer) реально полезен **healer**: перезапускает тест в debug, собирает консоль, сеть и снапшоты, чинит. Трейсы решений агента — аудит. |
| [TestMu AI](https://www.testmuai.com/learning-hub/playwright-ai/), [testomat.io](https://testomat.io/blog/playwright-ai-revolution-in-test-automation/), [ContextQA](https://learning.contextqa.com/testing-with-ai-coding-agents/playwright-testing), [mcpmarket skill](https://mcpmarket.com/tools/skills/playwright-test-reporting-7) | RCA = «упавший шаг + вероятная причина + трейс»; автоматический черновик баг-репорта; разделение падений на product / test data / locator / environment; приоритизация тестов по истории; свой AI-провайдер ради комплаенса. |

Не открылись полностью (рендер на JS или таймаут): stagewright.dev и часть статей Medium и TestDino.
По ним использованы README репозиториев и поисковые выдержки.

## Что уже есть в этом пакете

- Вкладки с Markdown, HTML и iframe, добавление после прогона из Jenkins.
- Failure analysis: группировка по сигнатуре ошибки, категории, failure rate, место в коде.
- `report-summary.json` как вход для LLM; кликабельные ссылки на тесты из Markdown.
- Всё штатное: Copy prompt, trace viewer, фильтры, Speedboard, темы.

## Идеи: что добавить дальше

Приоритет учитывает ценность для разбора падений и сложность. Метки: **[UI]** — только web,
**[R]** — репортёр, **[CI]** — нужна история или внешнее хранилище.

### P1: быстро и сильно помогает разбору

1. **Классификация падений: Product bug / Test bug / Environment / Flaky** [R][UI]. Эвристики уже есть
   (`categorize()`); добавить LLM-классификацию через вашу модель и **бейдж категории в списке тестов**
   и на странице теста. Аналог: TestDino, ReportPortal Auto-Analysis.
2. **Фильтр по кластеру в поиске** [UI]: `cluster:3` в строке поиска, клик по группе в Failure analysis
   фильтрует список штатным UI. Это небольшое расширение `filter.ts`.
3. **Сравнение попыток бок о бок** [UI]: retry #0 (упал) и retry #1 (прошёл), шаги, длительности,
   скриншоты. Лучший инструмент для flaky. Аналог: Ortoni.
4. **Блок «AI-разбор» на странице теста** [UI]: если в `report-summary` или вкладке есть разбор для
   `testId`, показать его прямо над ошибкой. Пользователю не нужно переключаться на вкладку.
5. **Шаблон баг-репорта** [UI]: кнопка «Copy bug report» собирает шаги, ошибку, окружение,
   ссылку на билд и трейс в Markdown для Jira. Аналог: TestMu, playwright-ai-reporter.
6. **Редакция секретов** [R]: маскировать токены, пароли и cookie в stdout, ошибках и вложениях перед
   записью в отчёт и в `report-summary.json`. Обязательно, если данные уходят в LLM. Аналог: Monocart.

### P2: история прогонов (нужно хранилище)

7. **История и flaky-score по прогонам** [CI]: хранить `report-summary.json` каждого билда (артефакты
   Jenkins или Nexus raw), при генерации подмешивать последние N. В UI: «упал 3 из 10 последних»,
   sparkline на тесте, класс Stable / Unstable / Flaky, **"new failure" против "known failure"**.
   Самое ценное после кластеризации. Аналог: Smart Reporter, Ortoni, TestDino.
8. **Регрессии длительности** [CI]: тест стал в 2 раза медленнее медианы. Аналог: Smart Reporter.
9. **Diff с предыдущим прогоном** [CI]: что начало падать, что починилось, что стало flaky.
10. **Quality gate** [R]: порог failure rate или «нет новых падений», exit code или файл для Jenkins.
11. **Карантин** [CI]: список хронически flaky тестов, помеченных в отчёте отдельно от реальных падений.

### P3: глубокая отладка

12. **Сеть из trace.zip** [R]: вытащить запросы со статусом 4xx/5xx у упавшего теста и показать
    «бэкенд вернул 500 на /api/cart». Часто это и есть причина. Аналог: Smart Reporter.
13. **Ошибки консоли браузера** у упавшего теста отдельным блоком (тоже из трейса).
14. **Галерея падений** [UI]: сетка скриншотов всех упавших тестов, визуально видно, что «везде пустая страница».
15. **Mermaid в Markdown-вкладках** [UI]: LLM рисует диаграмму причин и следствий.
16. **Колонки владельца и Jira** [UI]: из `annotations` (`test.info().annotations.push({type:'owner'})`),
    фильтр «мои падения».
17. **Тепловая карта** тестов по времени и шардам: падения в одно время указывают на окружение.

### P4: агенты по клику

18. **Кнопка «Спросить AI» на тесте** [UI + gateway]: `fetch` к внутреннему LLM-gateway с контекстом
    (error-context, ошибка, шаги); ответ стримится в отчёт. Ключи на gateway, отчёт остаётся статикой.
    URL gateway задаётся опцией репортёра. Нужен CORS и `connect-src` в CSP.
19. **«Починить» через healer-агент** [CI]: кнопка ставит Jenkins-джобу, которая запускает Playwright
    healer (`npx playwright init-agents`) на конкретный тест и открывает MR с фиксом. Обзоры сходятся:
    из трёх агентов в деле полезен только healer.
20. **MCP-доступ к результатам**: небольшой MCP-сервер поверх `report-summary.json` и истории, чтобы
    IDE-агент отвечал на вопросы «почему упал X», «что flaky на этой неделе». Аналог: TestDino MCP.
21. **Перезапуск выбранных тестов** из отчёта: сформировать команду `--grep` или `--last-failed`, либо
    вызвать Jenkins с параметром.

## Рекомендуемый порядок

1. P1.1–P1.4: классификация, `cluster:` в поиске, сравнение попыток, AI-блок на странице теста.
   Только UI плюс ваша модель; инфраструктура не нужна.
2. P2.7: история через артефакты Jenkins. Она открывает flaky-score, «новые падения», регрессии и quality gate.
3. P1.6: редакция секретов. До того как отправлять реальные логи в LLM.
4. P4.18: «Спросить AI», когда появится внутренний gateway.
