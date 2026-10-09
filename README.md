# KinoPub Telegram bot

Register KinoPub devices through Telegram and clear old registrations so new devices fit within the five-device limit.

**Status:** local login, Telegram device activation, read-only checks, and daily authorization checks are implemented. Deployment is still planned.

## Flows

- **Register a device:** send its five-character alphanumeric code as plain text or `/register CODE` → check login → if there are 4–5 app registrations, remove the oldest two (FIFO) → add the device → report success or an error. Browser sessions do not count toward the limit.
- **Keep login ready:** check authorization daily; stay silent while authorized. If login expires, ask the owner in Telegram for the email confirmation code. The owner reads their email manually; the bot never accesses the mailbox.
- **Browser session:** save login state to disk, open the browser when needed, and close it afterward. Keep it open while waiting for an email code, until completion or timeout.

## Tech

TypeScript, Node.js 22+, pnpm 11.25.0, Playwright/Chromium, and grammY for Telegram. Planned hosting: Docker on the existing Hetzner CX23, using Telegram long polling.

## Commands

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
