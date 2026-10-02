import { defineConfig } from '@playwright/test';

/**
 * Demo project: shows how the extended report is wired next to the built-in one.
 * In your project replace the reporter path with the package name:
 *   ['playwright-extended-report', { ... }]
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  retries: 1,
  reporter: [
    ['list'],
    // Built-in report stays exactly as it was.
    ['html', { outputFolder: './playwright-report', open: 'never' }],
    // The clone with extra tabs, in its own folder.
    [require.resolve('../dist/reporter/index.js'), {
      outputFolder: './extended-report',
      title: 'Demo run',
      tabs: [
        // Tabs can be attached at generation time when the file already exists.
        // The Jenkins log analysis is usually attached later with `pw-extended-report add-tab`.
        { id: 'notes', title: 'Run notes', icon: 'note', file: './run-notes.md', optional: true, order: 200 },
      ],
    }],
  ],
  use: {
    trace: 'on',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
