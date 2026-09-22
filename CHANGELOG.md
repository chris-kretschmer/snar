# Changelog

## [Unreleased]

## [2.0.0] - 2026-09-22

### Added
- Optional `CLICK_RETENTION_DAYS` deletes old clicks daily; `SESSION_SECRET` keeps the session secret out of the database; `BIND_ADDRESS`, `COOKIE_SECURE`, `OIDC_ALLOWED_GROUPS` and `OIDC_ALLOWED_EMAIL_DOMAINS` (see README).
- Deleted SSO accounts are blocked and can be released again under "Gesperrte SSO-Zugänge" in the user administration.
- Test suite (`npm test`) and CI steps for tests, `npm audit` and a Docker build; Dependabot for npm, Docker and Actions.
- Database migrations: the schema version is stored in the database (`PRAGMA user_version`), later schema changes are numbered steps in `src/migrations.js` that run in a transaction on start, after an automatic backup file (`snar-vor-migration-v<N>-<time>.db`). A database written by a newer version is refused instead of being damaged.
- Update hint for admins: a box at the bottom of the sidebar shows when a newer release exists (checks the GitHub Releases API every 6 hours, can be dismissed per version, `UPDATE_CHECK=off` disables the request).
- Admin page "Darstellung" with an instance name (sidebar, login page, tab title) and one accent colour for the whole UI (links, active navigation, hover, focus rings, charts). The colour has a live preview, a contrast check (at least 4.5:1 on white) and both settings can be reset to their default. Stored in the `meta` table; the colour is served as `/static/theme.css`.
- The click chart can be operated with the keyboard (arrow keys, Home/End, Esc) and announces the selected value to screen readers.
- Shared chart maths for server and browser in `public/chart-shared.js` (new file), so the server render and the client redraw cannot drift apart.

### Changed
- **Breaking (the reason for 2.0.0):** the port is now published on `127.0.0.1` only. Installations that reach snar directly on the server address stop working until `BIND_ADDRESS=0.0.0.0` is set in `.env`; the better setup is a reverse proxy with HTTPS in front (see README). Going back to 1.x is not supported after the first start (schema migrations, password hash format).
- Dependencies updated: better-sqlite3 13.0.3 (SQLite 3.53), openid-client 6.8.8, compression 1.8.2; the CI uses actions/checkout 7 and actions/setup-node 7. Dependabot checks npm, Docker and Actions once a month.
- Clicks are counted only for real visits: no `HEAD` requests, no link previews or crawlers, at most one click per visitor and link every 5 seconds and 120 per minute. The redirect always works.
- `links.clicks_total` is kept by database triggers (migration), so the link lists no longer count every click of every row.
- Password hashes carry their scrypt parameters and use stronger settings (async, no blocking of the server); older hashes are upgraded on the next login.
- The `Dockerfile` pins the base image by digest; `compose.yaml` runs the container read-only without capabilities, with `init`, memory and process limits; `ADMIN_PASSWORD` is only needed for the first start; `/healthz` checks the database.
- Statistics ranges share one bucket builder (output verified identical); wording unified (Konto, Nutzername, Kurzlink, Gemeinsamer Tresor); errors use one small error page.
- Link detail page reworked: KPI card, click chart with a rounded Y axis (including 0) and a dashed, still running last period, distribution lists with a "Weitere" dialog, paginated latest clicks.
- Card headings renamed: Link-Details, Klickverlauf, Besuchende, Quelle.
- The back link keeps the previous list position, and the sidebar highlight stays after paging.
- The copy button on the detail page is now a visible bordered button. The "Link löschen" card is simplified (slug shown in the text, real heading).
- CSS cleanup: one set of breakpoints (520/760/1040/1200/1480 px), colours as variables, classes instead of inline styles, shorter comments.
- Accessibility: custom dropdowns use real `option` roles, the hidden native controls are `aria-hidden`, and the confirmation dialog has a title and an `h2` heading. Also `autocomplete="off"` on non-login fields, `translate="no"` on slugs and URLs, and a non-breaking space before "Uhr".

### Fixed
- Login limits no longer let a stranger lock the real user out (per IP and name, a high ceiling per name), the per-IP counter is not reset by a successful login, and checking the current password when changing it is limited too.
- Cross-site login posts are rejected (login CSRF); a foreign link answers 404 instead of 403.
- User names are unique regardless of case (migration, skipped with a warning if duplicates exist).
- The domain in `DOMAINS` is only seeded on the very first start; a link change and its change-log entry, and removing a domain, are single transactions.
- The server shuts down cleanly on `SIGTERM`; docker stop no longer waits for the timeout.
- Front end: "Zurück" after a failed save, dismissed date picker choices, expiry shown in the browser time zone, hidden EPC amount no longer blocks "Erzeugen", session expiry in the domain check, backdrop and Esc handling in dialogs, doubled recipient field when deleting a user, focus stays in the mobile sidebar, thousands separators in the chart tooltip, the chosen QR background colour survives "transparent".
- Deleting a user failed with a 500 error if they had changed a target URL before (reference in the change log).
- Malformed session cookies now lead to a redirect instead of a 500 error.
- The custom date range is limited to the years 2000 to 2100.
- Daylight saving time changes no longer produce a duplicated hour or duplicated axis labels.
- The expiry date keeps the browser time zone after a failed save, and the chosen visibility is kept as well.
- Link tables no longer get equal-width columns.
- The copy button no longer stays on "Kopiert" after a fast double click.
- The focus line on form fields is one continuous band instead of two lines at fractional zoom levels.

### Security
- Optional access rules for SSO logins by group or verified e-mail domain; a deleted SSO account can no longer log in again unnoticed.
- The session cookie gets the `Secure` flag also when forced (`COOKIE_SECURE`), and `Strict-Transport-Security` is sent over TLS.
- Database and backup files are created readable by the owner only (0600).
- Flash messages travel in a signed, short-lived cookie instead of the query string, so a crafted link like `/app/users?err=...` can no longer show forged messages.
- The expiry date is validated strictly (format, calendar date, 2000 to 2100, time zone offset within +-24 h). Invalid input gives an error instead of a 500 or silently clearing the expiry.
- The domain reachability check no longer crashes on an invalid stored domain, and its private-address guard now covers IPv6 literals (`[fd00::1]`), the unspecified address, site-local and benchmark ranges.
- `DOMAINS` / `BASE_URL` are normalised when seeding the domain list (a missing scheme becomes `https://`, invalid values are skipped).
- The placeholder admin password from `.env.example` and other well-known passwords are rejected on the first start; `.env.example` no longer contains a usable password.
- Destructive buttons (delete link, user, domain) ship disabled and are enabled by the script that attaches the confirmation, so nothing is deleted before the confirmation exists.
- Everything under `/app` (pages and QR responses) is sent with `Cache-Control: no-store`; the CSP now has `frame-ancestors 'none'`, `form-action 'self'` and `base-uri 'none'` (plus `X-Frame-Options: DENY`).
- Accounts without a password hash (SSO) now do the same scrypt work on a password login, so the response time no longer reveals them.
- Target URLs are limited to 2048 characters and PNG QR codes to 2048 px, so a single request can no longer block the server.
- A generic error handler replaces Express' default one (no stack traces to the client), and unhandled promise rejections are logged instead of stopping the process.
- README: corrected the Docker network range (`172.16.0.0/12`).

## [1.0.0] - 2026-08-18

### Added
- Initial public release.

[Unreleased]: https://github.com/chris-kretschmer/snar/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/chris-kretschmer/snar/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/chris-kretschmer/snar/releases/tag/v1.0.0
