const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const path = require('path');
const dns = require('dns');
const net = require('net');
const QRCode = require('qrcode');
// ESM-only; require() works from Node 20.19/22.12 (see package.json "engines").
const oidc = require('openid-client');

const { stmts, deleteUserAndReassign, createLink, getSessionSecret, hashPassword, verifyPassword, bootstrapAdmin, provisionSsoUser, seedDomainsIfEmpty } = require('./db');
const views = require('./views');
const { isExpired } = views;

const PORT = Number(process.env.PORT || 3000);

// Same rule as when creating an account via /app/users – applies to the bootstrap too.
const USERNAME_RE = /^[A-Za-z0-9\-_.]{2,32}$/;

// First start only: admin account from env; afterwards users are managed in-app.
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

// DOMAINS/BASE_URL seed the domain list on first start only; afterwards /app/domains.
seedDomainsIfEmpty(
  (process.env.DOMAINS || process.env.BASE_URL || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
);

const SECRET = getSessionSecret();
const RESERVED = new Set(['app', 'login', 'logout', 'static', 'favicon.ico', 'robots.txt', 'healthz']);

// Random per-process id (not a secret): lets "Domain testen" tell this snar instance
// apart from any other server answering on the domain.
const INSTANCE_TOKEN = crypto.randomBytes(16).toString('hex');

// Well-formed hash so unknown usernames also pay the scrypt cost; otherwise POST /login
// timing reveals which usernames exist.
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function getDomains() {
  return stmts.listDomainOrigins.all().map(d => d.origin);
}

// ---------------------------------------------------------------------------
// SSO (OIDC, e.g. Authentik) – additional login path, active once all three env vars are set.
// Discovery is lazy so an unreachable identity provider does not block startup.
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

// Pin domainless links (legacy data, single-domain setups) to the first configured domain.
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
// Named ranges, not `true`: `true` lets any client spoof req.ip via X-Forwarded-For and bypass
// the login rate limiter. Covers same-host and Docker-network proxies; TRUSTED_PROXIES
// (IPs/CIDRs) extends it for a proxy on a public address (README, "Reverse Proxy").
const TRUSTED_PROXIES = process.env.TRUSTED_PROXIES
  ? process.env.TRUSTED_PROXIES.split(',').map(s => s.trim()).filter(Boolean)
  : [];
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal', ...TRUSTED_PROXIES]);
// Security headers. style-src needs 'unsafe-inline' for style="..." attributes in views.js;
// script-src stays 'self' (no inline JS anywhere). img-src data: for the dropdown-arrow SVG in style.css.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(compression());
app.use(express.urlencoded({ extended: false }));
// Long cache + immutable: asset URLs carry a content hash (?v=...), so a changed file gets a new URL.
const STATIC_CACHE = { maxAge: '1y', immutable: true };
// Dedicated route: serves CSS_CONTENT (font hash already substituted, see views.js), not the raw file.
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
  // token_version ties the signature to the password state; bumping it invalidates all issued cookies.
  const payload = `u.${userId}.${tokenVersion}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

// Login + after a password change. Secure only over TLS (req.secure honors trust proxy).
function setSessionCookie(res, req, user) {
  res.setHeader('Set-Cookie',
    `snar_session=${makeSessionCookie(user.id, user.token_version)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}${req.secure ? '; Secure' : ''}`);
}

// Returns the payload if the HMAC signature is valid (constant-time); shared by sessionUser and verifyOidcState.
function verifySigned(token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const sig = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(sign(payload));
  // Compare byte lengths: a multibyte sig of equal string length would make timingSafeEqual throw.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(sig, expected)) return null;
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
    if (k === name) {
      // Malformed escape makes decodeURIComponent throw – treat as missing cookie, not a 500.
      try { return decodeURIComponent(v.join('=')); } catch { return null; }
    }
  }
  return null;
}

// Short-lived signed cookie carrying PKCE verifier/state/nonce across the OIDC round trip.
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

// Login rate limit (in-memory). Counts only FAILED attempts so users behind one NAT do not lock
// each other out. Keys "ip:..." and "user:..." (see POST /login) cover username enumeration
// from one IP as well as IP rotation.
const loginAttempts = new Map();
function rateLimited(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() > entry.reset) { loginAttempts.delete(key); return false; }
  return entry.count >= 10;
}
function noteFailedLogin(key) {
  const now = Date.now();
  // Purge expired entries, or many (spoofed) IPs would grow the map unbounded.
  if (loginAttempts.size >= 1000) {
    for (const [k, e] of loginAttempts) if (now > e.reset) loginAttempts.delete(k);
  }
  const entry = loginAttempts.get(key) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 15 * 60 * 1000; }
  entry.count++;
  loginAttempts.set(key, entry);
}

// Own domain, else first configured, else the current request host.
function originFor(link, req) {
  return (link && link.domain) || getDomains()[0] || `${req.protocol}://${req.get('host')}`;
}

