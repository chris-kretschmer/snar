const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const path = require('path');
const dns = require('dns');
const net = require('net');
const QRCode = require('qrcode');
// ESM-only package – as of Node 20.19/22.12, require() can load ESM
// directly (see package.json "engines"), no dynamic import() needed.
const oidc = require('openid-client');

const { stmts, createLink, getSessionSecret, hashPassword, verifyPassword, bootstrapAdmin, provisionSsoUser, seedDomainsIfEmpty } = require('./db');
const views = require('./views');
const { isExpired } = views;

const PORT = Number(process.env.PORT || 3000);

// Same rule as when creating an account via /app/users – applies to the bootstrap too.
const USERNAME_RE = /^[A-Za-z0-9\-_.]{2,32}$/;

// On the very first start, an admin account is created from the env
// variables. After that, user management runs entirely inside the app.
if (stmts.countUsers.get().n === 0) {
  const pw = process.env.ADMIN_PASSWORD;
  const name = (process.env.ADMIN_USER || 'admin').trim();
  if (!pw || pw.length < 8) {
    console.error('Erster Start: Bitte ADMIN_PASSWORD (mind. 8 Zeichen, optional ADMIN_USER) setzen, um das erste Admin-Konto anzulegen.');
    process.exit(1);
  }
  if (!USERNAME_RE.test(name)) {
    console.error('Erster Start: ADMIN_USER ungültig (2–32 Zeichen, a–z, 0–9, -_.).');
    process.exit(1);
  }
  bootstrapAdmin({ username: name, password: pw });
  console.log(`Admin-Konto "${name}" angelegt. Passwort nach dem ersten Login unter /app/account ändern.`);
}

// DOMAINS/BASE_URL only take effect on the very first start as the initial
// domain list (like ADMIN_PASSWORD) – after that, everything runs via /app/domains.
seedDomainsIfEmpty(
  (process.env.DOMAINS || process.env.BASE_URL || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
);

const SECRET = getSessionSecret();
const RESERVED = new Set(['app', 'login', 'logout', 'static', 'favicon.ico', 'robots.txt', 'healthz']);

// Random per-process value, not a secret (never guards anything, just an
// identifier) – lets the "Domain testen"-check (POST .../check-reachability
// below) tell "some server answered on this domain" apart from "this
// specific snar instance answered on this domain", e.g. a parked domain or
// unrelated website would otherwise look reachable.
const INSTANCE_TOKEN = crypto.randomBytes(16).toString('hex');

// Well-formed "salt:hash" so verifyPassword() always runs the real (slow)
// scrypt computation, even for a username that doesn't exist – otherwise
// POST /login returns near-instantly for unknown usernames but only after
// scrypt for known ones, letting an attacker enumerate valid usernames purely
// from response timing despite the identical error message.
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function getDomains() {
  return stmts.listDomainOrigins.all().map(d => d.origin);
}

// ---------------------------------------------------------------------------
// SSO (OIDC, e.g. Authentik) – an additional login path alongside username/
// password, not a replacement. Active as soon as all three variables are
// set, making a separate enable flag unnecessary. Discovery runs lazily on
// the first login attempt rather than at server startup, so a briefly
// unreachable identity provider doesn't block the whole snar startup.
// ---------------------------------------------------------------------------
const OIDC_ENABLED = !!(process.env.OIDC_ISSUER_URL && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET);
let oidcConfigPromise = null;
function getOidcConfig() {
  if (!oidcConfigPromise) {
    oidcConfigPromise = oidc.discovery(
      new URL(process.env.OIDC_ISSUER_URL), process.env.OIDC_CLIENT_ID, process.env.OIDC_CLIENT_SECRET
    ).catch((e) => { oidcConfigPromise = null; throw e; }); // don't cache a failure permanently, the next attempt tries again
  }
  return oidcConfigPromise;
}

// Pin links without an explicit domain (legacy data or single-domain setups)
// to the first configured domain, so the display never has to show an empty
// domain.
{
  const domains = getDomains();
  if (domains.length) stmts.backfillDomain.run(domains[0]);
}

function normalizeDomain(input) {
  const domains = getDomains();
  return domains.includes(input) ? input : (domains[0] || '');
}

const app = express();
app.disable('x-powered-by');
// 'loopback' instead of true: only trusts X-Forwarded-* headers from a
// proxy connecting via true loopback (127.0.0.1). A reverse proxy reaching
// this container through the published Docker port (whether running
// natively on the host or as another container) arrives as the Docker
// bridge gateway IP instead (e.g. 172.17.0.1), not loopback – in that case
// this setting must be changed to that concrete IP/CIDR (see README,
// "Reverse Proxy"), or requests won't be trusted at all. "true" would let
// ANY client freely spoof req.ip via a self-set X-Forwarded-For header –
// that made the IP-based login rate limiter below trivial to bypass (every
// attempt = a new "IP" = a new counter) – so never fall back to a blanket
// "true" to work around this.
app.set('trust proxy', 'loopback');
// Security headers (pentest recommendation). style-src allows
// 'unsafe-inline' because views.js uses style="..." attributes in many
// places for small layout details (no <script> equivalent, can't execute
// JS) – script-src, by contrast, stays strictly 'self': the only <script>
// tag in the entire output is the external app.js include, no inline JS
// anywhere. img-src additionally allows data: because style.css uses the
// dropdown-arrow icon as an embedded data:image/svg+xml (no external
// request, no meaningful risk).
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(compression());
app.use(express.urlencoded({ extended: false }));
// Long maxAge + immutable: CSS_URL/APP_JS_URL (and, via CSS_CONTENT, the
// font URL referenced in the CSS too) already carry a content hash in the
// query string (?v=...) – if a file changes, the URL changes, and the
// browser is forced to reload. The old URL forever stays exactly the same
// content, so it can safely be cached without limit.
const STATIC_CACHE = { maxAge: '1y', immutable: true };
// Dedicated route instead of express.static: serves CSS_CONTENT (font
// placeholder already replaced with the real hash, see views.js) instead of
// the raw file.
app.get('/static/style.css', (req, res) => {
  res.type('text/css').set('Cache-Control', 'public, max-age=31536000, immutable').send(views.CSS_CONTENT);
});
app.use('/static', express.static(path.join(__dirname, '..', 'public'), STATIC_CACHE));

// ---------------------------------------------------------------------------
// Sessions (signed cookie: contains user ID + expiry)
// ---------------------------------------------------------------------------
function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function makeSessionCookie(userId, tokenVersion) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30; // 30 days
  // token_version makes the signature password-dependent: it's incremented
  // on password change, which invalidates every previously issued cookie.
  const payload = `u.${userId}.${tokenVersion}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

// Set the cookie (login + after a password change, for the current device).
// Secure flag only over TLS (req.secure knows about the reverse proxy via trust proxy).
function setSessionCookie(res, req, user) {
  res.setHeader('Set-Cookie',
    `snar_session=${makeSessionCookie(user.id, user.token_version)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}${req.secure ? '; Secure' : ''}`);
}

// Splits "<payload>.<sig>" on the last dot and returns payload only if sig
// is a valid HMAC over it (constant-time compare) – shared by sessionUser()
// and verifyOidcState() below, which otherwise duplicated this exact
// signature-checking logic; that's the wrong place for two copies to drift.
function verifySigned(token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return payload;
}

function sessionUser(token) {
  const payload = verifySigned(token);
  if (!payload) return null;
  const [, idStr, verStr, expStr] = payload.split('.');
  if (!(Number(expStr) > Date.now())) return null; // old 3-part cookies have undefined here -> NaN -> rejected
  const user = stmts.userById.get(Number(idStr));
  if (!user || user.token_version !== Number(verStr)) return null; // deleted, or password changed since
  return user;
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Short-lived signed cookie for the OIDC round trip (the PKCE verifier +
// state + nonce need to survive between /login/sso and
// /login/sso/callback) – same HMAC principle as sign()/makeSessionCookie()
// above, just with its own content instead of user ID/expiry.
function signOidcState(payload) {
  const json = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${json}.${sign(json)}`;
}
function verifyOidcState(token) {
  const json = verifySigned(token);
  if (!json) return null;
  try { return JSON.parse(Buffer.from(json, 'base64url').toString('utf8')); } catch { return null; }
}

