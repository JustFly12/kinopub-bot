import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { readDeviceSnapshot } from '../src/device-page.js';
import { buildDeviceReport } from '../src/devices.js';

let browser: Browser;
before(async () => { browser = await chromium.launch({headless: true}); });
after(async () => { await browser?.close(); });
function card(id: string, className = '') {
  return `<div class="device ${className}" data-id="${id}">
    <div class="title">Test TV</div><div class="hardware">Test hardware</div>
    <div class="created">Добавлен: 07 October 2026 в 22:03</div>
    <div class="accessed">Активность: 08 October 2026 в 21:23</div>
    <button class="device-remove" onclick="document.body.dataset.deleted='yes'">Remove</button></div>`;
}
test('reads app cards only and does not press delete or activation controls', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<form id="add-device" onsubmit="document.body.dataset.added='yes';return false"><input><button>Add</button></form>
      <div class="device-counter">Устройства (<span>2</span>/5)</div>
      <div class="devices">${card('', 'template')}${card('100')}${card('200')}</div>
      <div class="browsers">${card('300','is_browser')}${card('400','is_browser')}${card('500','is_browser')}</div>`);
    const result = buildDeviceReport(await readDeviceSnapshot(page));
    assert.equal(result.count, 2);
    assert.equal(result.browserSessions, 3);
    assert.deepEqual(result.devices.map(d => d.id), ['100','200']);
    assert.deepEqual(result.cleanupCandidates, []);
    assert.equal(await page.locator('body').getAttribute('data-deleted'), null);
    assert.equal(await page.locator('body').getAttribute('data-added'), null);
  } finally { await page.close(); }
});
test('expired authentication is reported as login required', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<form id="login-form"><input type="password"></form>');
    await assert.rejects(readDeviceSnapshot(page), {code:'LOGIN_REQUIRED'});
  } finally { await page.close(); }
});
test('changed page layout cannot be mistaken for zero devices', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<h1>Maintenance</h1>');
    await assert.rejects(readDeviceSnapshot(page), {code:'PAGE_CHANGED'});
  } finally { await page.close(); }
});

test('authentication redirects requiring email confirmation are reported as login required', async () => {
  const page = await browser.newPage();
  try {
    // Synthetic challenge route; this is not an assertion about the site's actual challenge URL.
    await page.route('**/*', route => route.fulfill({contentType: 'text/html', body: '<h1>Enter email confirmation code</h1><input name="code">'}));
    await page.goto('https://kino.watch/test-email-challenge');
    await assert.rejects(readDeviceSnapshot(page), {code:'LOGIN_REQUIRED'});
  } finally { await page.close(); }
});
