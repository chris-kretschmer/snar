# snar: short links and QR codes, self-hosted

[![CI](https://github.com/chris-kretschmer/snar/actions/workflows/ci.yml/badge.svg)](https://github.com/chris-kretschmer/snar/actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

snar is a self-hosted short link tool with dynamic QR codes. Every link gets a QR code that encodes only the short URL: print it once, and change the real destination as often as you like without reprinting. It also has user management: everyone has their own private links, and everything with the visibility "Organisation" lands in the **shared vault**, a QR gallery the whole team can see and edit. On top of that there is a static QR code generator (also for Wi-Fi credentials and SEPA payments) and click statistics per link. No external services, and no cookies for people who open the short links.

> **The user interface is currently German only.** An English interface is planned (see [CONTRIBUTING.md](CONTRIBUTING.md#translations)). This README names the German labels where they matter, for example "Gemeinsamer Tresor" (shared vault) and "Persönlicher Tresor" (personal vault).

## Features

- **Short links**: a random slug (56-character alphabet without look-alike characters such as `0`/`O`/`o` or `1`/`I`/`l`) or a slug of your own, a title for the internal overview, and a destination you can change at any time. A few words (`app`, `login`, `logout`, `static`, `healthz`) are reserved.
- **Campaign parameters (UTM)**: under "Erweiterte Link-Details" (advanced link details) you can enter `utm_source`, `utm_medium`, `utm_campaign`, `utm_term` and `utm_content` separately. snar appends them to the destination URL when you save and shows the address that is really opened below the URL field. A tool such as Matomo on the destination site can then evaluate them.
- **Dynamic QR codes**: as SVG, EPS (vector, for print shops and layout programs) or PNG up to 2048 px. The redirect is a `302` with `Cache-Control: no-store`. New QR codes contain the short link with the marker `?q` (`https://short.example/abc?q`): the redirect ignores it, but the statistics count the visit as "QR-Scan" instead of "Direkt" (direct). Codes printed before do not contain it and keep counting as "Direkt / unbekannt".
- **Bulk download**: in the dashboard and in both vaults you can tick links with a checkbox ("select all" acts on the rows the search currently leaves). You can download the QR codes as a ZIP (SVG, EPS or 1024 px PNG, each up to 1000 links) or the list as CSV for Excel (up to 2000). The same visibility rules apply as for single links; private links of others are skipped.
- **Static QR code generator**: four kinds of input: URL, free text, Wi-Fi credentials, SEPA transfer (GiroCode). Your own foreground and background colour, also transparent. Nothing is **stored**, and everything goes through POST so the content never ends up in the address bar, the browser history or access logs.
- **Statistics per link**: key figures (total clicks, today, last 7/30 days, average per day, last click), a click chart for today / 7 days / 30 days / 12 months / all time or a custom range (usable by keyboard), visitors (the source as a platform, for example "Instagram" instead of `l.instagram.com`, otherwise just the host name; device type, browser, language; with a "Weitere" dialog from five entries) and the latest clicks to page through. Deliberately frugal with data: no IP addresses are stored, no fingerprinting.
- **User management**: roles admin and member. Admins create accounts (start password, changed under "Konto") and delete them; the links of a deleted account are handed to another person, nothing is lost. The last admin and your own account are protected against deletion. Passwords are hashed with scrypt.
- **Visibility per link**: "Persönlich" (personal: owner and admins only) or "Organisation": organisation links belong to the whole team, appear in the shared vault, and every signed-in member may edit them and see the full click statistics. "Erstellt von" (created by) is informational only and restricts nothing. Deleting and changing the visibility stay with the owner and admins.
- **Appearance**: under "Admin-Einstellungen → Darstellung" admins set the instance name (sidebar, sign-in page, tab title) and the accent colour (links, active navigation, hover, focus rings, charts) for all users. With live preview; the colour must reach a contrast of at least 4.5:1 on white, and "Auf Standard zurücksetzen" restores the original.
- **Domain management**: short domains are managed in the app (`/app/domains`, admins only), not in the configuration. Adding or removing takes effect immediately, no restart needed. The first one in the list is the default for new links. Removing a domain switches the affected links to another domain, so no printed QR code breaks.
- **Authentication**: signed HttpOnly sessions (30 days, invalid at once when the user is deleted or the password changes; a password change signs out all other devices and keeps the current one), login rate limit. Optional **SSO via OIDC** (for example Authentik) as an additional way to sign in. The first successful SSO login creates a "Mitglied" (member) account; admin rights can still only be given by hand.
- **One container, one SQLite file** (`/data/snar.db`, WAL mode). See "Good to know" for the safe backup command.

## Requirements

- **With Docker** (recommended): Docker and the Docker Compose plugin.
- **Without Docker**: Node.js `^20.19` or `>=22.12`.

## Quick start (Docker)

```bash
cp .env.example .env   # then fill in ADMIN_PASSWORD and the rest
docker compose pull    # the ready-made image (from release 2.1.0 on)
docker compose up -d
```

Or build the image from this folder instead of pulling it: `docker compose up -d --build`. To stay on a fixed release, set `SNAR_VERSION=2.1.0` in `.env`. The image is built for amd64 and arm64 and published as `ghcr.io/chris-kretschmer/snar`.

`compose.yaml` reads the credentials from a local `.env` file (not in the repository, see `.gitignore`). **Never put real passwords directly into `compose.yaml`**, they would end up in version control. Without `ADMIN_PASSWORD` the first start deliberately stops with an error (afterwards you can remove it from `.env`) instead of starting with a default password.

Values in `.env`:

| Variable | Meaning |
|---|---|
| `ADMIN_USER` / `ADMIN_PASSWORD` | Create the first admin account **on the very first start only** (default name `admin`, password at least 8 characters). After that everything runs through the user management in the app |
| `BASE_URL` / `DOMAINS` | Set the initial short domain(s) **on the very first start only** (`DOMAINS` comma-separated for several, for example `https://a.tld,https://b.tld`). **It ends up in the QR codes**, so choose a domain that stays. Afterwards manage them under "Domains" (`/app/domains`); these variables are then ignored |
| `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | Optional, turns on SSO login through an OIDC provider (for example Authentik). Only active when all three are set. Register the redirect URI with the provider: `<first configured domain>/login/sso/callback` |
| `BIND_ADDRESS` | Default `127.0.0.1`: the port is reachable from this machine only, because snar has no TLS of its own. Put a reverse proxy with HTTPS in front (see "Good to know"). `0.0.0.0` publishes the port on all interfaces, for example for a test in your LAN |
| `SESSION_SECRET` | Optional, at least 32 random characters. Keeps the secret for the session cookies out of the database and its backups. Without it snar stores it in the database. After restoring a backup on another system, set a new one |
| `COOKIE_SECURE` | Default `auto` (Secure flag only when HTTPS is detected). `always` forces it when TLS ends at a proxy that snar does not trust |
| `CLICK_RETENTION_DAYS` | Optional: deletes clicks older than this many days (daily). `0` or empty keeps everything. The statistics ("Gesamt", totals) then cover only the kept period |
| `OIDC_ALLOWED_GROUPS` / `OIDC_ALLOWED_EMAIL_DOMAINS` | Optional: only these SSO users may sign in (either rule is enough). Groups comma-separated, matched against the `groups` claim (the provider must send it); e-mail domains count only with `email_verified`. Checked at every sign-in, also for existing accounts. **Without one of these rules everyone the provider authenticates may sign in**, becomes a member and sees the shared vault; snar warns about this at start |
| `UPDATE_CHECK` | Default `on`: admins see a hint at the bottom of the sidebar when a newer version exists. For that the server asks the GitHub releases API every few hours (no identifier, only `User-Agent: snar/<version>`). `off` turns the request off completely. For forks and tests there are `UPDATE_REPO` (repository `owner/name`) and `UPDATE_API_URL` (another API address) |
| `TZ` | Time zone for the statistics charts (for example `Europe/Berlin`): decides where day and hour boundaries fall. Times are always stored as UTC |
| `PORT` | Default `3000` |
| `DATA_DIR` | Default `/data` (volume) |

Then open `http://localhost:3000` (on the server itself, or through the reverse proxy), sign in and create links. For monitoring and reverse proxy health checks there is `GET /healthz`.

## Without Docker

For bare metal or your own init system. Otherwise the Docker way above is the easier default.

```bash
npm install
ADMIN_PASSWORD=choose-a-long-one BASE_URL=https://example.com node src/server.js
```

## Resource use

Measured: about 66 MB RSS idle, about 110 MB under constant load, no CPU when idle. A redirect costs 1 to 2 ms of CPU. The most expensive operation is a bulk download: on half a CPU, 1000 QR codes as a ZIP take about 1.3 to 1.6 s for SVG or EPS and about 3.4 s for PNG, and the server keeps answering meanwhile. A single code takes a few milliseconds. `compose.yaml` sets `cpus: 0.5` as a safety net and a log rotation (`max-size: 10m`, `max-file: 3`) so Docker's own logs do not grow without limit over years of running. The image is built in stages (the build toolchain for `better-sqlite3` stays entirely in the builder stage), so the runtime image stays slim.

## Good to know

- **Never change the short domain** once QR codes are printed: the URL is fixed inside the printed code. Only the *destination* is dynamic.
- **Reverse proxy**: by default `trust proxy` trusts loopback and private or link-local addresses (`127.0.0.1`, Docker bridge networks such as `172.16.0.0/12`, `10.0.0.0/8`, `192.168.0.0/16`, ...). That covers running [without Docker](#without-docker) (a proxy on the same host) as well as the typical Docker setup in which a reverse proxy runs as its own container in the same Compose network. Without this detection the `Secure` cookie flag would stay off although the proxy terminates TLS. Only if the proxy delivers traffic from a public address (for example a Cloudflare Tunnel or an external load balancer), also set `TRUSTED_PROXIES` to the concrete IPs or CIDRs (comma-separated). The proxy must **replace** `X-Forwarded-For`, not append to it: snar trusts the header from these addresses, and a value sent by the client would otherwise count as the IP. Under Docker Desktop (Windows and macOS) every client appears with the address of the Docker gateway (private, so trusted): then a forged header works too, and the login brake per IP does not protect reliably. What remains is the limit per user name and a cap of four password checks at the same time.

  **HTTPS is a must:** snar has no TLS of its own, so sign-in and session cookie would travel unencrypted. That is why the port is published on `127.0.0.1` only by default (`BIND_ADDRESS`); the proxy reaches it there or through the Compose network. The proxy has to set `X-Forwarded-For` and `X-Forwarded-Proto` itself (overwriting values sent by the client). When HTTPS is detected snar sends `Strict-Transport-Security` and sets the `Secure` flag. Published Docker ports bypass `ufw` and `firewalld`: do not set `0.0.0.0` when there is no proxy in front.
- **Backup**: the SQLite file runs in WAL mode. A plain `cp` or a file-level snapshot of the Docker volume can catch an inconsistent moment (main file and WAL file out of step), which looks fine while you back up and only shows when you restore. The runtime image has no `sqlite3` command line tool, but it has the online backup API built into `better-sqlite3`, which is safe against the running database:
  ```bash
  docker exec snar node -e "require('better-sqlite3')('/data/snar.db',{readonly:true}).backup('/data/backup-'+new Date().toISOString().slice(0,10)+'.db')"
  ```
  Then copy the resulting `backup-*.db` out of the volume regularly (for example with `docker cp`) and keep it elsewhere. Schedule, retention and off-site storage are deliberately not part of snar: they depend too much on your infrastructure (cron, Portainer, systemd timers, ...) and belong there.
- **Updates and the database**: changes to the database schema run as numbered migrations (`src/migrations.js`) at start, in a transaction. If the database holds data, snar first saves a backup `snar-vor-migration-v<N>-<time>.db` next to `snar.db` (you can delete old ones later). A database written by a newer version is not opened, and going back to an older version is not supported. Take a backup before every update anyway, see above. To update the ready-made image: `docker compose pull && docker compose up -d`. The release notes are in [CHANGELOG.md](CHANGELOG.md).

## Project layout

```
src/server.js      Express app: auth, CRUD, redirect, QR endpoints
src/db.js          SQLite schema, statements, password hashing, slug generation
src/migrations.js  Numbered schema migrations (with a backup before the change)
src/*.js           Small modules: click rules, login limiter, SSO access, update hint, platform names (sources.js), ZIP/CSV/EPS/PNG writers, request rules (url-rules.js)
src/data/          Lists for the platform names (sources.json from the Matomo list, CC0; our own additions in sources-own.json)
scripts/           Development helpers (`npm run update-sources` rebuilds sources.json), not in the Docker image
test/              Tests (`npm test`, Node's test runner)
src/views.js       Server-rendered HTML templates (including the SVG chart)
public/            Stylesheet and minimal client JS (dropdowns, date picker, search, copy)
Dockerfile         node:24-alpine (pinned by digest), multi-stage, unprivileged user
compose.yaml       Deployment with a volume, hardened (read-only, no capabilities), limits, log rotation
```

## Contributing

Bugs, questions, pull requests: see [CONTRIBUTING.md](CONTRIBUTING.md). Contributions come with a [Contributor License Agreement](CLA.md). Please report security problems privately, see [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0-or-later](LICENSE): anyone who offers a modified version over a network (also as SaaS) must make the source code of that version available under the AGPL as well.

Third-party data: the mapping of host names to platforms uses the list of the Matomo project ([searchengine-and-social-list](https://github.com/matomo-org/searchengine-and-social-list), CC0 1.0). Details are in [NOTICE](NOTICE).