function requireAuth(req, res, next) {
  const user = sessionUser(getCookie(req, 'snar_session'));
  if (!user) return res.redirect('/login');
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).send('Nur für Admins.');
  next();
}

// Simple login rate limit (in-memory, per key). Only counts FAILED
// attempts – otherwise multiple users behind the same NAT would lock each
// other out even though nobody is guessing a password. The key is either
// "ip:..." or "user:..." (see POST /login) – this slows an attack down both
// on IP rotation (via the username key) and on username enumeration from a
// fixed IP (via the IP key).
const loginAttempts = new Map();
function rateLimited(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() > entry.reset) { loginAttempts.delete(key); return false; }
  return entry.count >= 10;
}
function noteFailedLogin(key) {
  const now = Date.now();
  // Expired entries would otherwise only get cleaned up when the same key
  // comes back – with many (possibly spoofed) IPs the map would grow unbounded.
  if (loginAttempts.size >= 1000) {
    for (const [k, e] of loginAttempts) if (now > e.reset) loginAttempts.delete(k);
  }
  const entry = loginAttempts.get(key) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 15 * 60 * 1000; }
  entry.count++;
  loginAttempts.set(key, entry);
}

// Domain for a link: its own domain, otherwise the first configured one,
// otherwise (no domain on record) the address of the current request.
function originFor(link, req) {
  return (link && link.domain) || getDomains()[0] || `${req.protocol}://${req.get('host')}`;
}

// Which sidebar item gets marked active when the detail page is opened –
// derived from the referer, so "← Zurück" (JS, real history) and the
// sidebar highlight (server render) agree on the same origin. Without a
// matching referer (direct visit, external link), "dashboard" stays the
// unobtrusive default.
function pageFromReferer(req) {
  const ref = req.get('referer') || '';
  if (ref.includes('/app/user-vault')) return 'myvault';
  if (ref.includes('/app/org-vault')) return 'vault';
  return 'dashboard';
}

function shortUrl(link, req) {
  return `${originFor(link, req)}/${link.slug}`;
}

function parseUA(ua = '') {
  const device = /ipad|tablet/i.test(ua) ? 'Tablet'
    : /mobi|iphone|android/i.test(ua) ? 'Mobil'
    : 'Desktop';
  let browser = 'Sonstige';
  if (/edg(a|ios)?\//i.test(ua)) browser = 'Edge';
  else if (/opr\//i.test(ua)) browser = 'Opera';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome';
  else if (/safari/i.test(ua)) browser = 'Safari';
  else if (!ua) browser = '–';
  return { device, browser };
}

function refHost(referrer = '') {
  try { return new URL(referrer).hostname; } catch { return ''; }
}

function isHttpUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch { return false; }
}

// Time-range stats for the detail page's four chip views (day/week/month/
// year). Each returns a gap-free values array (no missing hours/days/
// months) plus a handful of axis labels.
// Bucketing happens in server local time (SQL side: 'localtime', see
// db.js) – the date arrays here therefore also have to compute locally
// (getDate instead of getUTCDate), or the keys and buckets would drift
// apart.
// Sparse axis labeling: only every `step`-th point plus always the last one
// – carries the real array index `i` along, so the label sits at the
// actual data-point position when rendered (not evenly spread across the
// width, which would misalign a "forced" last label with irregular spacing
// from the real last point).
function sparseLabels(dates, step, formatFn) {
  const n = dates.length;
  const out = [];
  dates.forEach((d, i) => {
    if (i % step === 0 || i === n - 1) out.push({ i, text: formatFn(d) });
  });
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');

function statsRangeHourly(linkId) {
  const rows = stmts.clicksPerHourToday.all(linkId);
  const map = new Map(rows.map(r => [Number(r.hour), r.n]));
  const values = Array.from({ length: 24 }, (_, h) => map.get(h) || 0);
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const labels = sparseLabels(hours, 3, h => String(h));
  if (labels.length) labels[labels.length - 1].text += ' Uhr'; // the real last point gets context
  // Full per-hour labeling (not thinned out) for the hover tooltip.
  const pointLabels = Array.from({ length: 24 }, (_, h) => `${pad2(h)}:00 Uhr`);
  return { label: 'heute', values, labels, pointLabels };
}

function statsRangeDaily(linkId, days) {
  // Window is day-precise: today + the (days-1) days before it
  const rows = stmts.clicksPerDay.all(linkId, `-${days - 1} days`);
  const map = new Map(rows.map(r => [r.day, r.n]));
  const dates = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d);
  }
  const values = dates.map(d => map.get(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`) || 0);
  const weekly = days <= 7;
  const labels = sparseLabels(dates, weekly ? 1 : 5,
    d => weekly ? d.toLocaleDateString('de-DE', { weekday: 'short' }) : `${d.getDate()}.`);
  // Full date per day (not thinned out) for the hover tooltip.
  const pointLabels = dates.map(d => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }));
  return { label: weekly ? 'letzte 7 Tage' : 'letzte 30 Tage', values, labels, pointLabels };
}

// label/step/formatFn are parameterized so statsRangeAll() (well over 12
// months possible) can reuse the same bucketing logic without disturbing
// "Jahr"'s fixed axis labeling (step=2, short month name only).
function statsRangeMonthly(linkId, months, { label = 'letzte 12 Monate', step = 2, formatFn } = {}) {
  // Window is month-precise: the current month + the (months-1) before it
  const rows = stmts.clicksPerMonth.all(linkId, `-${months - 1} months`);
  const map = new Map(rows.map(r => [r.month, r.n]));
  const dates = [];
  const today = new Date();
  for (let i = months - 1; i >= 0; i--) {
    dates.push(new Date(today.getFullYear(), today.getMonth() - i, 1));
  }
  const values = dates.map(d => map.get(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`) || 0);
  const labels = sparseLabels(dates, step, formatFn || (d => d.toLocaleDateString('de-DE', { month: 'short' })));
  // Full month name per month (not thinned out) for the hover tooltip.
  const pointLabels = dates.map(d => d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }));
  return { label, values, labels, pointLabels };
}

