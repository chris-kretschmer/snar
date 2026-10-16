// Which platform a click came from: turns the referrer host names snar stores ("l.instagram.com", "t.co", "youtu.be")
// into names people read ("Instagram", "X", "YouTube"). The data is Matomo's community list of social networks, search
// engines and AI assistants (CC0, src/data/sources.json, rebuilt with scripts/update-sources.js) plus a few hand-kept
// additions (src/data/sources-own.json). It runs when a page is drawn, never when a click is stored, so the stored
// data stays raw and an improved list helps old clicks too.
const list = require('./data/sources.json');
const own = require('./data/sources-own.json');

const GROUP_LABELS = { social: 'Soziale Netze', search: 'Suche', ai: 'KI-Assistenten', email: 'E-Mail', messenger: 'Messenger', qr: 'QR-Code' };

// "Google Images" -> "Google" (a family name), then the rename table ("Twitter" -> "X").
function displayName(name) {
  const family = own.families.find((f) => name === f || name.startsWith(`${f} `));
  const base = family || name;
  return own.rename[base] || base;
}

// "{}" stands for a country code: in the last label also for combined endings (google.co.uk), elsewhere for two letters.
const COUNTRY = '[a-z]{2}';
const COUNTRY_TLD = `(?:${COUNTRY}|(?:com|org|net|co|it|edu)\\.${COUNTRY})`;
function patternToRegExp(pattern) {
  const parts = pattern.split('{}').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const last = pattern.endsWith('.{}') ? parts.length - 2 : -1;
  return new RegExp(`^${parts.map((p, i) => (i === parts.length - 1 ? p : p + (i === last ? COUNTRY_TLD : COUNTRY))).join('')}$`);
}

// Later sets win over earlier ones: search < social < AI < our own additions, for the rare host in two lists.
const exact = new Map();
const patterns = [];
function add(group, name, entries) {
  const value = { name: displayName(name), group };
  for (const e of entries) {
    if (e.includes('{}')) patterns.push({ re: patternToRegExp(e), ...value });
    else exact.set(e, value);
  }
}
for (const group of ['search', 'social', 'ai']) {
  for (const [name, entries] of Object.entries(list[group])) add(group, name, entries);
}
for (const s of own.sources) add(s.group, s.name, s.hosts);

// host: as stored in clicks.referrer. Returns { name, group, label } or null for an unknown or empty host.
// Looks at the host itself first, then its parent domains (l.instagram.com -> instagram.com), so the most
// specific entry wins (gemini.google.com is Gemini, not Google). "instagram.com.evil.example" is not Instagram.
function platformOf(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!h || h.length > 253) return null;
  const labels = h.split('.');
  for (let i = 0; i < labels.length; i++) {
    if (i > 0 && labels.length - i < 2) break; // never a bare ending like "com"
    const candidate = labels.slice(i).join('.');
    const hit = exact.get(candidate) || patterns.find((p) => p.re.test(candidate));
    if (hit) return { name: hit.name, group: hit.group, label: GROUP_LABELS[hit.group] };
  }
  return null;
}

// What the "Quelle" list shows for a click without a platform. A scan of a QR code made with the "?q" marker is its own
// source; a visit with no referrer is "Direkt / unbekannt" (typed, bookmark, app that sends none, or a QR code printed
// before the marker existed).
const QR_SCAN = 'QR-Scan';
const DIRECT = 'Direkt / unbekannt';
const QR_HINT = 'Aufruf über einen QR-Code, der mit dem Kennzeichen ?q erzeugt wurde';
const DIRECT_HINT = 'Kein Referrer: getippt, Lesezeichen, eine App ohne Herkunftsangabe oder ein vor dem QR-Scan-Zähler gedruckter QR-Code';

// Rows as the "Quelle" query returns them ({ referrer: host or '', channel: 'qr' or '', n }) -> one row per source,
// biggest first. Unknown hosts stay as they are (without a leading "www."). `hosts` lists what was folded together
// into a platform and `hint` is the tooltip text for the row.
function groupReferrers(rows) {
  const byName = new Map();
  for (const r of rows) {
    const host = String(r.referrer || '');
    const hit = r.channel === 'qr' ? null : platformOf(host);
    let name, group = null, hint = '';
    if (r.channel === 'qr') { name = QR_SCAN; group = 'qr'; hint = QR_HINT; }
    else if (!host) { name = DIRECT; hint = DIRECT_HINT; }
    else if (hit) { name = hit.name; group = hit.group; }
    else name = host.replace(/^www\./i, '');
    const entry = byName.get(name) || { ref: name, n: 0, group, hosts: [], hint };
    entry.n += r.n;
    if (hit && !entry.hosts.includes(host)) { entry.hosts.push(host); entry.hint = entry.hosts.join(', '); }
    byName.set(name, entry);
  }
  return [...byName.values()].sort((a, b) => b.n - a.n || a.ref.localeCompare(b.ref, 'de'));
}

module.exports = { platformOf, groupReferrers, QR_SCAN, DIRECT, DIRECT_HINT, QR_HINT };
