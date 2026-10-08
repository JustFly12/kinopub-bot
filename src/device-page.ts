import type { Page } from 'playwright';
import type { DeviceSnapshot } from './devices.js';
import { DeviceCheckError } from './errors.js';

export async function readDeviceSnapshot(page: Page): Promise<DeviceSnapshot> {
  const url = new URL(page.url());
  if (['https:', 'http:'].includes(url.protocol) && url.pathname !== '/device') {
    throw new DeviceCheckError('LOGIN_REQUIRED', 'Device page redirected away; complete login and any email confirmation with pnpm run auth:login.');
  }
  // Read one DOM snapshot so the count and cards cannot come from different updates.
  const snapshot = await page.evaluate(() => {
    const counters = document.querySelectorAll('.device-counter');
    const lists = document.querySelectorAll('.devices');
    return {
      loginRequired: document.querySelector('#login-form') !== null,
      validLayout: counters.length === 1 && lists.length === 1 && document.querySelector('#add-device') !== null,
      counter: counters[0]?.textContent?.trim() ?? '',
      browserSessions: document.querySelectorAll('.browsers .device.is_browser:not(.template)').length,
      rows: Array.from(document.querySelectorAll('.devices .device:not(.template):not(.is_browser)')).map(card => ({
        id: card.getAttribute('data-id')?.trim() ?? '',
        name: card.querySelector('.title')?.textContent?.trim() ?? '',
        hardware: card.querySelector('.hardware')?.textContent?.trim() ?? '',
        created: card.querySelector('.created')?.textContent?.trim() ?? '',
        accessed: card.querySelector('.accessed')?.textContent?.trim() ?? '',
      })),
    };
  });
  if (snapshot.loginRequired) {
    throw new DeviceCheckError('LOGIN_REQUIRED', 'Sign in locally with pnpm run auth:login, then retry pnpm devices.');
  }
  if (!snapshot.validLayout) {
    throw new DeviceCheckError('PAGE_CHANGED', 'Expected device-page controls are missing or duplicated.');
  }
  return {counter: snapshot.counter, rows: snapshot.rows, browserSessions: snapshot.browserSessions};
}