// "Gesamt": month-by-month across the entire lifetime since creation, not
// just the last 12 months. The axis step scales with the lifetime (target
// ~6 visible labels), and once the lifetime exceeds a year, every label
// also carries the year – otherwise e.g. several "Jan"s would repeat with
// no visible year change.
function statsRangeAll(linkId, createdAt) {
  const created = new Date(createdAt.replace(' ', 'T') + 'Z');
  const today = new Date();
  const months = Math.max(1, (today.getFullYear() - created.getFullYear()) * 12 + (today.getMonth() - created.getMonth()) + 1);
  const step = Math.max(1, Math.round(months / 6));
  const formatFn = months > 12
    ? d => d.toLocaleDateString('de-DE', { month: 'short', year: '2-digit' })
    : undefined;
  return statsRangeMonthly(linkId, months, { label: 'gesamte Laufzeit', step, formatFn });
}

function linkStatsRanges(linkId, createdAt) {
  const ranges = {
    tag: statsRangeHourly(linkId),
    woche: statsRangeDaily(linkId, 7),
    monat: statsRangeDaily(linkId, 30),
    jahr: statsRangeMonthly(linkId, 12),
    gesamt: statsRangeAll(linkId, createdAt),
  };
  for (const r of Object.values(ranges)) r.total = r.values.reduce((a, b) => a + b, 0);
  return ranges;
}

// Org links belong to the whole team: any logged-in member may view/edit
// them, not just the owner/admin – "Erstellt von" stays purely informational.
// Private links stay reserved for owner/admin. Changing visibility and
// deleting are scoped more narrowly, see isOwnerOrAdmin.
function canManage(user, link) {
  return user.role === 'admin' || link.owner_id === user.id || link.visibility === 'org';
}

// canManage() isn't enough for changing visibility or deleting: both stay
// reserved for owner/admin, not the whole org membership. Otherwise a
// member could lock themselves out by switching to "Persönlich"
// (canManage() only grants non-owners access as long as visibility stays
// 'org'), and deleting is irreversible (click data gone, printed QR codes
// dead instantly) and affects the whole team.
function isOwnerOrAdmin(user, link) {
  return user.role === 'admin' || link.owner_id === user.id;
}

// Expiry date: the form supplies <input type="datetime-local">
// ("2026-09-01T18:00"). With JS, the client sends its UTC offset (minutes,
// getTimezoneOffset) along as tz_offset – then the calculation uses exactly
// the browser's timezone. Without an offset (no JS), the server's local
// time is used as an approximation. Stored as UTC in the same format as
// other timestamps ('YYYY-MM-DD HH:MM:SS'), so datetime('now') in SQL
// stays directly comparable.
function parseExpiry(input, tzOffsetRaw) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(raw);
  const tzOffset = Number(String(tzOffsetRaw ?? '').trim());
  if (m && String(tzOffsetRaw ?? '').trim() !== '' && Number.isFinite(tzOffset)) {
    const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + tzOffset * 60000;
    return new Date(utcMs).toISOString().replace('T', ' ').slice(0, 19);
  }
  const d = new Date(raw);
  if (isNaN(d)) return null;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function toDatetimeLocal(dbString) {
  if (!dbString) return '';
  const d = new Date(dbString.replace(' ', 'T') + 'Z');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const normalizeEc = (ec) => (['L', 'M', 'Q', 'H'].includes(ec) ? ec : 'M');

// Errors (e.g. content exceeds QR capacity) are caught here and answered
// with 400: Express 4 doesn't catch errors from async handlers, and an
// unhandled rejection would kill the whole process. The download header is
// only set after successful generation, so an error response never gets
// downloaded as a file.
async function sendQr(res, text, { format, ec = 'M', size = 512, download = false, filename = 'qrcode', color }) {
  const level = normalizeEc(ec);
  try {
    let body, type;
    if (format === 'png') {
      const width = Math.min(Math.max(Number(size) || 512, 64), 4096);
      body = await QRCode.toBuffer(text, { errorCorrectionLevel: level, width, margin: 2, color });
      type = 'png';
    } else {
      body = await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: level, margin: 2, color });
      type = 'image/svg+xml';
    }
    if (download) res.setHeader('Content-Disposition', `attachment; filename="${filename}.${format}"`);
    res.type(type).send(body);
  } catch {
    res.status(400).send('Inhalt lässt sich nicht als QR-Code kodieren – vermutlich zu lang für die gewählte Fehlerkorrektur.');
  }
}

// QR as an SVG string (for the static generator's inline preview, so the
// content doesn't end up as an image URL with ?data=… in logs/history). The
// QR library encodes the text as paths, not as raw text in the SVG – so
// it's safe to embed directly, injection-wise.
function qrSvgString(text, ec, color) {
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: normalizeEc(ec), margin: 2, color });
}

