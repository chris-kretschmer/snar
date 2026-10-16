// Small rules about request input (ids, URLs, referrers, origins), kept free of Express so they can be tested.

// An id from a path or a form: plain decimal digits only. Number() alone would also accept "073", "0x49", "1e1" or
// " 73" and map them onto a real id, so one link would answer under several addresses. Returns 0 (no such id) otherwise.
function parseId(value) {
  const s = String(value ?? '');
  if (!/^[1-9][0-9]{0,15}$/.test(s)) return 0;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : 0;
}

function isHttpUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch { return false; }
}

const hasControlChar = (s) => [...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

// A new target URL for a link. Returns a message for the form, or null when the URL is fine.
// - http(s) only (javascript:, data: and the like are refused).
// - No control characters (tab, CR, LF ...): the URL parser silently drops them, so such a value would be stored
//   differently from what was checked.
// - No user name or password before the "@": "https://paypal.com@evil.example/" shows a trusted name and goes
//   somewhere else, the classic disguise for phishing links.
function targetUrlError(u) {
  const value = String(u ?? '');
  if (hasControlChar(value)) return 'Die URL enthält Steuerzeichen (Zeilenumbruch, Tabulator).';
  let parsed;
  try { parsed = new URL(value); } catch { return 'Bitte eine gültige http(s)-URL angeben.'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Bitte eine gültige http(s)-URL angeben.';
  if (parsed.username || parsed.password) return 'Adressen mit Benutzername oder Passwort vor dem @ sind nicht erlaubt.';
  return null;
}

// Host name of a Referer header, as stored with a click. Anyone can send any Referer to a public short link, so
// it is cut off at the longest possible host name (253 characters); longer values count as "no referrer".
const MAX_HOST_LENGTH = 253;
function refHost(referrer = '') {
  try {
    const host = new URL(referrer).hostname;
    return host.length <= MAX_HOST_LENGTH ? host : '';
  } catch { return ''; }
}

// Cross-site form posts: browsers send Sec-Fetch-Site; older ones only Origin. No header at all means no browser form
// post from another site (curl, scripts). `host` is the host (with port) this server is reached under.
function isSameOriginRequest({ secFetchSite, origin, host }) {
  if (secFetchSite) return secFetchSite === 'same-origin' || secFetchSite === 'none';
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

module.exports = { parseId, isHttpUrl, targetUrlError, refHost, isSameOriginRequest, MAX_HOST_LENGTH };
