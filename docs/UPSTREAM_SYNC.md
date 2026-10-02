# Синхронизация с Playwright

UI отчёта скопирован из `microsoft/playwright`. Обновлять его не обязательно: пакет не зависит
от версии Playwright в проекте с тестами. Обновление нужно, чтобы получить новые возможности
штатного отчёта (новые вкладки результатов, фильтры, исправления).

## Модель веток (vendor branch)

- `upstream` — **только** чистые копии файлов из Playwright. Руками не правится.
- `main` — `upstream` + наши патчи (`[extended-report]`) + наш код.

Так git сам переносит наши правки на новую версию, а конфликты возникают только там, где
Playwright поменял те же строки, что и мы.

## Процедура

```bash
# 1. Свежий Playwright рядом
git clone --depth 1 --branch v1.64.0 https://github.com/microsoft/playwright.git ../playwright

# 2. Обновить upstream-ветку
git checkout upstream
node scripts/sync-upstream.mjs ../playwright          # --dry-run покажет список изменений
git add -A && git commit -m "chore(upstream): sync html-reporter from Playwright $(cat upstream/VERSION)"

# 3. Влить в main
git checkout main
git merge upstream
#    конфликты возможны в web/src/headerView.tsx и web/src/reportView.tsx (ищите [extended-report])

# 4. Портировать изменения репортёра
git diff HEAD~1 -- upstream/html.ts                  # что поменялось в штатном html.ts
#    перенести нужное в src/reporter/html.ts
#    если изменился web/src/types.d.ts — формат данных; обязательно обновить репортёр

# 5. Проверить
npm run typecheck && npm run build && npm test
```

## На что смотреть при обновлении

| Изменилось | Действие |
|---|---|
| `web/src/types.d.ts` | Формат данных между репортёром и UI. Обновите `src/reporter/html.ts`, чтобы он заполнял новые поля. |
| Новые импорты `@web/*`, `@isomorphic/*` | Скрипт синхронизации сам скопирует их в `web/vendor/`. Если UI начал импортировать что-то из `@testIsomorphic/*` или других алиасов, добавьте алиас в `web/vite.config.ts`, `web/tsconfig.json` и в скрипт. |
| `upstream/html.ts` использует новое поле Reporter API | Перенесите и оберните в `(x as any)?.field`, чтобы не сломать старые версии Playwright. |
| Новые npm-зависимости UI | Добавьте в `devDependencies` (UI бандлится, в runtime не нужны). |