// Only selectable in the static generator (dynamic link QR codes
// deliberately stay black/white). Falls back to black/white on an
// invalid/empty value instead of producing a broken QR code. Also allows
// 8-digit hex with alpha (#rrggbbaa), so a transparent background (see
// below) survives a repeat download via the hidden "light" value – the
// native <input type=color> itself can only supply 6-digit hex.
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
function qrColors(darkRaw, lightRaw, transparentBg) {
  return {
    dark: HEX_COLOR_RE.test(darkRaw) ? darkRaw : '#000000',
    light: transparentBg ? '#ffffff00' : (HEX_COLOR_RE.test(lightRaw) ? lightRaw : '#ffffff'),
  };
}

// Error correction is no longer manually selectable ("L/M/Q/H" isn't
// meaningful to regular users, see chat context) – instead it's automatic,
// matched to the use case: WLAN/EPC often end up printed/stuck somewhere
// and get handled, so more robust (H); URL/Text stay at the default (M).
const EC_BY_TYPE = { url: 'M', text: 'M', wlan: 'H', epc: 'H' };
const QR_TYPES = Object.keys(EC_BY_TYPE);

// Static generator: assemble content depending on the active tab
// (URL/Text/WLAN/EPC). "url"/"text" are pure passthrough text, WLAN/EPC
// build a standardized format that most scanner apps recognize
// automatically (WiFi credentials or SEPA transfer/"GiroCode").
function wifiEscape(s) {
  return String(s).replace(/([\\;,:"])/g, '\\$1');
}
function buildWlanContent({ ssid, pass, enc }) {
  const s = String(ssid || '').trim();
  if (!s) return '';
  const t = ['WPA', 'WEP', 'nopass'].includes(enc) ? enc : 'WPA';
  const pPart = t === 'nopass' ? '' : `P:${wifiEscape(pass || '')};`;
  return `WIFI:T:${t};S:${wifiEscape(s)};${pPart};`;
}
// EPC069-12 ("GiroCode"): BIC has been optional within SEPA since 2016
// (empty line allowed), trailing empty lines are stripped – the ones in the
// middle (purpose code/structured reference, unused here) have to stay as
// placeholders, otherwise the following fields would shift.
const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
function buildEpcContent({ name, iban, bic, amount, purpose }) {
  const cleanName = String(name || '').trim().slice(0, 70);
  const cleanIban = String(iban || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!cleanName || !IBAN_RE.test(cleanIban)) return '';
  const amountNum = Number(amount);
  const amountStr = Number.isFinite(amountNum) && amountNum > 0 ? `EUR${amountNum.toFixed(2)}` : '';
  const lines = [
    'BCD', '002', '1', 'SCT',
    String(bic || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 11),
    cleanName,
    cleanIban,
    amountStr,
    '', '',
    String(purpose || '').trim().slice(0, 140),
  ];
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
// Detects any URI scheme (http:, mailto:, tel: ...) at the start – if
// there isn't one, ensureScheme() automatically prepends "https://", so
// link/QR code/domain work even without a typed prefix. The input fields
// themselves still show exactly what was typed.
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
function ensureScheme(input) {
  return input && !URI_SCHEME_RE.test(input) ? `https://${input}` : input;
}
function buildQrTypeContent(req, type) {
  if (type === 'url') {
    const raw = String(req.body.url_value || '').trim();
    return raw ? ensureScheme(raw) : '';
  }
  if (type === 'wlan') return buildWlanContent({ ssid: req.body.wlan_ssid, pass: req.body.wlan_pass, enc: req.body.wlan_enc });
  if (type === 'epc') return buildEpcContent({ name: req.body.epc_name, iban: req.body.epc_iban, bic: req.body.epc_bic, amount: req.body.epc_amount, purpose: req.body.epc_purpose });
  return String(req.body.data || '').trim();
}

function flashFromQuery(req) {
  if (req.query.ok) return { type: 'ok', text: req.query.ok };
  if (req.query.err) return { type: 'error', text: req.query.err };
  return null;
}

// Redirect with a flash message (counterpart to flashFromQuery)
function flashRedirect(res, path, type, msg) {
  res.redirect(`${path}?${type}=${encodeURIComponent(msg)}`);
}

// Shared form fields for creating & editing
function readLinkFields(req) {
  const rawUrl = String(req.body.target_url || '').trim();
  return {
    targetUrl: ensureScheme(rawUrl),
    title: String(req.body.title || '').trim().slice(0, 200),
    visibility: req.body.visibility === 'org' ? 'org' : 'privat',
    domain: normalizeDomain(req.body.domain),
    expiresAt: parseExpiry(req.body.expires_at, req.body.tz_offset),
  };
}

// QR options from request parameters (format from the route, the rest from the query)
function qrOpts(req, filename) {
  return { format: req.params.format, size: req.query.size, download: 'download' in req.query, filename };
}

app.get('/login', (req, res) => {
  if (sessionUser(getCookie(req, 'snar_session'))) return res.redirect('/app');
  res.send(views.loginPage({ ssoEnabled: OIDC_ENABLED }));
});

app.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const ipKey = `ip:${req.ip}`;
  // Only real usernames get their own key – otherwise an empty field could
  // accidentally count all accounts under the same "user:" entry.
  const userKey = username ? `user:${username.toLowerCase()}` : null;
  if (rateLimited(ipKey) || (userKey && rateLimited(userKey))) {
    return res.status(429).send(views.loginPage({ error: 'Zu viele Versuche. Bitte in 15 Minuten erneut probieren.', ssoEnabled: OIDC_ENABLED }));
  }
  const user = stmts.userByName.get(username);
  const passwordOk = verifyPassword(String(req.body.password || ''), user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !passwordOk) {
    noteFailedLogin(ipKey);
    if (userKey) noteFailedLogin(userKey);
    return res.status(401).send(views.loginPage({ error: 'Nutzername oder Passwort falsch.', ssoEnabled: OIDC_ENABLED }));
  }
  loginAttempts.delete(ipKey);
  if (userKey) loginAttempts.delete(userKey);
  stmts.touchLastLogin.run(user.id);
  setSessionCookie(res, req, user);
  res.redirect('/app');
});

app.post('/logout', (req, res) => {
  // Increment token_version like on a password change – otherwise a
  // copied/stolen snar_session cookie would stay valid for up to 30 days
  // after "Abmelden", since Max-Age=0 only tells the browser to delete it,
  // without invalidating it server-side. Side effect (deliberately
  // accepted): like a password change, this logs out every device, not
  // just the current one – this session model has no mechanism to
  // invalidate a single session in isolation.
  const user = sessionUser(getCookie(req, 'snar_session'));
  if (user) stmts.bumpTokenVersion.run(user.id);
  res.setHeader('Set-Cookie', 'snar_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.redirect('/login');
});

// SSO login (OIDC Authorization Code + PKCE). redirect_uri is derived from
// the first configured domain (like originFor()), so it exactly matches
// the URI registered with the identity provider.
app.get('/login/sso', async (req, res) => {
  if (!OIDC_ENABLED) return res.status(404).send('SSO ist nicht konfiguriert.');
  try {
    const config = await getOidcConfig();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const redirectUri = `${getDomains()[0] || `${req.protocol}://${req.get('host')}`}/login/sso/callback`;
    const authUrl = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    // SameSite=Lax (not Strict): the cookie has to be sent along on
    // Authentik's redirect back to our callback URL – a top-level
    // cross-site navigation that SameSite=Strict would block.
    // redirectUri travels along so /login/sso/callback uses the exact same
    // URI for the token exchange instead of re-guessing it from the
    // incoming request (req.protocol/host could differ under a
    // misconfigured reverse proxy, or the default domain could change
    // between the two steps) – either would make the token exchange fail
    // with "redirect_uri mismatch".
    res.setHeader('Set-Cookie',
      `snar_oidc=${signOidcState({ codeVerifier, state, nonce, redirectUri })}; HttpOnly; SameSite=Lax; Path=/login/sso; Max-Age=600${req.secure ? '; Secure' : ''}`);
    res.redirect(authUrl.href);
  } catch (e) {
    // Server log only, the message shown in the browser is deliberately
    // generic – otherwise typical first-setup errors (wrong issuer URL,
    // discovery unreachable) would leave no trace to diagnose.
    console.error('SSO (/login/sso) fehlgeschlagen:', e);
    res.status(502).send(views.loginPage({ error: 'SSO-Anmeldung aktuell nicht erreichbar. Bitte später erneut versuchen.', ssoEnabled: OIDC_ENABLED }));
  }
});

app.get('/login/sso/callback', async (req, res) => {
  if (!OIDC_ENABLED) return res.status(404).send('SSO ist nicht konfiguriert.');
  const saved = verifyOidcState(getCookie(req, 'snar_oidc'));
  if (!saved) {
    return res.status(401).send(views.loginPage({ error: 'SSO-Anmeldung abgelaufen oder ungültig. Bitte erneut versuchen.', ssoEnabled: OIDC_ENABLED }));
  }
  try {
    const config = await getOidcConfig();
    // Same redirectUri as in the authorize step (see /login/sso) + the
    // incoming request's actual query (code/state) – not rebuilt from
    // req.protocol/host, see the comment there.
    const currentUrl = new URL(saved.redirectUri + req.url.slice(req.path.length));
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: saved.codeVerifier,
      expectedState: saved.state,
      expectedNonce: saved.nonce,
    });
    const claims = tokens.claims();
    if (!claims?.sub) throw new Error('SSO-Antwort ohne "sub"-Claim.');
    let user = stmts.userBySsoSubject.get(claims.sub);
    if (!user) {
      user = provisionSsoUser({ subject: claims.sub, preferredUsername: claims.preferred_username || claims.email || claims.name });
    }
    stmts.touchLastLogin.run(user.id);
    setSessionCookie(res, req, user);
    res.redirect('/app');
  } catch (e) {
    // Server log only, see the comment at /login/sso – token exchange/
    // ID-token validation can easily fail during first setup for reasons
    // (redirect_uri mismatch, clock drift, wrong secret) that would be
    // nearly impossible to narrow down without detail.
    console.error('SSO (/login/sso/callback) fehlgeschlagen:', e);
    res.setHeader('Set-Cookie', 'snar_oidc=; HttpOnly; SameSite=Lax; Path=/login/sso; Max-Age=0');
    res.status(401).send(views.loginPage({ error: 'SSO-Anmeldung fehlgeschlagen.', ssoEnabled: OIDC_ENABLED }));
  }
});

app.get('/', (req, res) => res.redirect(sessionUser(getCookie(req, 'snar_session')) ? '/app' : '/login'));
app.get('/healthz', (req, res) => res.type('text').send('ok'));
// Public, unauthenticated (same spirit as /healthz) – purely a self-
// recognition marker for the "Domain testen"-check, see INSTANCE_TOKEN above.
app.get('/healthz/instance', (req, res) => res.type('text').send(INSTANCE_TOKEN));

app.get('/app', requireAuth, (req, res) => {
  const links = stmts.linksByOwner.all(req.user.id);
  res.send(views.dashboard({
    links, user: req.user, flash: flashFromQuery(req), domains: getDomains(),
    shortUrl: (l) => shortUrl(l, req),
  }));
});

app.post('/app/links', requireAuth, (req, res) => {
  const { targetUrl, title, visibility, domain, expiresAt } = readLinkFields(req);
  const slug = String(req.body.slug || '').trim();
  // Re-renders the create form directly (like POST /login, POST /app/qr)
  // instead of redirecting on failure, so the entered values survive and
  // the offending field can be highlighted – a redirect+flash would lose
  // everything the user just typed.
  const rerenderDashboard = (error, errorField) => {
    res.send(views.dashboard({
      links: stmts.linksByOwner.all(req.user.id), user: req.user, flash: flashFromQuery(req), domains: getDomains(),
      shortUrl: (l) => shortUrl(l, req),
      error, errorField,
      values: { target_url: String(req.body.target_url || ''), slug, title, domain, expires_at: String(req.body.expires_at || ''), visibility },
    }));
  };
  if (!isHttpUrl(targetUrl)) return rerenderDashboard('Bitte eine gültige http(s)-URL angeben.', 'target_url');
  if (slug && (!/^[A-Za-z0-9\-_]{1,64}$/.test(slug) || RESERVED.has(slug.toLowerCase()))) {
    return rerenderDashboard('Slug ungültig oder reserviert.', 'slug');
  }
  try {
    const link = createLink({ slug, targetUrl, title, visibility, ownerId: req.user.id, domain, expiresAt });
    res.redirect(`/app/links/${link.id}`);
  } catch (e) {
    rerenderDashboard(
      e.code === 'SLUG_TAKEN' ? 'Dieser Slug ist bereits vergeben.' : 'Link konnte nicht angelegt werden.',
      e.code === 'SLUG_TAKEN' ? 'slug' : null,
    );
  }
});

// Load a link + check permission (owner or admin)
function loadOwnLink(req, res, next) {
  const link = stmts.linkById.get(Number(req.params.id));
  if (!link) return res.status(404).send('Nicht gefunden.');
  if (!canManage(req.user, link)) return res.status(403).send('Kein Zugriff auf diesen Link.');
  req.link = link;
  next();
}

// Same shape as loadOwnLink above, for the two /app/domains/:id/* routes
// that redirect-with-flash on a missing id (set-default, delete) – a third
// (check-reachability) needs a JSON 404 instead and keeps its own inline check.
function loadDomain(req, res, next) {
  const domain = stmts.domainById.get(Number(req.params.id));
  if (!domain) return flashRedirect(res, '/app/domains', 'err', 'Domain nicht gefunden.');
  req.domain = domain;
  next();
}

// Shared by the GET route and the POST .../update failure path (see below)
// – re-rendering on a validation error needs the exact same stats/audit
// data as a normal page load, so this avoids computing it twice. `overrides`
// carries the validation-error extras (error/errorField/values) on the
// failure path; the plain GET call omits it and gets the normal DB-backed render.
function renderLinkDetail(req, res, link, overrides = {}) {
  const ranges = linkStatsRanges(link.id, link.created_at);
  const stats = {
    // ranges.gesamt already sums every click since the link's creation
    // (its window starts at the creation month) – same number a dedicated
    // COUNT(*) query would give, no need for a second round-trip.
    total: ranges.gesamt.total,
    ranges,
    referrers: stmts.topReferrers.all(link.id),
    devices: stmts.deviceSplit.all(link.id),
    browsers: stmts.browserSplit.all(link.id),
    recent: stmts.recentClicks.all(link.id),
  };
  const ownerOrAdmin = isOwnerOrAdmin(req.user, link);
  res.send(views.linkDetail({
    link, origin: originFor(link, req), short: shortUrl(link, req), domains: getDomains(), stats,
    expiresAtLocal: toDatetimeLocal(link.expires_at), expired: isExpired(link),
    user: req.user, flash: flashFromQuery(req), page: pageFromReferer(req),
    // Drives both the visibility radios and the target-URL field (see
    // POST .../update below) – both have been restricted identically to
    // owner/admin since the pentest.
    canEditRestricted: ownerOrAdmin,
    canDelete: ownerOrAdmin,
    audit: ownerOrAdmin ? stmts.linkAuditByLink.all(link.id) : [],
    ...overrides,
  }));
}

app.get('/app/links/:id', requireAuth, loadOwnLink, (req, res) => {
  renderLinkDetail(req, res, req.link);
});

app.post('/app/links/:id/update', requireAuth, loadOwnLink, (req, res) => {
  const { targetUrl, title, visibility, domain, expiresAt } = readLinkFields(req);
  if (!isHttpUrl(targetUrl)) {
    return renderLinkDetail(req, res, req.link, {
      error: 'Ungültige URL – nichts geändert.',
      errorField: 'target_url',
      values: { target_url: String(req.body.target_url || ''), title, domain, expiresAtLocal: String(req.body.expires_at || '') },
    });
  }
  const ownerOrAdmin = isOwnerOrAdmin(req.user, req.link);
  // The target URL is a link's most security-critical field (redirect to
  // phishing/malware) – unlike title/domain/expiry, it stays reserved for
  // owner/admin even on org links (pentest finding, see README). Unlike
  // the visibility handling below, this isn't silently discarded but hard
  // rejected: the UI already locks the field (see linkDetail()), so a
  // request with a changed URL despite the locked field is either a bug or
  // a deliberate bypass attempt.
  if (!ownerOrAdmin && targetUrl !== req.link.target_url) {
    return res.status(403).send('Nur Besitzer:in/Admin dürfen die Ziel-URL ändern.');
  }
  // Non-owners of an org link may change everything except visibility and
  // the target URL (see isOwnerOrAdmin) – visibility stays untouched no
  // matter what the form sends, so nobody can lock themselves out by
  // saving (canManage() only grants non-owners access as long as
  // visibility stays 'org').
  const finalVisibility = ownerOrAdmin ? visibility : req.link.visibility;
  if (targetUrl !== req.link.target_url) {
    stmts.insertLinkAudit.run(req.link.id, req.user.id, req.link.target_url, targetUrl);
  }
  stmts.updateLink.run(targetUrl, title, finalVisibility, domain, expiresAt, req.link.id);
  flashRedirect(res, `/app/links/${req.link.id}`, 'ok', 'Gespeichert. QR-Code bleibt gültig.');
});

app.post('/app/links/:id/delete', requireAuth, loadOwnLink, (req, res) => {
  if (!isOwnerOrAdmin(req.user, req.link)) return res.status(403).send('Nur Besitzer:in/Admin dürfen diesen Link löschen.');
  stmts.deleteLink.run(req.link.id);
  flashRedirect(res, '/app', 'ok', 'Link gelöscht.');
});

// QR for a link the user owns (or as admin)
app.get('/app/links/:id/qr.:format(svg|png)', requireAuth, loadOwnLink, async (req, res) => {
  await sendQr(res, shortUrl(req.link, req), qrOpts(req, `qr-${req.link.slug}`));
});

// ---------------------------------------------------------------------------
// Personal vault (only the user's own links, regardless of role)
// ---------------------------------------------------------------------------
app.get('/app/user-vault', requireAuth, (req, res) => {
  const links = stmts.linksByOwnerPrivate.all(req.user.id);
  res.send(views.myVaultPage({ links, user: req.user, shortUrl: (l) => shortUrl(l, req) }));
});

// ---------------------------------------------------------------------------
// Org vault (every logged-in member). Deliberately sits under /app instead
// of the root path: everything under /app/* is already protected against
// slug collisions by the reserved word "app", making a separate
// reservation for "vault" unnecessary.
// ---------------------------------------------------------------------------
app.get('/app/org-vault', requireAuth, (req, res) => {
  const links = stmts.vaultLinks.all();
  res.send(views.vaultPage({
    links,
    user: req.user,
    shortUrl: (l) => shortUrl(l, req),
  }));
});

// ---------------------------------------------------------------------------
// Static QR code generator (content is never stored – and, thanks to POST,
// never visible in the URL/history/access logs either: the form and
// downloads use POST, the preview is rendered server-side inline into the HTML.)
// ---------------------------------------------------------------------------
app.get('/app/qr', requireAuth, (req, res) => {
  res.send(views.staticQrPage({ ec: EC_BY_TYPE.url, user: req.user }));
});

app.post('/app/qr', requireAuth, async (req, res) => {
  const type = QR_TYPES.includes(req.body.qr_type) ? req.body.qr_type : 'text';
  const ec = EC_BY_TYPE[type];
  const transparentBg = req.body.light_transparent === '1';
  const { dark, light } = qrColors(String(req.body.dark || ''), String(req.body.light || ''), transparentBg);
  // Raw values from every tab are kept for re-rendering the form (including
  // the currently inactive tab's), only `content` (the text actually
  // encoded) decides between preview and error.
  const values = {
    type,
    data: String(req.body.data || '').slice(0, 2000),
    url_value: String(req.body.url_value || '').slice(0, 2000),
    wlan_ssid: String(req.body.wlan_ssid || '').slice(0, 200),
    wlan_pass: String(req.body.wlan_pass || '').slice(0, 200),
    wlan_enc: ['WPA', 'WEP', 'nopass'].includes(req.body.wlan_enc) ? req.body.wlan_enc : 'WPA',
    epc_name: String(req.body.epc_name || '').slice(0, 70),
    epc_iban: String(req.body.epc_iban || '').slice(0, 34),
    epc_bic: String(req.body.epc_bic || '').slice(0, 11),
    epc_amount: String(req.body.epc_amount || '').slice(0, 20),
    epc_purpose: String(req.body.epc_purpose || '').slice(0, 140),
  };
  const content = buildQrTypeContent(req, type).slice(0, 2000);
  let svg = null, error = null;
  if (!content) {
    error = type === 'epc' ? 'Bitte mindestens Begünstigter und eine gültige IBAN angeben.'
      : type === 'wlan' ? 'Bitte mindestens die SSID angeben.'
      : 'Bitte einen Inhalt angeben.';
  } else {
    try { svg = await qrSvgString(content, ec, { dark, light }); }
    catch { error = 'Inhalt lässt sich nicht als QR-Code kodieren – vermutlich zu lang für die gewählte Fehlerkorrektur.'; }
  }
  res.send(views.staticQrPage({ content, ec, dark, light, transparentBg, svg, error, user: req.user, values }));
});

// Download via POST, so the (potentially sensitive) content never ends up in the URL.
app.post('/app/qr/download', requireAuth, async (req, res) => {
  const data = String(req.body.data || '').slice(0, 2000);
  if (!data) return res.status(400).send('Kein Inhalt.');
  const format = req.body.format === 'png' ? 'png' : 'svg';
  const color = qrColors(String(req.body.dark || ''), String(req.body.light || ''));
  await sendQr(res, data, { format, ec: String(req.body.ec || 'M'), size: 1024, download: true, filename: 'qr-statisch', color });
});

// ---------------------------------------------------------------------------
// User management (admins only)
// ---------------------------------------------------------------------------
app.get('/app/users', requireAuth, requireAdmin, (req, res) => {
  res.send(views.usersPage({ users: stmts.listUsers.all(), user: req.user, flash: flashFromQuery(req) }));
});

app.post('/app/users', requireAuth, requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'member';
  // Direct re-render on failure (see the comment at POST /app/links) –
  // password is deliberately never echoed back, only username/role.
  const rerenderUsers = (error, errorField) => {
    res.send(views.usersPage({
      users: stmts.listUsers.all(), user: req.user, flash: flashFromQuery(req),
      error, errorField, values: { username, role },
    }));
  };
  if (!USERNAME_RE.test(username)) {
    return rerenderUsers('Nutzername ungültig (2–32 Zeichen, a–z, 0–9, -_.)', 'username');
  }
  if (password.length < 8) {
    return rerenderUsers('Passwort zu kurz (mind. 8 Zeichen).', 'password');
  }
  if (stmts.userByName.get(username)) {
    return rerenderUsers('Nutzername bereits vergeben.', 'username');
  }
  stmts.insertUser.run(username, hashPassword(password), role);
  flashRedirect(res, '/app/users', 'ok', `"${username}" angelegt. Startpasswort sicher übermitteln – Wechsel unter Konto.`);
});