// Active sidebar item for the detail page, derived from the referer so it matches "← Zurück";
// "dashboard" is the fallback.
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
  // Android phones say "Mobile", tablets do not – else tablets would count as phones.
  const device = /ipad|tablet/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua)) ? 'Tablet'
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

// Time-range stats for the detail page. Each returns a gap-free values array plus sparse axis labels.
// Bucketing is in server local time (SQL 'localtime', see db.js), so date arrays use local getters too.
// sparseLabels: every step-th point plus (unless forceLast=false) the last; i keeps the real index for
// positioning. forceLast=false only for statsRangeHourly: n=24/step=4 would skew the last gap to 3.
function sparseLabels(dates, step, formatFn, forceLast = true) {
  const n = dates.length;
  const out = [];
  dates.forEach((d, i) => {
    if (i % step === 0) out.push({ i, text: formatFn(d) });
  });
  if (forceLast && n > 0 && out[out.length - 1]?.i !== n - 1) {
    // A forced last label right next to the previous one would overprint it: the last wins.
    const gap = out.length ? n - 1 - out[out.length - 1].i : Infinity;
    if (gap <= Math.floor(step / 2)) out.pop();
    out.push({ i: n - 1, text: formatFn(dates[n - 1]) });
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');

// "20. Aug" on the first day and at month changes, else "25." Stateful: call in axis order.
function dayMonthFormatter() {
  let lastMonth = null;
  return (d) => {
    const text = d.getMonth() !== lastMonth
      ? `${d.getDate()}. ${d.toLocaleDateString('de-DE', { month: 'short' })}`
      : `${d.getDate()}.`;
    lastMonth = d.getMonth();
    return text;
  };
}

function statsRangeHourly(linkId) {
  const rows = stmts.clicksPerHourToday.all(linkId);
  const map = new Map(rows.map(r => [Number(r.hour), r.n]));
  const values = Array.from({ length: 24 }, (_, h) => map.get(h) || 0);
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const labels = sparseLabels(hours, 4, h => String(h), false);
  if (labels.length) labels[labels.length - 1].text += ' Uhr'; // the last shown point gets context
  // Unthinned labels for the hover tooltip.
  const pointLabels = Array.from({ length: 24 }, (_, h) => `${pad2(h)}:00 Uhr`);
  return { label: 'heute', values, labels, pointLabels };
}

function statsRangeDaily(linkId, days) {
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
  const dayMonth = dayMonthFormatter();
  const labels = sparseLabels(dates, weekly ? 1 : 5,
    d => weekly ? d.toLocaleDateString('de-DE', { weekday: 'short' }) : dayMonth(d));
  const pointLabels = dates.map(d => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }));
  return { label: weekly ? 'letzte 7 Tage' : 'letzte 30 Tage', values, labels, pointLabels };
}

