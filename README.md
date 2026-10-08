# KinoPub Telegram bot

Current milestone: a read-only Playwright device check and a manual local login command. Telegram handling, activation, deletion, and server deployment are not implemented yet.

## Setup

Requires Node.js 22+ and pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm test
pnpm build
```

## Sign in and inspect devices

```sh
pnpm run auth:login
pnpm devices
pnpm devices --json
```

`auth:login` opens visible Chromium. Sign in there and complete any email verification yourself. It waits up to five minutes for the signed-in page, verifies the device list, then saves browser authentication state in `data/auth.json` with owner-only file permissions. Passwords and email codes are not read by the CLI. The data directory is ignored by git; treat its contents as credentials.

`devices` reuses the saved state in headless Chromium, lists app registrations oldest first, and reports which two would be removed on a future activation when there are four or five registrations. It excludes browser sessions and template cards. It refuses inconsistent counts, missing IDs, invalid dates, and unexpected page layouts. It does not add or remove anything. A redirect away from the device page stops with `LOGIN_REQUIRED`; run `pnpm run auth:login` to restore authorization.

The Codex in-app browser and this CLI have separate sessions. Signing in in Codex verifies the website but does not automatically create the CLI's auth file.

Optional settings in `.env`: `KINO_BASE_URL` (HTTPS origin), `PLAYWRIGHT_HEADLESS` (`true` or `false`, used by `devices`), and `DATA_DIR`. `auth:login` always uses a visible browser. Other entries in `.env.example` are reserved for the future Telegram implementation. `pnpm start` prints help; after building, `pnpm start devices` runs the compiled check.

## Verification

`pnpm test` uses synthetic HTML in real headless Chromium plus domain tests. It covers app/browser separation, capacity thresholds, FIFO ordering, invalid dates/IDs/counts, login redirects, and no add/delete control interaction. Tests do not log into the real account.

The live device-page selectors were checked in the signed-in Codex browser. The public login page also returned HTTP 200 and the expected fields in headless Playwright. The CLI's saved-session login flow still needs an end-to-end run with a human completing the email challenge.

## Planned daily authorization checks

Once a day, the bot will open headless Chromium with its saved session and check the device page. If authorization is valid, it will close the browser and stay silent. If the session has expired, it will start login and privately ask the designated Telegram owner for an email confirmation code when required. The owner reads their email manually; the bot never accesses the mailbox.

A pending login attempt keeps its browser open only until verification completes or times out. Prevent duplicate notifications and repeated confirmation emails. If the challenge expires, allow a fresh login attempt. Save the refreshed session after verifying successful authorization. Daily checks and device activations share one account queue, and authorization is also checked before each activation.

Keeping a browser running continuously is out of scope for now. Launch it for a check or activation, reuse saved session state, and close it when the operation finishes. These scheduled checks and Telegram prompts are planned, not implemented in the current CLI.

## Planned Telegram flow

An allowed Telegram user submits a device code. One worker per account verifies authorization and reads devices. At four or five app registrations it removes the oldest two, then adds the new code and verifies the result; at zero to three it skips cleanup. FIFO uses registration date, not last activity. An old registration can still be active.

Persist request progress before mutations. Retries must not repeat cleanup, and ambiguous activation results must be reconciled before resubmission. If authorization expires, pause the account queue and start a login attempt. If an email confirmation code is required, ask the designated Telegram owner for it and keep that browser login attempt open until completion or timeout. Only accept a code from that owner in a private chat while a login challenge is pending. Never interpret an email confirmation code as a device code, log it, persist it, or access the mailbox. On successful login save the new session and revalidate the queued device request; time-sensitive device codes may need replacement.

The owner manually reads their email. No email connector, mailbox credentials, or mailbox permissions will be used. Actual email-challenge selectors and expiry behavior still need inspection during a future login challenge.

## Hosting

Reuse the existing Hetzner CX23 after checking resources, OS, and running services. Run the bot and headless Chromium in a container with persistent data and automatic restart. Telegram long polling requires no incoming bot port or domain. Browser session storage can survive browser and process restarts, but cannot prevent server-side expiry. Run the daily authorization check inside the bot service and verify authorization before each activation. Keep the bot process running, but launch Chromium only when needed. The existing MTProxy can remain installed.

## Files kept out of Git

`.gitignore` excludes dependencies, build output, local `.env` files, runtime data, browser authentication state, SQLite databases, browser test artifacts, and logs. `.env.example` and `pnpm-lock.yaml` remain tracked so setup is reproducible. Use placeholders only in the environment template.

Keep credentials and session files under the ignored paths. If you change `DATA_DIR` to another directory inside the repository, add that directory to `.gitignore` before committing. Ignore rules do not remove files already tracked by Git.
