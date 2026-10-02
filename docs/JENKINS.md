# Jenkins

## Пайплайн

```groovy
pipeline {
  agent any
  stages {
    stage('Install') {
      steps {
        sh 'npm ci'                      // playwright-extended-report подтянется из Nexus
        sh 'npx playwright install --with-deps chromium'
      }
    }
    stage('Test') {
      steps {
        // Не валим stage: отчёты нужно собрать в любом случае.
        sh 'npx playwright test || echo "tests failed" > .tests-failed'
      }
    }
    stage('Analyze') {
      steps {
        // 1. Ваш скилл анализа логов -> analysis.md
        //    На вход можно дать extended-report/report-summary.json (см. LLM_INTEGRATION.md)
        sh 'node tools/jenkins-log-skill.js --out analysis.md || true'
        // 2. Прицепить результат вкладкой (--optional: если скилл ничего не создал, не падаем)
        sh '''npx pw-extended-report add-tab extended-report \
              --id ai --title "AI анализ" --icon sparkle --order 10 \
              --source "jenkins-log-skill #${BUILD_NUMBER}" \
              --file analysis.md --optional'''
      }
    }
  }
  post {
    always {
      publishHTML(target: [
        reportName: 'Playwright Report',  reportDir: 'playwright-report', reportFiles: 'index.html',
        keepAll: true, alwaysLinkToLastBuild: true, allowMissing: true,
      ])
      publishHTML(target: [
        reportName: 'Extended Report', reportDir: 'extended-report', reportFiles: 'index.html',
        keepAll: true, alwaysLinkToLastBuild: true, allowMissing: true,
      ])
      archiveArtifacts artifacts: 'extended-report/report-summary.json', allowEmptyArchive: true
      script { if (fileExists('.tests-failed')) currentBuild.result = 'UNSTABLE' }
    }
  }
}
```

## CSP

HTML Publisher по умолчанию отдаёт страницы со строгим Content-Security-Policy. С ним **не работает
ни штатный отчёт Playwright, ни этот** (инлайн-скрипт, `blob:`, `data:`). Если штатный отчёт у вас уже
открывается в Jenkins, CSP уже ослаблен и расширенный отчёт тоже заработает.

Если нет, у администратора Jenkins есть варианты (от предпочтительного к простому):

1. Включить Resource Root URL (*Manage Jenkins → System → Resource Root URL*): артефакты отдаются
   с отдельного домена, CSP можно не трогать.
2. Ослабить CSP через системное свойство, например:
   ```
   -Dhudson.model.DirectoryBrowserSupport.CSP="sandbox allow-scripts allow-same-origin allow-popups allow-downloads; default-src 'self' 'unsafe-inline' blob: data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; frame-src 'self' blob:;"
   ```
3. Опция репортёра `doNotInlineAssets: true` выносит JS и CSS в отдельные файлы. Это убирает
   инлайн-скрипт из `index.html`, но не снимает остальных ограничений.

Trace viewer использует service worker и требует HTTP(S). По `file://` он не откроется, «Copy prompt»
тоже (браузер запрещает `fetch` на `file://`). Это верно и для штатного отчёта.

## Шардинг

```bash
# на каждом агенте
npx playwright test --shard=1/4 --reporter=blob
# после сбора blob-report/*.zip в одну папку
npx playwright merge-reports -c merge.config.ts ./all-blob-reports
```

```ts
// merge.config.ts
export default {
  reporter: [['html'], ['playwright-extended-report', { outputFolder: 'extended-report' }]],
};
```

Таймлайн шардов в Speedboard в объединённом расширенном отчёте не показывается (см. ARCHITECTURE.md).