// label/step/formatFn are parameters so statsRangeAll() can reuse this for more than 12 months.
function statsRangeMonthly(linkId, months, { label = 'letzte 12 Monate', step = 2, formatFn } = {}) {
  const rows = stmts.clicksPerMonth.all(linkId, `-${months - 1} months`);
  const map = new Map(rows.map(r => [r.month, r.n]));
  const dates = [];
  const today = new Date();
  for (let i = months - 1; i >= 0; i--) {
    dates.push(new Date(today.getFullYear(), today.getMonth() - i, 1));
  }
  const values = dates.map(d => map.get(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`) || 0);
  const labels = sparseLabels(dates, step, formatFn || (d => d.toLocaleDateString('de-DE', { month: 'short' })));
  const pointLabels = dates.map(d => d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }));
  // The last bucket is the running month: chart draws it dashed, tooltip says "(bisher)".
  pointLabels[pointLabels.length - 1] += ' (bisher)';
  return { label, values, labels, pointLabels, partialLast: true };
}

// "Gesamt": monthly over the whole lifetime, ~6 labels; with the year once lifetime > 1 year
// (else repeated "Jan"s look identical).
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

// "YYYY-MM-DD" + n days as plain calendar arithmetic (UTC anchor, no timezone involved).
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Bounded to 2000..2100: statsRangeCustom builds one bucket per day/month, so huge spans
// would mean a multi-MB page.
function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  if (s < '2000-01-01' || s > '2100-12-31') return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// User-picked inclusive [from, to], validated/ordered by renderLinkDetail(). Granularity scales
// with the span (hourly, daily, monthly) like the fixed presets.
function statsRangeCustom(linkId, fromStr, toStr) {
  const toExclusive = addDaysStr(toStr, 1);
  const spanDays = Math.round((new Date(toExclusive + 'T00:00:00Z') - new Date(fromStr + 'T00:00:00Z')) / 86400000);
  const fmtFull = (s) => new Date(s + 'T00:00:00Z').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  const label = fromStr === toStr ? fmtFull(fromStr) : `${fmtFull(fromStr)} – ${fmtFull(toStr)}`;

  if (spanDays <= 3) {
    const rows = stmts.clicksPerHourInRange.all(linkId, fromStr, toExclusive);
    const map = new Map(rows.map(r => [r.bucket, r.n]));
    const hourKey = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())} ${pad2(dt.getHours())}`;
    const hours = [];
    const seen = new Set();
    for (let i = 0; i < spanDays; i++) {
      const [y, m, d] = addDaysStr(fromStr, i).split('-').map(Number);
      for (let h = 0; h < 24; h++) {
        const dt = new Date(y, m - 1, d, h);
        // Spring-forward day: hour 02 rolls over to 03:00 and would count twice – skip repeats.
        if (seen.has(hourKey(dt))) continue;
        seen.add(hourKey(dt));
        hours.push(dt);
      }
    }
    const values = hours.map(dt => map.get(hourKey(dt)) || 0);
    const labels = sparseLabels(hours, Math.max(1, Math.round(hours.length / 8)), dt => `${pad2(dt.getHours())}:00`);
    const pointLabels = hours.map(dt => `${dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${pad2(dt.getHours())}:00 Uhr`);
    return { label, values, labels, pointLabels };
  }

  if (spanDays <= 92) {
    const days = Array.from({ length: spanDays }, (_, i) => {
      const [y, m, d] = addDaysStr(fromStr, i).split('-').map(Number);
      return new Date(y, m - 1, d);
    });
    const rows = stmts.clicksPerDayInRange.all(linkId, fromStr, toExclusive);
    const map = new Map(rows.map(r => [r.day, r.n]));
    const values = days.map(d => map.get(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`) || 0);
    const step = spanDays <= 7 ? 1 : Math.max(1, Math.round(spanDays / 6));
    const dayMonth = dayMonthFormatter();
    const labels = sparseLabels(days, step, d => dayMonth(d));
    const pointLabels = days.map(d => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }));
    return { label, values, labels, pointLabels };
  }

  // Beyond ~3 months: monthly buckets, same shape as statsRangeMonthly/-All.
  const [fy, fm] = fromStr.split('-').map(Number);
  const [ty, tm] = toStr.split('-').map(Number);
  const monthCount = (ty - fy) * 12 + (tm - fm) + 1;
  const months = Array.from({ length: monthCount }, (_, i) => {
    const total = (fm - 1) + i;
    return new Date(fy + Math.floor(total / 12), total % 12, 1);
  });
  const rows = stmts.clicksPerMonthInRange.all(linkId, fromStr, toExclusive);
  const map = new Map(rows.map(r => [r.month, r.n]));
  const values = months.map(d => map.get(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`) || 0);
  const step = Math.max(1, Math.round(monthCount / 6));
  const formatFn = d => d.toLocaleDateString('de-DE', monthCount > 12 ? { month: 'short', year: '2-digit' } : { month: 'short' });
  const labels = sparseLabels(months, step, formatFn);
  const pointLabels = months.map(d => d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }));
  const now = new Date();
  const partialLast = ty === now.getFullYear() && tm === now.getMonth() + 1;
  if (partialLast) pointLabels[pointLabels.length - 1] += ' (bisher)';
  return { label, values, labels, pointLabels, partialLast };
}

