# Security policy

snar holds logins and sends visitors to addresses people typed in, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting: on the repository page open **Security**, then **Report a vulnerability**
(<https://github.com/chris-kretschmer/snar/security/advisories/new>). Only the maintainer can see the report.

Helpful in a report: the version (the image tag, or `version` in `package.json`), how you run snar (Docker or
Node, behind which proxy), the steps to reproduce, and what an attacker gains. A short proof of concept is welcome.

## What to expect

snar is maintained by one person in their spare time. The aim is:

- an answer within **7 days** (that the report arrived and whether it looks valid),
- a fix or a clear plan within **30 days** for a confirmed vulnerability, faster for a serious one,
- a coordinated release: the fix ships first, then the advisory is published and you are credited (if you wish).

If you do not hear back within 7 days, please nudge the report.

## Supported versions

Only the **latest release** gets security fixes. Upgrade notes are in [CHANGELOG.md](CHANGELOG.md). Going back to an
older release is not supported after a schema migration, so stay on the current one.

## What is in scope

- The snar application in this repository: authentication and sessions, access to links and statistics, the
  redirect, QR code and download endpoints, SSO login, the admin pages, and the Docker image built from this repository.
- Dependencies, when a known vulnerability in one of them is reachable in snar (`npm audit` runs in CI).

## What is not

- A deployment that ignores the hardening notes in the README: no HTTPS in front of snar, `BIND_ADDRESS=0.0.0.0` on
  the open internet without a proxy, a weak admin password, a proxy that passes `X-Forwarded-For` through unchecked.
- Anything that needs an already logged-in administrator to attack their own instance.
- Denial of service by sheer volume of traffic, and reports from automated scanners without a concrete impact.
- Social engineering, and short links that point to a harmful address: members decide where their links go, that is
  a question of who gets an account, not a bug.

## Hardening you can rely on

The README lists the settings that matter for a public installation (reverse proxy with HTTPS, `SESSION_SECRET`,
`COOKIE_SECURE`, SSO access rules, backups). The application sends a strict Content Security Policy, checks the origin
of every request that changes something, stores passwords with scrypt, limits login attempts, keeps no IP addresses and
runs in the Docker image as an unprivileged user on a read-only file system.
