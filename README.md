# KinoPub Telegram bot

Register KinoPub devices through Telegram and clear old registrations so new devices fit within the five-device limit.

**Status:** local login, Telegram device registration, FIFO cleanup, read-only checks, daily authorization checks, and Docker deployment are implemented.

## Flows

- **Register a device:** send its five-character alphanumeric code as plain text or `/register CODE` → check login → register it → remove the oldest devices by FIFO until three remain. At 5/5, remove one first to make room. Browser sessions do not count toward the limit.
- **Keep login ready:** check authorization daily; stay silent while authorized. If login expires, ask the owner in Telegram for the email confirmation code. The owner reads their email manually; the bot never accesses the mailbox.
- **Browser session:** save login state to disk, open the browser when needed, and close it afterward. Keep it open while waiting for an email code, until completion or timeout.

## Tech

TypeScript, Node.js 22+, pnpm 11.25.0, Playwright/Chromium, grammY, and Docker Compose. Telegram uses long polling, so the container exposes no ports.

## Commands

Telegram commands:

```text
/register CODE  Register a five-character device code
/devices        List current devices
/check          Check Kino authorization
/status         Show whether the bot is waiting for an email code
/code CODE      Submit the confirmation code read from email
/cancel         Cancel a pending login, when safe
```

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium

pnpm run auth:login     # Sign in and enter the email code in a browser
pnpm run devices        # Read devices headlessly; no changes
pnpm run devices --json # Same report as JSON
pnpm run bot            # Start Telegram long polling and daily checks

pnpm check              # Type checking
pnpm test               # Automated tests
pnpm build              # Compile TypeScript
pnpm start devices      # Run the compiled device check
```

Optional configuration goes in `.env` (see `.env.example`). Login state is saved in `data/auth.json`; both `.env` and `data/` are excluded from Git.

## Deploy

The production instance lives at `/opt/kinopub-bot` on the Hetzner server. It uses Telegram long polling and exposes no ports. `.env`, `data/auth.json`, and `data/bot-state.json` must remain on the server and must not be committed.

After copying updated source files, stop any other bot instance and run:

```sh
cd /opt/kinopub-bot
docker compose up -d --build
docker compose ps
docker compose logs -f bot
```

The container uses `restart: unless-stopped`, so it returns automatically after a server reboot. To restart it or apply `.env` changes:

```sh
docker compose restart bot
docker compose up -d --force-recreate
```
