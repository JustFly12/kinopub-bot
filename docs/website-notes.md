# Website observations

Source: user-provided device-page HTML, inspected 2026-10-08. The private HTML is deliberately not copied into this repository.

- Device page: https://kino.watch/device
- Login page: https://kino.watch/user/login
- Activation form: `#add-device`; text input has `maxlength="5"`; submit button text is `Добавить`; inline errors appear in `#add-device .errors`.
- The hint requests a five-character code. The allowed character set and server-side validation still need verification; preserve leading zeroes by treating codes as strings.
- App counter: `.device-counter span`. The supplied snapshot reports 2/5.
- App cards: `.devices .device:not(.template):not(.is_browser)` with a nonempty `data-id`.
- `.device.template` is a cloning placeholder and must not count as a registration.
- Browser sessions are in `.browsers`, marked `.is_browser`. The page explicitly says browser sessions do not occupy device slots. There are five browser cards in this snapshot; do not count or delete them for slot cleanup.
- Cards expose `.created` (registration date), `.accessed` (last activity), and `.device-remove` (delete button).
- Display dates mix Russian labels with English month names. Parse explicitly; do not rely on JavaScript's implicit Date parsing or use DOM order as FIFO.
- Use registration date ascending for the requested FIFO rule. Compare extracted app count with the displayed counter; stop on unexpected values or disagreement.
- Proposed policy: at 4 or 5 app registrations, remove the oldest two; at 0–3, remove none. Verify each removal before proceeding.
- `/scripts/device.js` is referenced but not included in the pasted HTML. Confirmation dialogs, activation completion, error responses, and backend requests remain unverified.
- Login controls, CAPTCHA/MFA behavior, headless compatibility, and access from the Hetzner server remain unverified. The web research tool could not access the login page or script.

## Live inspection, 2026-10-08

- Browser navigation succeeded despite the web research tool's earlier failure.
- Login form: `#login-form`, POST to `/user/login`; username `#login-form-login`, password `#login-form-password`, button `Войти`. Hidden CSRF and remember-me fields are present; let the browser handle them.
- The user completed login in the Codex browser and reports an email confirmation challenge. We did not inspect its intermediate DOM and have not verified a code selector.
- After sign-in, `a[href="/user/logout"]` exists and the device page matches the supplied HTML. The live app count was 2/5, with five separate browser sessions, and no cleanup candidates under the requested rule.
- Headless Playwright independently loaded the public login page with HTTP 200 and the expected username/password controls. Authenticated headless session reuse has not yet been verified.
- Current local CLI waits for the signed-in marker through manual login and email verification before saving session state. Browser sessions are not kept running between checks.
- Email access is explicitly out of scope. Future Telegram reauthorization will ask the designated owner to supply a code manually while an authentication challenge is pending.
