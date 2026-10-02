import { defineConfig } from '@playwright/test';

// Self-test of this package: runs the demo project in ../example and checks the generated report.
export default defineConfig({
  testDir: '.',
  testMatch: ['report.spec.ts', 'agent.spec.ts'],
  timeout: 120_000,
  reporter: 'list',
  use: {
    browserName: 'chromium',
  },
});
