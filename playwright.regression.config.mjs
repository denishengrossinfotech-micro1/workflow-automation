import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './.github/regression',
  testMatch: /login-regression\.spec\.mjs/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['json', { outputFile: 'artifacts/playwright-results.json' }], ['line']],
  use: {
    baseURL: process.env.REGRESSION_BASE_URL || 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    navigationTimeout: 20_000,
    actionTimeout: 10_000,
  },
  outputDir: 'artifacts/test-results',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
