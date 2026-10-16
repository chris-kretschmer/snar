# Changelog

## [Unreleased]

## [2.1.0] - 2026-10-16

Upgrading from 2.0.0: nothing to do. The first start runs migration 5 (`clicks.channel`) after an automatic backup file next to the database; going back to 2.0.x afterwards is not supported. The image is built on Node 24.

### Added
- Ready-made Docker image for amd64 and arm64 on the GitHub Container Registry (`ghcr.io/chris-kretschmer/snar`, tags `2.1.0`, `2.1`, `2` and `latest`), built by the new workflow `.github/workflows/release.yml` when a version tag is pushed (it checks that the tag matches `package.json`, runs the tests and `npm audit` first, and attaches provenance and an SBOM). `compose.yaml` names the image; `SNAR_VERSION` in `.env` pins a release; `docker compose pull && docker compose up -d` updates.
- `SECURITY.md` (private reporting through GitHub, what to expect, what is in scope) and `CLA.md` (contributor agreement; the community edition stays under the AGPL).
- Campaign parameters (UTM): `utm_source`, `utm_medium`, `utm_campaign`, `utm_term` and `utm_content` can be entered as separate fields under "Erweiterte Link-Details" when creating or editing a link. They are appended to the target URL on save; the URL that is actually opened is shown under the target URL field. Shared logic in `public/utm-shared.js`.
- Bulk download: the link lists (dashboard, personal and shared vault) have a checkbox column and a bar to download the selected links, as a ZIP of QR codes (SVG, EPS or PNG at 1024 px, each up to 1000 links) or as a CSV list for Excel (up to 2000). Links you may not open are left out. The ZIP writer (`src/zip.js`) and CSV writer (`src/csv.js`) need no new dependency; CSV cells that start with `=`, `+`, `-` or `@` are protected against spreadsheet formulas. Building a ZIP is synchronous work, so only two QR ZIPs run at a time and one per person; a further request is told to wait. The ids must be plain decimal numbers.
- EPS download for QR codes (vector, for print shops and layout programs): next to SVG and PNG on the link detail page and in the QR code generator, and as a ZIP of up to 1000 codes in the bulk download. One filled path per code, so there are no seams between modules; EPS has no transparency, so a transparent background is simply not painted. Written by `src/eps.js` without a new dependency.
- QR scan or click: new QR codes (single download, preview and the ZIPs of the bulk download) contain the short link with the marker `?q`, for example `https://kurz.example/abc?q`. The redirect ignores it and passes nothing on, but the visit is stored with the channel `qr` (migration 5, new column `clicks.channel`, older clicks stay empty) and shows up as its own source "QR-Scan" in the "Quelle" list and in "Letzte Klicks"; the referrer of a scan is dropped from the list. A visit without any referrer is now called "Direkt / unbekannt" (it used to be "(direkt / QR-Scan)"). The copy button and the displayed short link stay plain. Codes printed before this change hold the plain link and keep counting as direct visits; the marker is a statistics hint, not a security feature, anyone can append `?q`.
- Sources as platforms: the "Quelle" list and "Letzte Klicks" show "Instagram", "X", "YouTube", "Gmail", "ChatGPT" and so on instead of referrer host names such as `l.instagram.com`, `t.co` or `youtu.be`; hosts of one platform are added up (the host names stay in the tooltip), unknown hosts are shown as before. The mapping happens when a page is drawn, so old clicks are covered too and nothing in the database changes. Data: the community list of the Matomo project (CC0, `src/data/sources.json`, rebuilt with `npm run update-sources`) plus our own additions (`src/data/sources-own.json`); see `NOTICE`. snar does not fetch anything at runtime.

### Changed
- The README is now in English and corrected where it was out of date (PNG timing, two sentences without punctuation). `CONTRIBUTING.md` describes the test suite and the CLA.
- `.gitignore` excludes only the top-level `data/` directory (it also matched `src/data/`).
- Link lists: search and selection share one toolbar row; the three QR formats sit in one menu "QR-Codes herunterladen" (SVG, EPS, PNG) next to "Liste (CSV)"; the select-all box moved into the table header. QR code generator: "Erzeugen" sits in the card like "Erstellen" and stays disabled until the field the active tab needs is filled; the empty preview text is centred.
- CI also syntax-checks `scripts/*.js`; three exports nobody imported (`BOT_UA_RE`, `splitList`, `GROUP_LABELS`) are gone.
- PNG QR codes are written by `src/png.js` straight from the code's modules as a 1-bit palette image instead of through the qrcode library's RGBA renderer: about 1 ms instead of ~170 ms per 1024 px code in the container, and files of about 1 KB instead of several. Same size, colours and transparent background as before. This is what allows 1000 PNGs per bulk download instead of 30.
- The Docker image and CI use Node 24 (LTS) instead of Node 22.
- The shared vault and the personal vault show flash messages (needed for the bulk download errors).

### Security
- Every request that changes something (anything but GET, HEAD and OPTIONS) must now come from this site: the server checks `Sec-Fetch-Site` or `Origin` itself (`src/url-rules.js`), instead of relying only on the `SameSite=Strict` cookie. A page on a sibling subdomain or another port of the same host counts as same-site for that cookie, and an old browser may ignore it. `X-Forwarded-Host` is only believed from a trusted proxy.
- At most four password checks run at the same time (a further login is answered with 429 "Der Server ist gerade ausgelastet"). The per-IP login limit can be dodged with a spoofed `X-Forwarded-For` when the connection comes from a trusted private address (for example Docker Desktop); the cap keeps such attempts from using up the CPU with scrypt. README: the proxy must replace, not append, `X-Forwarded-For`.
- New target URLs may not contain control characters (CR, LF, tab: the URL parser dropped them silently, so the stored value differed from the checked one) and not a user name or password before the `@` (`https://paypal.com@evil.example/`). A link that already has such a URL can still have its title or expiry edited as long as the URL itself stays unchanged.
- The referrer host stored with a click is cut off at 253 characters (anyone can send any `Referer` to a short link); longer values count as no referrer.
- Ids in addresses and forms must be plain decimal numbers: `073`, `0x49` or a leading space no longer open link 73 under `/app/links/...`.
- SSO without `OIDC_ALLOWED_GROUPS` or `OIDC_ALLOWED_EMAIL_DOMAINS` logs a warning at start, and the README says plainly that everyone the identity provider signs in becomes a member.
- `proxy-addr` 2.0.7 to 2.0.8 (transitive dependency of Express), fixing GHSA-jqcg-44mw-7w3h: an IPv6 trust subnet with zero leading bits, for example a mistyped `::ffff:10.0.0.0/8` in `TRUSTED_PROXIES`, matched every IPv4 address and let clients choose their own `req.ip` through `X-Forwarded-For`. The built-in ranges (`loopback`, `linklocal`, `uniquelocal`) were not affected, but a custom `TRUSTED_PROXIES` entry could be.

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

[Unreleased]: https://github.com/chris-kretschmer/snar/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/chris-kretschmer/snar/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/chris-kretschmer/snar/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/chris-kretschmer/snar/releases/tag/v1.0.0