app.post('/app/users/:id/delete', requireAuth, requireAdmin, (req, res) => {
  const target = stmts.userById.get(Number(req.params.id));
  if (!target) return flashRedirect(res, '/app/users', 'err', 'Nutzer:in nicht gefunden.');
  if (target.id === req.user.id) {
    return flashRedirect(res, '/app/users', 'err', 'Du kannst dich nicht selbst löschen.');
  }
  if (target.role === 'admin' && stmts.countAdmins.get().n <= 1) {
    return flashRedirect(res, '/app/users', 'err', 'Der letzte Admin kann nicht gelöscht werden.');
  }
  const reassignId = Number(req.body.reassign_to);
  const reassignTo = reassignId && reassignId !== target.id ? stmts.userById.get(reassignId) : null;
  const recipient = reassignTo || req.user; // fallback: the admin performing the action
  stmts.reassignLinks.run(recipient.id, target.id);
  stmts.deleteUser.run(target.id);
  const you = recipient.id === req.user.id ? 'dich' : `"${recipient.username}"`;
  flashRedirect(res, '/app/users', 'ok', `"${target.username}" gelöscht, Links wurden an ${you} übertragen.`);
});

// ---------------------------------------------------------------------------
// Domains (admins only) – the first domain in the list is the default domain
// ---------------------------------------------------------------------------
app.get('/app/domains', requireAuth, requireAdmin, (req, res) => {
  res.send(views.domainsPage({ domains: stmts.listDomains.all(), user: req.user, flash: flashFromQuery(req) }));
});

