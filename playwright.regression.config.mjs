import { defineConfig } from '@playwright/test';

const runLabel = (process.env.PW_RUN_LABEL || 'run').replace(/[^a-zA-Z0-9_-]/g, '-');

export default defineConfig({
  testDir: './.github/regression',
  testMatch: '**/login-regression.spec.mjs',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  outputDir: `artifacts/playwright-output-${runLabel}`,
  reporter: [
    ['json', { outputFile: 'artifacts/playwright-results.json' }],
  ],
  use: {
    baseURL: process.env.REGRESSION_BASE_URL || 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
