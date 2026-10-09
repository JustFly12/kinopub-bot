import { DeviceCheckError } from './errors.js';
import type { DeviceReport } from './devices.js';
import { isDeviceCode, normalizeDeviceCode } from './device-code.js';
import { activateWithCleanup, type ActivationPlan, type ActivationSession } from './activation.js';
export type AuthResult = { kind: 'ready'; report: DeviceReport } | { kind: 'code' };
export interface WebsiteSession extends ActivationSession {
  inspect(): Promise<DeviceReport>;
  login(): Promise<AuthResult>;
  submitCode(code: string): Promise<AuthResult>;
  close(): Promise<void>;
}
export interface BotState {
  ownerStarted: boolean;
  nextCheckAt: number;
  lastCheckAt: number | null;
  lastResult: string;
  challengePending: boolean;
  activationPlan?: ActivationPlan;
}
export interface ServiceOptions {
  ownerId: number;
  createSession: () => WebsiteSession;
  notifyOwner: (text: string) => Promise<void>;
  saveState: (state: BotState) => Promise<void>;
  state: BotState;
  now?: () => number;
}

const DAY = 24 * 60 * 60 * 1000;
const CHALLENGE_TTL = 5 * 60 * 1000;
export function describeFailure(error: unknown): string {
  const messages: Record<string, string> = {
    LOGIN_REQUIRED: 'Authorization is required. The owner can use /login.',
    MISSING_CREDENTIALS: 'Website credentials are missing from local configuration.',
    AUTH_FAILED: 'Website login was rejected. Check credentials or try /login later.',
    AUTH_CHALLENGE_UNSUPPORTED: 'The website requires an unrecognized login step. Complete local login with pnpm run auth:login.',
    PAGE_CHANGED: 'The device page changed or its count stayed inconsistent, so the operation could not be verified.',
    WEBSITE_UNAVAILABLE: 'The website is unavailable. Try /check later.',
    SESSION_ERROR: 'The saved browser session could not be read or saved.',
    UNEXPECTED_REDIRECT: 'The website redirected to a different origin. Login stopped.',
    INVALID_DEVICE_CODE: 'Device code must contain exactly five alphanumeric characters.',
    DEVICE_CODE_REJECTED: 'The website rejected the device code.',
    ACTIVATION_UNCONFIRMED: 'The website accepted the code, but the new device did not appear in time.',
    REMOVAL_FAILED: 'An old device could not be removed. Activation stopped.',
    REMOVAL_UNCONFIRMED: 'An old device still appeared after removal. Activation stopped.',
  };
  if (error instanceof DeviceCheckError && messages[error.code]) return `${error.code}: ${messages[error.code]}`;
  return 'CHECK_FAILED: Could not complete the website check. Try /check later.';
}
export function describeReport(report: DeviceReport): string {
  const lines = [`Authorized. App devices: ${report.count}/${report.limit}.`];
  for (const device of report.devices) lines.push(`${device.name} — ${device.created}; ${device.accessed}`);
  lines.push(report.cleanupCandidates.length
    ? `FIFO candidates for a future activation: ${report.cleanupCandidates.map(device=>device.id).join(', ')}.`
    : 'No cleanup needed before the next activation.');
  lines.push('Read-only: no devices added or removed.');
  return lines.join('\n').slice(0, 3900);
}
export class BotService {
  private tail: Promise<unknown> = Promise.resolve();
  private pending: {session: WebsiteSession; expiresAt: number; attempts: number} | undefined;
  private readonly now: () => number;
  constructor(private readonly options: ServiceOptions) { this.now = options.now ?? Date.now; }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const task = this.tail.then(action);
    this.tail = task.catch(() => {});
    return task;
  }
  private async save(): Promise<void> { await this.options.saveState({...this.options.state}); }
  status(): string {
    const state = this.options.state;
    return this.pending ? 'Waiting for the owner’s email confirmation code. Use /code CODE or /cancel.'
      : `Last result: ${state.lastResult}. Last check: ${state.lastCheckAt ? new Date(state.lastCheckAt).toISOString() : 'never'}. Daily checks: ${state.ownerStarted ? 'enabled' : 'waiting for owner /start'}.`;
  }
  startOwner(): Promise<void> {
    return this.run(async()=>{this.options.state.ownerStarted = true; await this.save();});
  }
  check(): Promise<string> { return this.run(()=>this.performCheck()); }
  activateDevice(code: string): Promise<string> {
    return this.run(async()=>{
      const normalizedCode = normalizeDeviceCode(code);
      if (!isDeviceCode(normalizedCode)) return describeFailure(new DeviceCheckError('INVALID_DEVICE_CODE', 'Invalid device code.'));
      if (this.pending) return 'Finish the pending email verification first, then resend the device code.';
      const session = this.options.createSession();
      let retain = false;
      try {
        try { await session.inspect(); }
        catch (error) {
          if (!(error instanceof DeviceCheckError) || error.code !== 'LOGIN_REQUIRED') throw error;
          if (!this.options.state.ownerStarted) return 'The owner needs to send /start before reauthorization can begin.';
          const auth = await session.login();
          if (auth.kind === 'code') {
            this.pending = {session, expiresAt:this.now()+CHALLENGE_TTL, attempts:0};
            this.options.state.challengePending = true;
            this.options.state.lastResult = 'waiting for email code';
            await this.save();
            await this.options.notifyOwner('KinoPub login needs email verification. Read the code in your email and send /code CODE here within five minutes. Then resend the five-character device code. I do not access your email.');
            retain = true;
            return 'Email verification requested from the owner. After login is restored, resend the device code.';
          }
        }
        const result = await activateWithCleanup(session, this.options.state, ()=>this.save(), normalizedCode);
        if (result.reconciledPreviousActivation) {
          this.options.state.lastResult = 'previous device activation reconciled';
          await this.save();
          return 'The previous activation is already complete. This new code was not submitted; send it again if you intended to add another device.';
        }
        this.options.state.lastResult = 'device activated';
        this.options.state.lastCheckAt = this.now();
        this.options.state.nextCheckAt = this.now()+DAY;
        await this.save();
        const removed = result.removedDeviceIds.length ? ` Removed old device IDs: ${result.removedDeviceIds.join(', ')}.` : '';
        return `Device activated. App devices: ${result.report.count}/${result.report.limit}.${removed}`;
      } catch (error) {
        this.options.state.lastResult = describeFailure(error);
        await this.save();
        return describeFailure(error);
      } finally {if(!retain) await session.close();}
    });
  }
  private async performCheck(): Promise<string> {
    if (this.pending) return 'Login is already waiting for the owner’s email code. No new email was requested.';
    const session = this.options.createSession();
    let retain = false;
    let challengeCreated = false;
    try {
      let report: DeviceReport;
      try { report = await session.inspect(); }
      catch (error) {
        if (!(error instanceof DeviceCheckError) || error.code !== 'LOGIN_REQUIRED') throw error;
        if (!this.options.state.ownerStarted) return 'The owner needs to send /start before reauthorization can begin.';
        const result = await session.login();
        if (result.kind === 'code') {
          this.pending = {session, expiresAt:this.now()+CHALLENGE_TTL, attempts:0};
          challengeCreated = true;
          this.options.state.challengePending = true;
          this.options.state.lastResult = 'waiting for email code';
          await this.save();
          await this.options.notifyOwner('KinoPub login needs email verification. Read the code in your email and send /code CODE here within five minutes. Use /cancel to stop. I do not access your email.');
          retain = true;
          return 'Email verification requested from the owner. No device changes were attempted.';
        }
        report = result.report;
      }
      await this.recordSuccess();
      return describeReport(report);
    } catch (error) {
      if (challengeCreated) this.pending = undefined;
      this.options.state.challengePending = false;
      this.options.state.lastResult = describeFailure(error);
      this.options.state.lastCheckAt = this.now();
      await this.save();
      return describeFailure(error);
    } finally { if (!retain) await session.close(); }
  }
  private async recordSuccess(): Promise<void> {
    this.options.state.lastResult = 'authorized';
    this.options.state.lastCheckAt = this.now();
    this.options.state.nextCheckAt = this.now()+DAY;
    this.options.state.challengePending = false;
    await this.save();
  }
  tick(): Promise<void> {
    return this.run(async()=>{
      if (this.pending) {
        if (this.now() >= this.pending.expiresAt) {
          await this.endChallenge('email challenge expired');
          await this.options.notifyOwner('Email verification timed out. Send /login when ready for a fresh attempt.');
        }
        return;
      }
      const state = this.options.state;
      if (!state.ownerStarted || this.now() < state.nextCheckAt) return;
      // Persist before any login attempt so a restart cannot repeatedly trigger emails.
      state.nextCheckAt = this.now()+DAY;
      await this.save();
      const result = await this.performCheck();
      if (!this.pending && state.lastResult !== 'authorized') await this.options.notifyOwner(result);
    });
  }
  submitCode(sender: number, code: string): Promise<string> {
    return this.run(async()=>{
      if (sender !== this.options.ownerId) return 'Only the owner can complete email verification.';
      const pending = this.pending;
      if (!pending) return 'No pending email verification. Use /login to check authorization.';
      if (this.now() >= pending.expiresAt) { await this.endChallenge('email challenge expired'); return 'Email verification expired. Send /login to try again.'; }
      if (!/^[A-Za-z0-9-]{3,32}$/.test(code)) return 'Use /code followed by the confirmation code from your email.';
      try {
        pending.attempts++;
        const result = await pending.session.submitCode(code);
        if (result.kind === 'code') {
          if (pending.attempts >= 3) { await this.endChallenge('too many rejected codes'); return 'Three codes were rejected. Login stopped; use /login for a new attempt.'; }
          return 'The website did not accept that code. Check the latest email and try /code again.';
        }
        await this.endChallenge('authorized');
        await this.recordSuccess();
        return `Login restored and session saved.\n${describeReport(result.report)}`;
      } catch (error) {
        await this.endChallenge(describeFailure(error));
        return describeFailure(error);
      }
    });
  }
  private async endChallenge(reason: string): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    this.options.state.challengePending = false;
    this.options.state.lastResult = reason;
    this.options.state.nextCheckAt = this.now()+DAY;
    try { await pending?.session.close(); } finally { await this.save(); }
  }
  cancel(sender: number): Promise<string> {
    return this.run(async()=>{
      if(sender !== this.options.ownerId) return 'Only the owner can cancel email verification.';
      if(!this.pending) return 'No pending email verification.';
      await this.endChallenge('email verification cancelled'); return 'Email verification cancelled.';
    });
  }
  close(): Promise<void> {
    return this.run(async()=>{if(this.pending) await this.endChallenge('bot stopped');});
  }
}
