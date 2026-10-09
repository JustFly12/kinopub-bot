import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loginPage, submitEmailCode } from './auth-page.js';
import type { AuthResult, WebsiteSession } from './bot-service.js';
import { readDeviceSnapshot } from './device-page.js';
import { buildDeviceReport, type DeviceReport } from './devices.js';
import { DeviceCheckError } from './errors.js';
import { activateDeviceFromPage, removeDeviceFromPage } from './device-actions.js';

export interface WebsiteSessionOptions {
  origin: string;
  statePath: string;
  username: string;
  password: string;
  headless?: boolean;
}

export class PlaywrightWebsiteSession implements WebsiteSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;

  constructor(private readonly options: WebsiteSessionOptions) {}

  private async open(): Promise<Page> {
    if (this.page) return this.page;
    let storageState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;
    if (existsSync(this.options.statePath)) {
      try {
        storageState = JSON.parse(await readFile(this.options.statePath, 'utf8')) as typeof storageState;
      } catch {
        throw new DeviceCheckError('SESSION_ERROR', 'Saved browser session is unreadable.');
      }
    }
    this.browser = await chromium.launch({headless: this.options.headless ?? true});
    this.context = await this.browser.newContext(storageState ? {storageState} : {});
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(15_000);
    return this.page;
  }

  private async gotoDevices(): Promise<Page> {
    const page = await this.open();
    const response = await page.goto(`${this.options.origin}/device`, {waitUntil: 'domcontentloaded', timeout: 30_000});
    if (response && !response.ok()) {
      throw new DeviceCheckError('WEBSITE_UNAVAILABLE', `The website returned HTTP ${response.status()}.`);
    }
    if (new URL(page.url()).origin !== this.options.origin) {
      throw new DeviceCheckError('UNEXPECTED_REDIRECT', 'The website redirected to a different origin.');
    }
    return page;
  }

  async inspect(): Promise<DeviceReport> {
    const page = await this.gotoDevices();
    return buildDeviceReport(await readDeviceSnapshot(page));
  }

  async login(): Promise<AuthResult> {
    const page = await this.open();
    const result = await loginPage(page, this.options.origin, this.options.username, this.options.password);
    if (result.kind === 'ready') await this.saveState();
    return result;
  }

  async submitCode(code: string): Promise<AuthResult> {
    const page = await this.open();
    const result = await submitEmailCode(page, this.options.origin, code);
    if (result.kind === 'ready') await this.saveState();
    return result;
  }

  async removeDevice(id: string): Promise<DeviceReport> {
    const page = await this.gotoDevices();
    return removeDeviceFromPage(page, this.options.origin, id);
  }

  async activateDevice(code: string): Promise<DeviceReport> {
    const page = await this.gotoDevices();
    return activateDeviceFromPage(page, this.options.origin, code);
  }

  private async saveState(): Promise<void> {
    if (!this.context) throw new DeviceCheckError('SESSION_ERROR', 'Browser context is not available.');
    await mkdir(dirname(this.options.statePath), {recursive: true, mode: 0o700});
    const temporaryPath = `${this.options.statePath}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(await this.context.storageState()), {mode: 0o600, flag: 'wx'});
      await rename(temporaryPath, this.options.statePath);
      await chmod(this.options.statePath, 0o600);
    } catch {
      throw new DeviceCheckError('SESSION_ERROR', 'Could not save the browser session.');
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
  }
}
