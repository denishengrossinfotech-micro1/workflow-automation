import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const spec = JSON.parse(fs.readFileSync('artifacts/test-spec.json', 'utf8'));
const validEmail = process.env.REGRESSION_TEST_EMAIL;
const validPassword = process.env.REGRESSION_TEST_PASSWORD;
const authPattern = new RegExp(process.env.REGRESSION_AUTH_URL_PATTERN || '(login|auth|session|token)', 'i');

function observe(page) {
  const telemetry = {
    startedAt: new Date().toISOString(),
    consoleErrors: [],
    javascriptExceptions: [],
    requestFailures: [],
    responses: [],
    navigations: [],
  };

  page.on('console', (message) => {
    if (message.type() === 'error') {
      telemetry.consoleErrors.push({ text: message.text(), location: message.location() });
    }
  });
  page.on('pageerror', (error) => telemetry.javascriptExceptions.push({ message: error.message, stack: error.stack }));
  page.on('requestfailed', (request) => telemetry.requestFailures.push({
    method: request.method(),
    url: request.url(),
    failure: request.failure()?.errorText || 'unknown',
  }));
  page.on('response', (response) => telemetry.responses.push({
    method: response.request().method(),
    url: response.url(),
    status: response.status(),
    ok: response.ok(),
    durationMs: response.request().timing().responseEnd,
  }));
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) telemetry.navigations.push({ url: frame.url(), at: new Date().toISOString() });
  });
  return telemetry;
}

async function attachTelemetry(testInfo, telemetry) {
  telemetry.finishedAt = new Date().toISOString();
  await testInfo.attach('runtime-telemetry.json', {
    body: Buffer.from(JSON.stringify(telemetry, null, 2)),
    contentType: 'application/json',
  });
}

async function openLogin(page) {
  await page.goto(spec.runtime.baseUrl, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: /login/i })).toBeVisible();
}

async function submitLogin(page, email, password) {
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  const responsePromise = page.waitForResponse(
    (response) => authPattern.test(new URL(response.url()).pathname),
    { timeout: 10_000 },
  );
  await page.getByRole('button', { name: /^login$/i }).click();
  return responsePromise;
}

test.describe('@doc:TC-LOGIN-001 Login button functionality', () => {
  test('valid credentials send authentication request and open Dashboard', async ({ page }, testInfo) => {
    const telemetry = observe(page);
    try {
      await openLogin(page);
      const response = await submitLogin(page, validEmail, validPassword);
      expect(response.status(), 'Authentication response must be successful').toBeGreaterThanOrEqual(200);
      expect(response.status(), 'Authentication response must not be an error').toBeLessThan(400);
      await expect(page.getByRole('heading', { name: /dashboard|welcome/i })).toBeVisible();
      expect(telemetry.javascriptExceptions, 'No JavaScript exceptions are permitted').toEqual([]);
      expect(telemetry.consoleErrors, 'No browser console errors are permitted').toEqual([]);
      expect(telemetry.requestFailures, 'No network connection failures are permitted').toEqual([]);
    } finally {
      await attachTelemetry(testInfo, telemetry);
    }
  });

  test('invalid credentials send authentication request and show the documented error', async ({ page }, testInfo) => {
    const telemetry = observe(page);
    try {
      await openLogin(page);
      const response = await submitLogin(page, `invalid-${Date.now()}@example.invalid`, 'definitely-wrong');
      expect([400, 401, 403, 422], 'Invalid credentials must receive a validation/authentication response').toContain(response.status());
      await expect(page.getByText(spec.expectations.invalidCredentialsMessage, { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: /login/i })).toBeVisible();
      await expect(page.getByRole('heading', { name: /dashboard|welcome/i })).toHaveCount(0);
      expect(telemetry.javascriptExceptions, 'No JavaScript exceptions are permitted').toEqual([]);
      expect(telemetry.consoleErrors, 'No browser console errors are permitted').toEqual([]);
      const unrelatedFailures = telemetry.requestFailures.filter((item) => !authPattern.test(new URL(item.url).pathname));
      expect(unrelatedFailures, 'No unrelated network connection failures are permitted').toEqual([]);
    } finally {
      await attachTelemetry(testInfo, telemetry);
    }
  });

  test('empty login input is rejected without crashing or leaving Login', async ({ page }, testInfo) => {
    const telemetry = observe(page);
    try {
      await openLogin(page);
      const authRequests = [];
      page.on('request', (request) => {
        if (authPattern.test(new URL(request.url()).pathname)) authRequests.push(request.url());
      });
      await page.getByRole('button', { name: /^login$/i }).click();
      await page.waitForTimeout(500);
      await expect(page.getByRole('heading', { name: /login/i })).toBeVisible();
      const visibleValidation = page.locator('[role="alert"], .error, input:invalid');
      await expect(visibleValidation.first(), 'Input validation must be visible').toBeVisible();
      expect(authRequests, 'Empty credentials must not be sent to authentication').toEqual([]);
      expect(telemetry.javascriptExceptions, 'No JavaScript exceptions are permitted').toEqual([]);
      expect(telemetry.consoleErrors, 'No browser console errors are permitted').toEqual([]);
    } finally {
      await attachTelemetry(testInfo, telemetry);
    }
  });
});
