import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { buildDeviceReport, type DeviceReport } from './devices.js';
import { readDeviceSnapshot } from './device-page.js';
import { DeviceCheckError } from './errors.js';

function printReport(report: DeviceReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`App devices: ${report.count}/${report.limit}. Browser sessions excluded: ${report.browserSessions}.`);
  for (const device of report.devices) {
    console.log(`- ${device.id}: ${device.name} (${device.hardware})`);
    console.log(`  ${device.created}; ${device.accessed}`);
  }
  console.log(report.cleanupCandidates.length
    ? `FIFO candidates for a future activation: ${report.cleanupCandidates.map(device => device.id).join(', ')}.`
    : 'No cleanup needed before the next activation.');
  console.log('Read-only check: no app registrations added or removed.');
}

async function visitDevices(page: Page, origin: string): Promise<void> {
  const response = await page.goto(`${origin}/device`, {waitUntil: 'domcontentloaded', timeout: 30_000});
  if (response && !response.ok()) {
    throw new DeviceCheckError('WEBSITE_UNAVAILABLE', `The website returned HTTP ${response.status()}.`);
  }
  if (new URL(page.url()).origin !== origin) {
    throw new DeviceCheckError('UNEXPECTED_REDIRECT', 'The website redirected to a different origin.');
  }
}

async function saveSession(context: BrowserContext, statePath: string): Promise<void> {
  // Never print cookies. Write a private temporary file, then replace the old state atomically.
  const tempPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(await context.storageState()), {mode: 0o600, flag: 'wx'});
  await rename(tempPath, statePath);
  await chmod(statePath, 0o600);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '--help' || command === 'help') {
    console.log('Commands:\n  pnpm run auth:login       Open Chromium for manual sign-in and save the local session.\n  pnpm devices     Read app devices and show FIFO cleanup candidates.\n  pnpm devices --json   Print a JSON report.\nNo command adds or removes app devices.');
    return;
  }
  if (!['login', 'devices'].includes(command) || args.slice(1).some(arg => arg !== '--json')) {
    throw new DeviceCheckError('INVALID_ARGUMENT', 'Use login or devices, optionally followed by --json.');
  }
  if (existsSync('.env')) loadEnvFile('.env');
  const base = new URL(process.env.KINO_BASE_URL ?? 'https://kino.watch');
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new DeviceCheckError('INVALID_CONFIG', 'KINO_BASE_URL must be an HTTPS origin with no credentials or path.');
  }
  const headlessValue = process.env.PLAYWRIGHT_HEADLESS ?? 'true';
  if (!['true', 'false'].includes(headlessValue)) {
    throw new DeviceCheckError('INVALID_CONFIG', 'PLAYWRIGHT_HEADLESS must be true or false.');
  }
  const dataDir = resolve(process.env.DATA_DIR ?? './data');
  const statePath = join(dataDir, 'auth.json');
  let storageState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;
  try {
    storageState = JSON.parse(await readFile(statePath, 'utf8')) as typeof storageState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new DeviceCheckError('SESSION_ERROR', 'Saved browser session is unreadable or invalid.');
    }
  }
  if (!storageState && command === 'devices') {
    throw new DeviceCheckError('LOGIN_REQUIRED', 'No local browser session. Run pnpm run auth:login first.');
  }
  const browser = await chromium.launch({headless: command === 'login' ? false : headlessValue === 'true'});
  try {
    const context = await browser.newContext(storageState ? {storageState} : {});
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await visitDevices(page, base.origin);
    if (command === 'login' && !(await page.locator('#add-device').count())) {
      console.error('Sign in and complete any email confirmation in Chromium. Read the code from your email yourself. Waiting up to five minutes.');
      await page.locator('a[href="/user/logout"]').waitFor({state: 'attached', timeout: 300_000});
      await visitDevices(page, base.origin);
    }
    const report = buildDeviceReport(await readDeviceSnapshot(page));
    if (command === 'login') {
      await mkdir(dataDir, {recursive: true, mode: 0o700});
      await saveSession(context, statePath);
      console.error('Local browser session saved in the ignored data directory.');
    }
    printReport(report, args.includes('--json'));
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof DeviceCheckError) {
    console.error(`${error.code}: ${error.message}`);
  } else if (error instanceof Error && error.name === 'TimeoutError') {
    console.error('TIMEOUT: The website or manual login did not finish in time. No activation or cleanup was attempted.');
  } else {
    // Raw browser errors can include page contents or sensitive URLs.
    console.error('CHECK_FAILED: Could not complete the browser check. Check Chromium installation, network access, and local configuration.');
  }
  process.exitCode = 1;
}
