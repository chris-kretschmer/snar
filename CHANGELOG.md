# Changelog

## [Unreleased]

### Added
- Database migrations: the schema version is stored in the database (`PRAGMA user_version`), later schema changes are numbered steps in `src/migrations.js` that run in a transaction on start, after an automatic backup file (`snar-vor-migration-v<N>-<time>.db`). A database written by a newer version is refused instead of being damaged.
- Update hint for admins: a box at the bottom of the sidebar shows when a newer release exists (checks the GitHub Releases API every 6 hours, can be dismissed per version, `UPDATE_CHECK=off` disables the request).
- Admin page "Darstellung" with an instance name (sidebar, login page, tab title) and one accent colour for the whole UI (links, active navigation, hover, focus rings, charts). The colour has a live preview, a contrast check (at least 4.5:1 on white) and both settings can be reset to their default. Stored in the `meta` table; the colour is served as `/static/theme.css`.
- The click chart can be operated with the keyboard (arrow keys, Home/End, Esc) and announces the selected value to screen readers.
- Shared chart maths for server and browser in `public/chart-shared.js` (new file), so the server render and the client redraw cannot drift apart.

### Changed
- Link detail page reworked: KPI card, click chart with a rounded Y axis (including 0) and a dashed, still running last period, distribution lists with a "Weitere" dialog, paginated latest clicks.
- Card headings renamed: Link-Details, Klickverlauf, Besuchende, Quelle.
- The back link keeps the previous list position, and the sidebar highlight stays after paging.
- The copy button on the detail page is now a visible bordered button. The "Link löschen" card is simplified (slug shown in the text, real heading).
- CSS cleanup: one set of breakpoints (520/760/1040/1200/1480 px), colours as variables, classes instead of inline styles, shorter comments.
- Accessibility: custom dropdowns use real `option` roles, the hidden native controls are `aria-hidden`, and the confirmation dialog has a title and an `h2` heading. Also `autocomplete="off"` on non-login fields, `translate="no"` on slugs and URLs, and a non-breaking space before "Uhr".

### Fixed
- Deleting a user failed with a 500 error if they had changed a target URL before (reference in the change log).
- Malformed session cookies now lead to a redirect instead of a 500 error.
- The custom date range is limited to the years 2000 to 2100.
- Daylight saving time changes no longer produce a duplicated hour or duplicated axis labels.
- The expiry date keeps the browser time zone after a failed save, and the chosen visibility is kept as well.
- Link tables no longer get equal-width columns.
- The copy button no longer stays on "Kopiert" after a fast double click.
- The focus line on form fields is one continuous band instead of two lines at fractional zoom levels.

### Security
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

[Unreleased]: https://github.com/chris-kretschmer/snar/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/chris-kretschmer/snar/releases/tag/v1.0.0