app.post('/app/domains', requireAuth, requireAdmin, (req, res) => {
  const rawOrigin = String(req.body.origin || '').trim();
  const originInput = ensureScheme(rawOrigin);
  let origin = '';
  try { origin = new URL(originInput).origin; } catch { /* stays empty -> error below */ }
  // Direct re-render on failure (see the comment at POST /app/links).
  const rerenderDomains = (error) => {
    res.send(views.domainsPage({
      domains: stmts.listDomains.all(), user: req.user, flash: flashFromQuery(req),
      error, errorField: 'origin', values: { origin: rawOrigin },
    }));
  };
  if (!isHttpUrl(origin)) {
    return rerenderDomains('Ungültige Domain – bitte mit http(s):// angeben.');
  }
  if (stmts.domainExists.get(origin)) {
    return rerenderDomains('Diese Domain ist bereits konfiguriert.');
  }
  stmts.insertDomain.run(origin);
  flashRedirect(res, '/app/domains', 'ok', `"${origin}" hinzugefügt.`);
});

app.post('/app/domains/:id/set-default', requireAuth, requireAdmin, loadDomain, (req, res) => {
  stmts.setDefaultDomain.run(req.domain.id);
  flashRedirect(res, '/app/domains', 'ok', `"${req.domain.origin}" ist jetzt die Standard-Domain.`);
});