function linkStatsRanges(linkId, createdAt, custom) {
  const ranges = {
    tag: statsRangeHourly(linkId),
    woche: statsRangeDaily(linkId, 7),
    monat: statsRangeDaily(linkId, 30),
    // step: 1 – only 12 points, so show every month.
    jahr: statsRangeMonthly(linkId, 12, { step: 1 }),
    gesamt: statsRangeAll(linkId, createdAt),
  };
  if (custom) ranges.custom = statsRangeCustom(linkId, custom.from, custom.to);
  for (const r of Object.values(ranges)) r.total = r.values.reduce((a, b) => a + b, 0);
  return ranges;
}

// Org links belong to the whole team: any logged-in member may view/edit them.
// Private links: owner/admin only. Visibility change and delete are narrower, see isOwnerOrAdmin.
function canManage(user, link) {
  return user.role === 'admin' || link.owner_id === user.id || link.visibility === 'org';
}

// Visibility change and delete stay owner/admin only: otherwise a member could lock themselves
// out via "Persönlich" (canManage() only grants non-owners access while visibility is 'org'),
// and delete is irreversible for the whole team.
function isOwnerOrAdmin(user, link) {
  return user.role === 'admin' || link.owner_id === user.id;
}

// Expiry from <input type="datetime-local">. With JS the client sends tz_offset (getTimezoneOffset)
// for exact browser-timezone math; without it, server local time approximates. Stored as UTC
// 'YYYY-MM-DD HH:MM:SS' so datetime('now') in SQL stays comparable.
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

// Errors (e.g. content exceeds QR capacity) become 400: Express 4 does not catch async rejections,
// which would kill the process. Download header only after success, so errors are not saved as files.
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

// QR as SVG string for the generator's inline preview (keeps content out of URLs/logs). The library
// encodes paths, not raw text, so embedding is injection-safe.
function qrSvgString(text, ec, color) {
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: normalizeEc(ec), margin: 2, color });
}

// Generator only (link QR codes stay black/white); invalid values fall back to black/white.
// 8-digit hex allowed so a transparent background survives a re-download (<input type=color> gives 6 digits).
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
function qrColors(darkRaw, lightRaw, transparentBg) {
  return {
    dark: HEX_COLOR_RE.test(darkRaw) ? darkRaw : '#000000',
    light: transparentBg ? '#ffffff00' : (HEX_COLOR_RE.test(lightRaw) ? lightRaw : '#ffffff'),
  };
}

// Error correction is automatic per type: WLAN/EPC get printed and handled, so H; URL/Text use M.
const EC_BY_TYPE = { url: 'M', text: 'M', wlan: 'H', epc: 'H' };
const QR_TYPES = Object.keys(EC_BY_TYPE);

// Static generator content per tab: url/text are passthrough; WLAN/EPC use standard formats
// scanner apps recognize (WiFi credentials, SEPA "GiroCode").
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
// EPC069-12: BIC optional since 2016; trailing empty lines are stripped, middle ones (unused
// purpose code/reference) must stay as placeholders or later fields shift.
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
// Any URI scheme is kept; otherwise "https://" is prepended so link/QR/domain work without a typed prefix.
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
  // Empty username gets no key, else all blank attempts would share one "user:" entry.
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
  // Bump token_version like a password change: else a stolen cookie stays valid for 30 days
  // (Max-Age=0 only clears it in the browser). Accepted side effect: logs out every device,
  // there is no per-session invalidation.
  const user = sessionUser(getCookie(req, 'snar_session'));
  if (user) stmts.bumpTokenVersion.run(user.id);
  res.setHeader('Set-Cookie', 'snar_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.redirect('/login');
});

// SSO login (OIDC Authorization Code + PKCE). redirect_uri comes from the first configured
// domain (like originFor()) to match the URI registered with the identity provider.
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
    // SameSite=Lax (not Strict): Strict would block the cookie on the IdP's cross-site redirect back.
    // redirectUri travels along so the callback reuses it exactly; re-deriving it (proxy, domain change)
    // could cause a "redirect_uri mismatch".
    res.setHeader('Set-Cookie',
      `snar_oidc=${signOidcState({ codeVerifier, state, nonce, redirectUri })}; HttpOnly; SameSite=Lax; Path=/login/sso; Max-Age=600${req.secure ? '; Secure' : ''}`);
    res.redirect(authUrl.href);
  } catch (e) {
    // Details in the server log only; the browser message stays generic.
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
    // Same redirectUri as in the authorize step (see /login/sso), not rebuilt from req.protocol/host.
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
    // Server log only (see /login/sso): redirect_uri mismatch, clock drift etc. need the detail.
    console.error('SSO (/login/sso/callback) fehlgeschlagen:', e);
    res.setHeader('Set-Cookie', 'snar_oidc=; HttpOnly; SameSite=Lax; Path=/login/sso; Max-Age=0');
    res.status(401).send(views.loginPage({ error: 'SSO-Anmeldung fehlgeschlagen.', ssoEnabled: OIDC_ENABLED }));
  }
});

