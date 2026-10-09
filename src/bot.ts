import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { Bot } from 'grammy';
import { BotService, type BotState } from './bot-service.js';
import { isDeviceCode, normalizeDeviceCode } from './device-code.js';
import { PlaywrightWebsiteSession } from './website-session.js';

if (existsSync('.env')) loadEnvFile('.env');

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in .env.`);
  return value;
}

function parseAllowedUsers(value: string): number[] {
  const ids = value.split(',').map(item => Number(item.trim()));
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of numeric Telegram user IDs.');
  }
  return [...new Set(ids)];
}

async function loadState(path: string): Promise<BotState> {
  const fallback: BotState = {ownerStarted: false, nextCheckAt: 0, lastCheckAt: null, lastResult: 'never', challengePending: false};
  if (!existsSync(path)) return fallback;
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as Partial<BotState>;
    const state = {...fallback, ...saved};
    if (state.challengePending) {
      state.challengePending = false;
      state.lastResult = 'email challenge interrupted by restart';
    }
    return state;
  } catch {
    throw new Error('Bot state is unreadable. Move data/bot-state.json aside and restart.');
  }
}

async function saveState(path: string, state: BotState): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2), {mode: 0o600, flag: 'wx'});
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

const token = required('TELEGRAM_BOT_TOKEN');
const allowedUsers = parseAllowedUsers(required('TELEGRAM_ALLOWED_USER_IDS'));
const ownerId = allowedUsers[0]!;
const allowed = new Set(allowedUsers);
const username = required('KINO_USERNAME');
const password = required('KINO_PASSWORD');
const base = new URL(process.env.KINO_BASE_URL ?? 'https://kino.watch');
if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('KINO_BASE_URL must be an HTTPS origin without credentials or a path.');
}
const dataDir = resolve(process.env.DATA_DIR ?? './data');
const authPath = join(dataDir, 'auth.json');
const botStatePath = join(dataDir, 'bot-state.json');
const state = await loadState(botStatePath);
const bot = new Bot(token);
const service = new BotService({
  ownerId,
  state,
  createSession: () => new PlaywrightWebsiteSession({origin: base.origin, statePath: authPath, username, password, headless: true}),
  notifyOwner: text => bot.api.sendMessage(ownerId, text).then(() => undefined),
  saveState: next => saveState(botStatePath, next),
});

bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.chat?.type !== 'private' || !allowed.has(ctx.from.id)) return;
  await next();
});

bot.command('start', async ctx => {
  if (ctx.from!.id === ownerId) await service.startOwner();
  await ctx.reply('KinoPub bot is ready. Use /devices to inspect registrations, /check to verify authorization, or /status.');
});
bot.command('devices', async ctx => ctx.reply(await service.check()));
bot.command('check', async ctx => ctx.reply(await service.check()));
bot.command('login', async ctx => ctx.reply(await service.check()));
bot.command('register', async ctx => ctx.reply(await service.activateDevice(ctx.match.trim())));
bot.command('status', async ctx => ctx.reply(service.status()));
bot.command('code', async ctx => ctx.reply(await service.submitCode(ctx.from!.id, ctx.match.trim())));
bot.command('cancel', async ctx => ctx.reply(await service.cancel(ctx.from!.id)));
bot.on('message:text', async ctx => {
  const text=ctx.message.text.trim();
  const code=normalizeDeviceCode(text);
  if(isDeviceCode(code)) {await ctx.reply(await service.activateDevice(code));return;}
  await ctx.reply('Send a five-character alphanumeric device code, or use /register CODE, /devices, /check, /status, /login, /code CODE, or /cancel.');
});
bot.catch(error => console.error('Telegram update failed:', error.message));

await bot.api.setMyCommands([
  {command: 'devices', description: 'List app devices (read-only)'},
  {command: 'check', description: 'Check KinoPub authorization'},
  {command: 'status', description: 'Show check and login status'},
  {command: 'login', description: 'Start reauthorization if needed'},
  {command: 'register', description: 'Register a device code'},
  {command: 'code', description: 'Submit an email confirmation code'},
  {command: 'cancel', description: 'Cancel pending email verification'},
]);

const timer = setInterval(() => void service.tick().catch(error => console.error('Daily check failed:', error)), 60_000);
const stop = async (signal: string): Promise<void> => {
  clearInterval(timer);
  await service.close();
  await bot.stop();
  console.info(`Bot stopped after ${signal}.`);
};
process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

console.info('Starting KinoPub Telegram bot.');
await bot.start({drop_pending_updates: false});
