import { defineConfig } from '@playwright/test';

const runLabel = process.env.PW_RUN_LABEL || 'run';

export default defineConfig({
  testDir: './.github/regression',
  testMatch: /login-regression\.spec\.mjs/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['line'],
    ['json', { outputFile: 'artifacts/playwright-results.json' }],
    ['html', { outputFolder: 'artifacts/playwright-report-' + runLabel, open: 'never' }],
  ],
  outputDir: 'artifacts/playwright-test-results-' + runLabel,
  use: {
    baseURL: process.env.REGRESSION_BASE_URL,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    ignoreHTTPSErrors: false,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