app.get('/', (req, res) => res.redirect(sessionUser(getCookie(req, 'snar_session')) ? '/app' : '/login'));
app.get('/healthz', (req, res) => res.type('text').send('ok'));
// Public, unauthenticated – self-recognition marker for "Domain testen", see INSTANCE_TOKEN.
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
  // Re-render instead of redirect on failure: keeps entered values and can highlight the field.
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

// Like loadOwnLink for the /app/domains/:id/* routes that redirect-with-flash;
// check-reachability needs a JSON 404 and checks inline.
function loadDomain(req, res, next) {
  const domain = stmts.domainById.get(Number(req.params.id));
  if (!domain) return flashRedirect(res, '/app/domains', 'err', 'Domain nicht gefunden.');
  req.domain = domain;
  next();
}

// Shared by the GET route and the POST .../update failure path; 'overrides' carries
// error/errorField/values on the failure path.
function renderLinkDetail(req, res, link, overrides = {}) {
  // Custom date range needs both bounds valid, else silently ignored (falls back to "Monat").
  const { from, to } = req.query;
  const custom = isValidDateStr(from) && isValidDateStr(to)
    ? (from <= to ? { from, to } : { from: to, to: from })
    : null;
  const ranges = linkStatsRanges(link.id, link.created_at, custom);

  // "Letzte Klicks": always the most recent clicks, independent of the stats range. Keyset pagination
  // on id (recentClicks* in db.js), not LIMIT/OFFSET, so deep pages stay fast; a malformed or stale
  // cursor falls back to the first page.
  const recentSize = 25;
  const beforeId = /^\d+$/.test(req.query.clicksBefore || '') ? Number(req.query.clicksBefore) : null;
  const afterId = !beforeId && /^\d+$/.test(req.query.clicksAfter || '') ? Number(req.query.clicksAfter) : null;

  const firstPage = () => {
    const fetched = stmts.recentClicksFirst.all(link.id, recentSize + 1);
    return { recent: fetched.slice(0, recentSize), hasOlder: fetched.length > recentSize, hasNewer: false };
  };
  let page;
  if (beforeId) {
    const fetched = stmts.recentClicksOlder.all(link.id, beforeId, recentSize + 1);
    // hasNewer: we navigated here from a newer page, it's still there
    page = { recent: fetched.slice(0, recentSize), hasOlder: fetched.length > recentSize, hasNewer: true };
  } else if (afterId) {
    const fetched = stmts.recentClicksNewer.all(link.id, afterId, recentSize + 1); // ascending
    page = { recent: fetched.slice(0, recentSize).reverse(), hasOlder: true, hasNewer: fetched.length > recentSize };
  } else {
    page = firstPage();
  }
  // A cursor that leads nowhere falls back to the first page.
  if (!page.recent.length && (beforeId || afterId)) page = firstPage();
  const { recent, hasOlder, hasNewer } = page;
  // #letzte-klicks: the hrefs reload the page; without the fragment the scroll position is lost.
  const clicksHref = (cursorParam, cursorId) => {
    const params = new URLSearchParams();
    if (custom) { params.set('from', custom.from); params.set('to', custom.to); }
    params.set(cursorParam, String(cursorId));
    return `/app/links/${link.id}?${params.toString()}#letzte-klicks`;
  };

  const stats = {
    ranges,
    lastClickTs: stmts.lastClick.get(link.id)?.ts || null,
    initialRange: custom ? 'custom' : 'monat',
    customRange: custom,
    referrers: stmts.topReferrers.all(link.id),
    devices: stmts.deviceSplit.all(link.id),
    browsers: stmts.browserSplit.all(link.id),
    languages: stmts.languageSplit.all(link.id),
    recent,
    recentTotal: stmts.recentClicksCount.get(link.id).n,
    // "from–to of total": count of newer rows via index range scan (idx_clicks_link_id).
    recentFrom: recent.length ? stmts.recentClicksNewerCount.get(link.id, recent[0].id).n + 1 : 0,
    // Newer = toward the top of the list (more recent), older = toward the
    // Newer/older name the data direction, not the screen position.
    recentNewerHref: hasNewer && recent.length ? clicksHref('clicksAfter', recent[0].id) : null,
    recentOlderHref: hasOlder && recent.length ? clicksHref('clicksBefore', recent[recent.length - 1].id) : null,
    recentSize,
  };
  const ownerOrAdmin = isOwnerOrAdmin(req.user, link);
  res.send(views.linkDetail({
    link, origin: originFor(link, req), short: shortUrl(link, req), domains: getDomains(), stats,
    expiresAtLocal: toDatetimeLocal(link.expires_at), expired: isExpired(link),
    user: req.user, flash: flashFromQuery(req), page: pageFromReferer(req),
    // Drives the visibility radios and the target-URL field (owner/admin only, see POST .../update).
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
  const ownerOrAdmin = isOwnerOrAdmin(req.user, req.link);
  if (!isHttpUrl(targetUrl)) {
    return renderLinkDetail(req, res, req.link, {
      error: 'Ungültige URL – nichts geändert.',
      errorField: 'target_url',
      // keep the submitted visibility (only owner/admin can change it; others see the stored value)
      values: { target_url: String(req.body.target_url || ''), title, domain, expiresAtLocal: String(req.body.expires_at || ''), visibility: ownerOrAdmin ? visibility : req.link.visibility },
    });
  }
  // The target URL is the most security-critical field (phishing/malware redirect): owner/admin only,
  // even on org links. Hard 403 instead of silent discard: the UI locks the field, so a changed
  // value is a bug or a bypass attempt.
  if (!ownerOrAdmin && targetUrl !== req.link.target_url) {
    return res.status(403).send('Nur Besitzer:in/Admin dürfen die Ziel-URL ändern.');
  }
  // Non-owners of an org link keep the stored visibility, so nobody can lock themselves out by saving.
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
// Org vault (every logged-in member). Under /app since "app" is already reserved, so "vault"
// needs no extra slug reservation.
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
// Static QR generator: content is never stored; POST keeps it out of URLs/history/access logs,
// the preview is rendered inline server-side.
// ---------------------------------------------------------------------------
app.get('/app/qr', requireAuth, (req, res) => {
  res.send(views.staticQrPage({ ec: EC_BY_TYPE.url, user: req.user }));
});

app.post('/app/qr', requireAuth, async (req, res) => {
  const type = QR_TYPES.includes(req.body.qr_type) ? req.body.qr_type : 'text';
  const ec = EC_BY_TYPE[type];
  const transparentBg = req.body.light_transparent === '1';
  const { dark, light } = qrColors(String(req.body.dark || ''), String(req.body.light || ''), transparentBg);
  // Raw values of every tab are kept for re-rendering; only `content` decides between preview and error.
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
  // Re-render on failure (see POST /app/links); password is never echoed back.
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
  deleteUserAndReassign(target.id, recipient.id);
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

// Manual, on-demand only: DNS/proxy of a fresh domain is often still being set up, so an automatic
// check would show a false "nicht erreichbar". Diagnostic aid; adding a domain never depends on it.
//
// isPrivateOrLinkLocalIp/resolvesToPrivateIp: SSRF hardening so an admin (or hijacked admin session)
// cannot probe internal hosts (e.g. 169.254.169.254 metadata) via distinguishable outcomes.
// Loopback is deliberately allowed: local/dev instances point at themselves (BASE_URL=http://localhost:3000).
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
    // redirect: 'manual' – sonst folgt fetch() einem 3xx und die Private-IP-Prüfung läuft ins Leere
    // (Redirect auf interne Adresse/Cloud-Metadata). Das eigentliche Kurzlink-Redirect läuft im Browser.
    const response = await fetch(`${domain.origin}/healthz/instance`, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      return res.json({ ok: false, reason: 'Antwortet mit einer Weiterleitung – wird aus Sicherheitsgründen nicht automatisch verfolgt.' });
    }
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
  // The UI hides the form for SSO accounts – enforced server-side too.
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
  // Invalidate every issued cookie (other devices) and log this device back in fresh.
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

  // Redirect first, click insert after: stats must never delay the redirect.
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
