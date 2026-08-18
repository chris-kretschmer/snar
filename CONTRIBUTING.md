# Contributing to snar

Thanks for considering a contribution. snar is maintained by one person in their spare time, so please bear with me if a review takes a while — but pull requests, bug reports, and questions are genuinely welcome.

Some parts of this project were built with AI assistance (Claude Code), reviewed and tested throughout.

## Before you start on something bigger

For a small fix (typo, obvious bug, docs) — just open a PR. For anything that touches architecture, adds a dependency, or changes existing behavior, please open an issue first to discuss the approach before investing time in an implementation. That avoids a finished PR getting rejected over a design disagreement.

## Local setup

With Docker:

```bash
cp .env.example .env   # then fill in ADMIN_PASSWORD & co.
docker compose up -d --build
```

Without Docker:

```bash
npm install
ADMIN_PASSWORD=examplePassword123 BASE_URL=http://localhost:3000 node src/server.js
```

See the [README](README.md) for the full list of environment variables.

## Before opening a PR

There's no full automated test suite yet (see "Testing" below if you'd like to help with that) — please run these manually:

1. `node --check src/*.js` — catches syntax errors.
2. Start the app (see above) and actually click through the part of the UI you touched. If your change is server-side only, a `curl` round-trip is fine.
3. The CI workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) additionally runs a syntax check and a boot smoke test (`/healthz`) on every PR automatically, regardless of which files changed.

## Testing

Right now, verification is manual (see above) plus the CI boot smoke test — there's no unit/integration test suite. If you want to contribute one, that would be a genuinely valuable PR; happy to discuss the approach in an issue first.

## Code style

- **Comments explain the WHY, not the WHAT.** Only add one when something is non-obvious — a browser quirk, a security tradeoff, a subtle edge case. Don't restate what the code already says.
- **Comments are in English**, even though the UI and README are in German — snar's audience is German-speaking self-hosters, but the source should be readable by anyone.
- **UI text and user-facing strings are currently German-only.** Internationalization is something we'd like to tackle — see "Translations" below if you're interested in helping.
- No framework, no build step, no client-side JS beyond `public/app.js` — that's intentional, please don't introduce one as part of an unrelated change.
- Match the existing formatting (no linter/formatter is configured — just follow what's around your change).

## Translations

The UI is German-only today, and turning that into a proper multi-language setup (starting with English) is something we'd genuinely like to prioritize — contributions here are very welcome. Since this touches how every user-facing string in `views.js` is structured (moving from hardcoded German text to a translation-file setup), please open an issue first so we can agree on the approach before diving into the implementation. That way the actual coding effort doesn't go to waste over a design disagreement.

**Leaning direction, open to discussion:** JSON files per language (`locales/de.json`, `locales/en.json`) with a small custom `t(key, vars)` lookup helper — no new dependency, consistent with snar's "no framework" approach. Many strings aren't static (they're built from variables, e.g. `"${target.username}" gelöscht, Links wurden an ${you} übertragen.`), so `t()` needs `{{placeholder}}`-style interpolation, e.g. `t('user.deleted', { username, recipient })` looking up `"user.deleted": "\"{{username}}\" deleted, links transferred to {{recipient}}."`. A library like i18next would offer more (pluralization, formatting) but pulls in a real dependency — worth weighing in the issue discussion rather than assuming either way.

## Reporting bugs

Please open a GitHub issue with steps to reproduce, what you expected, and what actually happened. For self-hosting/deployment problems, include how you're running snar (Docker/bare Node) and relevant log output.

## Conduct

Be respectful. Disagreements about code and design are fine and expected — personal attacks, harassment, or bad-faith arguing are not, and will get a thread closed.

## License

By contributing, you agree that your contribution is licensed under the project's [AGPL-3.0-or-later](LICENSE) license, same as the rest of the codebase.
