// Optional "new version available" hint for admins (box at the bottom of the sidebar).
//
// Asks the GitHub Releases API for the latest release of the project every few hours and
// keeps the result in memory: no cookies, no accounts, nothing about the instance is sent
// (only the usual request headers, User-Agent "snar/<version>"). Failures are silent, the
// hint just stays as it was. Switch it off with UPDATE_CHECK=off (README).

const DEFAULT_REPO = 'chris-kretschmer/snar';
const FIRST_CHECK_MS = 30 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

// "v1.2.3" or "1.2.3" -> [1, 2, 3]; anything else (pre-releases, junk) -> null
function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value == null ? '' : value).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// onUpdate receives { version, url } when a newer release exists, otherwise null.
// apiUrl / fetchFn exist for tests and forks; by default the public GitHub API is used.
function startUpdateCheck({ current, repo, apiUrl, onUpdate, fetchFn = fetch }) {
  const repoName = repo || DEFAULT_REPO;
  const url = apiUrl || `https://api.github.com/repos/${repoName}/releases/latest`;
  const urlPrefix = apiUrl ? 'http' : `https://github.com/${repoName}/`;

  async function check() {
    try {
      const res = await fetchFn(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `snar/${current}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return; // e.g. 404 while no release exists yet
      const data = await res.json();
      const version = String(data.tag_name || '').replace(/^v/, '');
      const releaseUrl = String(data.html_url || '');
      if (!parseVersion(version) || !releaseUrl.startsWith(urlPrefix)) return;
      onUpdate(isNewer(version, current) ? { version, url: releaseUrl } : null);
    } catch { /* offline, timeout, rate limit, bad JSON: keep the last known state */ }
  }

  const first = setTimeout(check, FIRST_CHECK_MS);
  const repeat = setInterval(check, INTERVAL_MS);
  first.unref();
  repeat.unref();
  return { checkNow: check, stop() { clearTimeout(first); clearInterval(repeat); } };
}

module.exports = { startUpdateCheck, isNewer, parseVersion };
