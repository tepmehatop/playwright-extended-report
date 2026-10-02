# Сборка и публикация в Nexus

## Сборка

```bash
npm ci
npm run build      # clean -> vite build (dist/web) -> tsc (dist/)
npm test           # нужен Chromium: npx playwright install chromium
npm pack           # playwright-extended-report-<version>.tgz
```

`npm pack` и `npm publish` сами запускают `npm run build` (скрипт `prepack`).

Что попадает в пакет (`files` в package.json): `dist/`, `docs/*.md`, `README.md`, `LICENSE`, `NOTICE`.
Runtime-зависимости: только `yazl`, `yauzl` (чтение trace.zip) и `@babel/code-frame`. React, Vite и прочее нужны лишь на этапе
сборки: UI уже собран в `dist/web`. Peer-зависимость: `@playwright/test >= 1.45`.

Проверить содержимое без создания архива: `npm pack --dry-run`.

## package-lock.json

Lockfile в репозитории собран через публичный registry (`registry.npmjs.org`). Во внутреннем контуре:

```bash
rm package-lock.json
npm install            # с .npmrc, указывающим на Nexus, lockfile пересоздастся с вашими URL
git commit -am "chore: lockfile for internal registry"
```

## Имя пакета

Для внутреннего реестра удобно использовать scope:

```jsonc
// package.json
"name": "@qa/playwright-extended-report",
```

Тогда в проекте с тестами: `['@qa/playwright-extended-report', {...}]` и `npx pw-extended-report …`
(имя бинарника от scope не зависит).

## Публикация в Nexus

```ini
# .npmrc (в репозитории или ~/.npmrc агента сборки)
@qa:registry=https://nexus.example.local/repository/npm-internal/
//nexus.example.local/repository/npm-internal/:_auth=${NEXUS_NPM_AUTH}
always-auth=true
```

```bash
npm version patch            # или minor/major
npm publish                  # уйдёт в registry из .npmrc для scope @qa
```

Либо без scope: `npm publish --registry https://nexus.example.local/repository/npm-internal/`.

Если на агенте сборки нет доступа к npmjs.org, установка зависимостей пойдёт через proxy-репозиторий
Nexus (npm-proxy): `registry=https://nexus.example.local/repository/npm-group/`.

## Версионирование

- `patch` — исправления.
- `minor` — новые вкладки и опции, синхронизация UI с новой версией Playwright.
- `major` — несовместимые изменения опций репортёра или формата вкладок (`ExtendedTabsPayload.version`).

Версия UI-исходников Playwright записана в `upstream/VERSION`.
