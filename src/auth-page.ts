import type { Page } from 'playwright';
import type { AuthResult } from './bot-service.js';
import { buildDeviceReport } from './devices.js';
import { readDeviceSnapshot } from './device-page.js';
import { DeviceCheckError } from './errors.js';

function ensureOrigin(page: Page, origin: string): void {
  if (new URL(page.url()).origin !== origin) {
    throw new DeviceCheckError('UNEXPECTED_REDIRECT', 'The website redirected to a different origin.');
  }
}

async function inspectAfterLogin(page: Page, origin: string): Promise<AuthResult> {
  ensureOrigin(page, origin);
  if (await page.locator('#add-device').count()) {
    if (new URL(page.url()).pathname !== '/device') {
      await page.goto(`${origin}/device`, {waitUntil: 'domcontentloaded', timeout: 30_000});
      ensureOrigin(page, origin);
    }
    return {kind: 'ready', report: buildDeviceReport(await readDeviceSnapshot(page))};
  }
  const codeField = page.locator('input[name*="code" i], input[autocomplete="one-time-code"]');
  if (await codeField.count()) return {kind: 'code'};
  throw new DeviceCheckError('AUTH_CHALLENGE_UNSUPPORTED', 'The login page has an unrecognized confirmation step.');
}

export async function loginPage(page: Page, origin: string, username: string, password: string): Promise<AuthResult> {
  if (!username || !password) {
    throw new DeviceCheckError('MISSING_CREDENTIALS', 'Website username and password are required for re-login.');
  }
  await page.goto(`${origin}/user/login`, {waitUntil: 'domcontentloaded', timeout: 30_000});
  ensureOrigin(page, origin);
  const form = page.locator('#login-form');
  if (!await form.count()) return inspectAfterLogin(page, origin);
  await form.locator('#login-form-login').fill(username);
  await form.locator('#login-form-password').fill(password);
  await form.locator('button[type="submit"], input[type="submit"], button').first().click();
  await page.waitForLoadState('domcontentloaded');
  return inspectAfterLogin(page, origin);
}

export async function submitEmailCode(page: Page, origin: string, code: string): Promise<AuthResult> {
  ensureOrigin(page, origin);
  const codeSelector = 'input[name*="code" i], input[autocomplete="one-time-code"]';
  const field = page.locator(codeSelector).first();
  if (!await field.count()) {
    throw new DeviceCheckError('AUTH_CHALLENGE_UNSUPPORTED', 'The email confirmation form could not be identified safely.');
  }
  const form = field.locator('xpath=ancestor::form[1]');
  if (!await form.count()) {
    throw new DeviceCheckError('AUTH_CHALLENGE_UNSUPPORTED', 'The email confirmation field is not inside a form.');
  }
  const action = await form.getAttribute('action');
  if (action && new URL(action, origin).origin !== origin) {
    throw new DeviceCheckError('UNEXPECTED_REDIRECT', 'The confirmation form targets a different origin.');
  }
  const button = form.getByRole('button').first();
  if (!await button.count()) {
    throw new DeviceCheckError('AUTH_CHALLENGE_UNSUPPORTED', 'The confirmation form has no submit button.');
  }
  await field.fill(code);
  await button.click();
  await page.waitForLoadState('domcontentloaded');
  return inspectAfterLogin(page, origin);
}