// Manual, on-demand only (never automatic/on page load): DNS/reverse proxy
// for a freshly added domain are often still being set up, so a check that
// runs on every page load would just show a false "nicht erreichbar" during
// that window. Diagnostic aid, not validation – adding a domain never
// depends on this succeeding.
//
// isPrivateOrLinkLocalIp/resolvesToPrivateIp: defense-in-depth against an
// admin (or a compromised admin session) adding e.g. "http://169.254.169.254"
// (cloud metadata) or an internal-network host and using the distinguishable
// outcomes (HTTP status vs. timeout vs. connection failed) as a coarse
// internal-network probe. Admins already have far more powerful primitives
// than this, so it's a hardening measure, not a hard security boundary.
// Loopback (127.0.0.0/8, ::1) is deliberately NOT blocked: it's the same
// machine snar itself runs on (an admin already has that access some other
// way in any realistic self-hosted deployment) and it's the legitimate case
// for a local/dev instance whose own domain points back at itself, like this
// one during development (BASE_URL=http://localhost:3000).
function isPrivateOrLinkLocalIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 0
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127);
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:')) return isPrivateOrLinkLocalIp(lower.slice(7));
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return true; // unparsable – reject rather than risk it
}
async function resolvesToPrivateIp(hostname) {
  try {
    const addrs = await dns.promises.lookup(hostname, { all: true });
    return addrs.some(a => isPrivateOrLinkLocalIp(a.address));
  } catch {
    return false; // let the fetch() below produce the normal DNS-failure message
  }
}
app.post('/app/domains/:id/check-reachability', requireAuth, requireAdmin, async (req, res) => {
  const domain = stmts.domainById.get(Number(req.params.id));
  if (!domain) return res.status(404).json({ ok: false, reason: 'Domain nicht gefunden.' });
  const hostname = new URL(domain.origin).hostname;
  if (await resolvesToPrivateIp(hostname)) {
    return res.json({ ok: false, reason: 'Zeigt auf eine private/interne Adresse – wird aus Sicherheitsgründen nicht geprüft.' });
  }
  try {
    const response = await fetch(`${domain.origin}/healthz/instance`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return res.json({ ok: false, reason: `Antwortet mit HTTP ${response.status}.` });
    const body = (await response.text()).trim();
    if (body !== INSTANCE_TOKEN) {
      return res.json({ ok: false, reason: 'Antwortet, zeigt aber nicht auf diese snar-Instanz.' });
    }
    return res.json({ ok: true });
  } catch (err) {
    const reason = err.name === 'TimeoutError'
      ? 'Zeitüberschreitung – keine Antwort innerhalb von 5 Sekunden.'
      : 'Nicht erreichbar (DNS, Verbindung oder TLS-Zertifikat fehlgeschlagen).';
    return res.json({ ok: false, reason });
  }
});

app.post('/app/domains/:id/delete', requireAuth, requireAdmin, loadDomain, (req, res) => {
  const domain = req.domain;
  const fallback = stmts.otherDomain.get(domain.id)?.origin || '';
  stmts.reassignLinkDomain.run(fallback, domain.origin); // affected links keep working correctly right away
  stmts.deleteDomain.run(domain.id);
  flashRedirect(res, '/app/domains', 'ok',
    `"${domain.origin}" entfernt${fallback ? `, betroffene Links laufen jetzt über "${fallback}"` : '.'}`);
});

app.get('/app/account', requireAuth, (req, res) => {
  res.send(views.accountPage({ user: req.user, flash: flashFromQuery(req) }));
});

app.post('/app/account/password', requireAuth, (req, res) => {
  // The UI already hides the form for SSO accounts (see accountPage()) –
  // enforce it server-side anyway, same principle as other permission
  // checks in the app (e.g. the visibility lock on org links).
  if (req.user.sso_subject) {
    return flashRedirect(res, '/app/account', 'err', 'Für SSO-Accounts nicht möglich — das Passwort wird extern verwaltet.');
  }
  if (!verifyPassword(String(req.body.current || ''), req.user.password_hash)) {
    return flashRedirect(res, '/app/account', 'err', 'Aktuelles Passwort ist falsch.');
  }
  const next = String(req.body.next || '');
  if (next.length < 8) {
    return flashRedirect(res, '/app/account', 'err', 'Neues Passwort zu kurz (mind. 8 Zeichen).');
  }
  if (next !== String(req.body.next_repeat || '')) {
    return flashRedirect(res, '/app/account', 'err', 'Passwörter stimmen nicht überein.');
  }
  stmts.updatePassword.run(hashPassword(next), req.user.id);
  // Invalidate every previously issued cookie (other devices get logged
  // out) and log this device back in fresh with the new version.
  stmts.bumpTokenVersion.run(req.user.id);
  setSessionCookie(res, req, stmts.userById.get(req.user.id));
  flashRedirect(res, '/app/account', 'ok', 'Passwort geändert. Andere Geräte wurden abgemeldet.');
});

// ---------------------------------------------------------------------------
// Redirect – the actual core (public)
// ---------------------------------------------------------------------------
app.get('/:slug([A-Za-z0-9\-_]{1,64})', (req, res, next) => {
  if (RESERVED.has(req.params.slug.toLowerCase())) return next();
  const link = stmts.linkBySlug.get(req.params.slug);
  if (!link) return res.status(404).send('Diesen Kurzlink gibt es nicht (mehr).');
  if (isExpired(link)) return res.status(410).send('Dieser Kurzlink ist abgelaufen.');

  const { device, browser } = parseUA(req.get('user-agent'));
  const lang = (req.get('accept-language') || '').split(',')[0].slice(0, 8);

  // Redirect goes out first, click insert after: stats should never delay
  // the redirect, not just never block it on an error.
  res.set('Cache-Control', 'no-store'); // 302 + no-store => target stays changeable at any time
  res.redirect(302, link.target_url);

  try {
    stmts.insertClick.run(link.id, refHost(req.get('referer')), device, browser, lang);
  } catch { /* stats must never block the redirect */ }
});

app.use((req, res) => res.status(404).send('Nicht gefunden.'));

app.listen(PORT, () => {
  const domains = getDomains();
  console.log(`snar läuft auf Port ${PORT}${domains.length ? ` – Kurz-Domain${domains.length > 1 ? 's' : ''}: ${domains.join(', ')}` : ''}`);
});
