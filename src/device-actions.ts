import type { Page } from 'playwright';
import { isDeviceCode } from './device-code.js';
import { buildDeviceReport, type DeviceReport } from './devices.js';
import { readDeviceSnapshot } from './device-page.js';
import { DeviceCheckError } from './errors.js';

interface JsonResult {httpStatus: number; body: unknown}

function ensureOrigin(page: Page, origin: string): void {
  if (new URL(page.url()).origin !== origin) {
    throw new DeviceCheckError('UNEXPECTED_REDIRECT', 'The website redirected to a different origin.');
  }
}

async function requestJson(page: Page, origin: string, path: string, form?: Record<string,string>): Promise<JsonResult> {
  ensureOrigin(page, origin);
  const target = new URL(path, origin);
  if (target.origin !== origin) throw new DeviceCheckError('UNEXPECTED_REDIRECT', 'Refused a device request to another origin.');
  const result = await page.evaluate(async ({url, formData}) => {
    const headers: Record<string,string> = {'X-Requested-With':'XMLHttpRequest'};
    if (formData) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      const pageWindow = window as typeof window & {yii?: {getCsrfToken?: () => string | null}};
      const csrfToken = pageWindow.yii?.getCsrfToken?.();
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    }
    const response = await fetch(url, formData ? {
      method: 'POST', credentials: 'same-origin',
      headers,
      body: new URLSearchParams(formData).toString(),
    } : {credentials:'same-origin', headers});
    return {httpStatus: response.status, text: await response.text()};
  }, {url: target.href, formData: form});
  try {return {httpStatus: result.httpStatus, body: JSON.parse(result.text) as unknown};}
  catch {
    if (result.httpStatus >= 400) return {httpStatus: result.httpStatus, body: {}};
    throw new DeviceCheckError('PAGE_CHANGED', 'The device endpoint returned an invalid success response.');
  }
}

async function reloadReport(
  page: Page,
  origin: string,
  options: {attempts?: number; intervalMs?: number} = {},
): Promise<DeviceReport> {
  const attempts = options.attempts ?? 4;
  const intervalMs = options.intervalMs ?? 500;
  for (let attempt=0; attempt<attempts; attempt++) {
    try {
      const response = await page.goto(`${origin}/device`, {waitUntil:'domcontentloaded',timeout:30_000});
      if (response && !response.ok()) throw new DeviceCheckError('WEBSITE_UNAVAILABLE', `The website returned HTTP ${response.status()}.`);
      ensureOrigin(page, origin);
      return buildDeviceReport(await readDeviceSnapshot(page));
    } catch (error) {
      const transientPageMismatch = error instanceof DeviceCheckError && error.code === 'PAGE_CHANGED';
      if (!transientPageMismatch || attempt+1 >= attempts) throw error;
      await page.waitForTimeout(intervalMs);
    }
  }
  throw new DeviceCheckError('PAGE_CHANGED', 'The device page remained inconsistent after verification retries.');
}

export async function removeDeviceFromPage(page: Page, origin: string, id: string): Promise<DeviceReport> {
  if (!/^\d+$/.test(id)) throw new DeviceCheckError('PAGE_CHANGED', 'Refused an invalid device identifier.');
  const before = buildDeviceReport(await readDeviceSnapshot(page));
  if (!before.devices.some(device => device.id === id)) return before;
  const response = await requestJson(page, origin, '/device/remove', {id});
  if (response.httpStatus >= 400) throw new DeviceCheckError('REMOVAL_FAILED', `Device removal returned HTTP ${response.httpStatus}.`);
  const after = await reloadReport(page, origin);
  if (after.devices.some(device => device.id === id)) {
    throw new DeviceCheckError('REMOVAL_UNCONFIRMED', 'The removed device still appears on the device page.');
  }
  return after;
}

export async function activateDeviceFromPage(
  page: Page,
  origin: string,
  code: string,
  options: {attempts?: number; intervalMs?: number} = {},
): Promise<DeviceReport> {
  if (!isDeviceCode(code)) throw new DeviceCheckError('INVALID_DEVICE_CODE', 'Device code must contain exactly five alphanumeric characters.');
  const before = buildDeviceReport(await readDeviceSnapshot(page));
  const baseline = new Set(before.devices.map(device => device.id));
  const activation = await requestJson(page, origin, '/device/activate', {code});
  const activationBody = activation.body as {status?:number;message?:unknown};
  if (activation.httpStatus >= 400 || activationBody.status !== 200) {
    const message = typeof activationBody.message === 'string' ? activationBody.message : 'The website rejected the device code.';
    throw new DeviceCheckError('DEVICE_CODE_REJECTED', message);
  }
  const attempts = options.attempts ?? 10;
  const intervalMs = options.intervalMs ?? 2_500;
  for (let attempt=0; attempt<attempts; attempt++) {
    const waited = await requestJson(page, origin, `/device/wait-by-code?code=${encodeURIComponent(code)}`);
    const body = waited.body as {status?:number;device?:{id?:unknown}};
    if (waited.httpStatus < 400 && body.status === 200 && typeof body.device?.id !== 'undefined') {
      const report = await reloadReport(page, origin, options);
      const id = String(body.device.id);
      if (report.devices.some(device => device.id === id)) return report;
    }
    if (attempt+1<attempts) await page.waitForTimeout(intervalMs);
  }
  const report = await reloadReport(page, origin, options);
  const newDevices = report.devices.filter(device => !baseline.has(device.id));
  if (newDevices.length === 1) return report;
  throw new DeviceCheckError('ACTIVATION_UNCONFIRMED', 'The website accepted the code but the new device did not appear in time.');
}
