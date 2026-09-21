const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { migrate } = require('./migrations');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'snar.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL'); // safe in combination with WAL, saves an fsync per write
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  token_version INTEGER NOT NULL DEFAULT 0,      -- part of the session signature; +1 invalidates old sessions
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  sso_subject   TEXT  -- Authentik's stable "sub" claim; NULL = local account. Uniqueness via idx_users_sso_subject (SQLite doesn't allow an inline UNIQUE that still permits multiple NULLs)
);

CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT UNIQUE NOT NULL,
  target_url TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'privat',     -- 'privat' | 'org'
  owner_id   INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  domain     TEXT NOT NULL DEFAULT '',           -- e.g. https://example.com; empty rows are backfilled once at startup (server.js)
  expires_at TEXT                                -- NULL = never expires; same format as other timestamps ('YYYY-MM-DD HH:MM:SS', UTC)
);

CREATE TABLE IF NOT EXISTS clicks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id  INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  ts       TEXT NOT NULL DEFAULT (datetime('now')),
  referrer TEXT NOT NULL DEFAULT '',
  device   TEXT NOT NULL DEFAULT '',
  browser  TEXT NOT NULL DEFAULT '',
  lang     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_clicks_link_ts ON clicks(link_id, ts);
-- Backs the "Letzte Klicks" keyset pagination (recentClicksFirst/Older/Newer
-- in stmts below): WHERE link_id = ? AND id < ? / id > ? ORDER BY id
-- DESC/ASC needs id itself in the index, not just ts – without this, SQLite still
-- has to sort matching rows by id after the fact instead of walking them
-- off the index directly, quietly reintroducing the "gets slower on deep
-- pages" cost the keyset approach exists to avoid.
CREATE INDEX IF NOT EXISTS idx_clicks_link_id ON clicks(link_id, id);
-- Dashboard/personal vault filter by owner_id, shared vault by visibility –
-- without an index this would be a full table scan over links on every request.
CREATE INDEX IF NOT EXISTS idx_links_owner ON links(owner_id);
CREATE INDEX IF NOT EXISTS idx_links_visibility ON links(visibility);
-- SSO login (Authentik/OIDC, see server.js): a separate unique index rather
-- than an inline UNIQUE on the column – SQLite still allows any number of
-- NULLs through it (local accounts without an SSO link).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso_subject ON users(sso_subject);

-- Logs every target-URL change (who, when, old -> new). The target URL is a
-- link's most security-critical field (redirect to phishing/malware) and,
-- since the pentest, restricted to owner/admin (see
-- POST /app/links/:id/update in server.js) – this log adds traceability for
-- exactly those changes on top of that restriction.
CREATE TABLE IF NOT EXISTS link_audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  old_url TEXT NOT NULL,
  new_url TEXT NOT NULL,
  ts      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_link_audit_link ON link_audit(link_id, ts);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  origin     TEXT UNIQUE NOT NULL,           -- e.g. https://example.com, no path/trailing slash
  sort_order INTEGER NOT NULL DEFAULT 0,     -- lowest value = default domain, see setDefaultDomain
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Baseline above = schema version 1; later schema changes are numbered steps in migrations.js.
// Must run before any statement is prepared, since those may use columns added by a step.
migrate(db, { dataDir: DATA_DIR });

// ---------------------------------------------------------------------------
// Session secret (persisted so logins survive restarts)
// ---------------------------------------------------------------------------
function getSessionSecret() {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'session_secret'`).get();
  if (row) return row.value;
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO meta (key, value) VALUES ('session_secret', ?)`).run(secret);
  return secret;
}

// ---------------------------------------------------------------------------
// Theme (admin page "Darstellung"): accent colour and instance name. Stored in
// meta as theme_<key>; no row means the default.
// ---------------------------------------------------------------------------
const THEME_KEYS = new Set(['accent', 'name']);
function getThemeSetting(key) {
  if (!THEME_KEYS.has(key)) throw new Error('unknown theme key: ' + key);
  return db.prepare('SELECT value FROM meta WHERE key = ?').get('theme_' + key)?.value || null;
}
function setThemeSetting(key, value) {
  if (!THEME_KEYS.has(key)) throw new Error('unknown theme key: ' + key);
  if (value) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('theme_' + key, value);
  else db.prepare('DELETE FROM meta WHERE key = ?').run('theme_' + key);
}

// ---------------------------------------------------------------------------
// Passwords: scrypt (Node built-in, no bcrypt package needed)
// ---------------------------------------------------------------------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) {
    // SSO accounts have no hash: do the same scrypt work anyway, so the response time does not tell
    // them apart from local accounts.
    crypto.scryptSync(pw, Buffer.alloc(16), 32);
    return false;
  }
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

// Shared base for the "links + owner name + click count" queries below;
// only WHERE/ORDER BY differ.
const LINKS_BASE = `
  SELECT l.*, u.username AS owner_name, COUNT(c.id) AS clicks_total
  FROM links l
  LEFT JOIN users u ON u.id = l.owner_id
  LEFT JOIN clicks c ON c.link_id = l.id
`;

const stmts = {
  insertUser: db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`),
  insertSsoUser: db.prepare(`INSERT INTO users (username, password_hash, role, sso_subject) VALUES (?, '', 'member', ?)`),
  userByName: db.prepare(`SELECT * FROM users WHERE username = ?`),
  userById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  userBySsoSubject: db.prepare(`SELECT * FROM users WHERE sso_subject = ?`),
  listUsers: db.prepare(`
    SELECT u.*, COUNT(l.id) AS links_count
    FROM users u LEFT JOIN links l ON l.owner_id = u.id
    GROUP BY u.id ORDER BY u.username COLLATE NOCASE
  `),
  countUsers: db.prepare(`SELECT COUNT(*) AS n FROM users`),
  countAdmins: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`),
  deleteUser: db.prepare(`DELETE FROM users WHERE id = ?`),
  // link_audit.user_id has no ON DELETE action: detach the log rows first, or
  // deleting a user who ever changed a target URL fails on the FK.
  clearAuditUser: db.prepare(`UPDATE link_audit SET user_id = NULL WHERE user_id = ?`),
  updatePassword: db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`),
  bumpTokenVersion: db.prepare(`UPDATE users SET token_version = token_version + 1 WHERE id = ?`),
  touchLastLogin: db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`),
  reassignLinks: db.prepare(`UPDATE links SET owner_id = ? WHERE owner_id = ?`),

  insertLink: db.prepare(`INSERT INTO links (slug, target_url, title, visibility, owner_id, domain, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  slugExists: db.prepare(`SELECT 1 FROM links WHERE slug = ?`),
  linkBySlug: db.prepare(`SELECT * FROM links WHERE slug = ?`),
  linkById: db.prepare(`SELECT l.*, u.username AS owner_name FROM links l LEFT JOIN users u ON u.id = l.owner_id WHERE l.id = ?`),
  updateLink: db.prepare(`UPDATE links SET target_url = ?, title = ?, visibility = ?, domain = ?, expires_at = ?, updated_at = datetime('now') WHERE id = ?`),
  backfillDomain: db.prepare(`UPDATE links SET domain = ? WHERE domain = ''`),
  deleteLink: db.prepare(`DELETE FROM links WHERE id = ?`),
  insertLinkAudit: db.prepare(`INSERT INTO link_audit (link_id, user_id, old_url, new_url) VALUES (?, ?, ?, ?)`),
  linkAuditByLink: db.prepare(`
    SELECT la.*, u.username FROM link_audit la LEFT JOIN users u ON u.id = la.user_id
    WHERE la.link_id = ? ORDER BY la.ts DESC LIMIT 25
  `),
  linksByOwner: db.prepare(`${LINKS_BASE} WHERE l.owner_id = ? GROUP BY l.id ORDER BY l.created_at DESC`),
  // Personal vault: own links with visibility "privat" only.
  linksByOwnerPrivate: db.prepare(`${LINKS_BASE} WHERE l.owner_id = ? AND l.visibility = 'privat' GROUP BY l.id ORDER BY l.created_at DESC`),
  // Includes click counts: any member may open an org link's full stats (see canManage in server.js).
  vaultLinks: db.prepare(`${LINKS_BASE} WHERE l.visibility = 'org' GROUP BY l.id ORDER BY l.title COLLATE NOCASE, l.slug`),

  // Domains (admin-only, /app/domains): lowest sort_order = default domain, id as tiebreaker.
  listDomains: db.prepare(`
    SELECT d.*, COUNT(l.id) AS links_count
    FROM domains d LEFT JOIN links l ON l.domain = d.origin
    GROUP BY d.id ORDER BY d.sort_order ASC, d.id ASC
  `),
  // Same order without the join: getDomains() runs on nearly every request
  // and links.domain has no index, so listDomains would scan all of links.
  listDomainOrigins: db.prepare(`SELECT origin FROM domains ORDER BY sort_order ASC, id ASC`),
  domainById: db.prepare(`SELECT * FROM domains WHERE id = ?`),
  // Fallback when deleting a domain (POST /app/domains/:id/delete).
  otherDomain: db.prepare(`SELECT origin FROM domains WHERE id != ? ORDER BY sort_order ASC, id ASC LIMIT 1`),
  domainExists: db.prepare(`SELECT 1 FROM domains WHERE origin = ?`),
  insertDomain: db.prepare(`INSERT INTO domains (origin) VALUES (?)`),
  deleteDomain: db.prepare(`DELETE FROM domains WHERE id = ?`),
  // Strictly below the current minimum: always ends up first, even when repeated.
  setDefaultDomain: db.prepare(`UPDATE domains SET sort_order = (SELECT MIN(sort_order) - 1 FROM domains) WHERE id = ?`),
  reassignLinkDomain: db.prepare(`UPDATE links SET domain = ? WHERE domain = ?`),

  insertClick: db.prepare(`INSERT INTO clicks (link_id, referrer, device, browser, lang) VALUES (?, ?, ?, ?, ?)`),
  // Buckets in server local time ('localtime', TZ set in the container) so
  // "today" starts at local midnight; storage stays UTC, window starts are
  // converted back to UTC for comparing against ts.
  clicksPerDay: db.prepare(`
    SELECT date(ts, 'localtime') AS day, COUNT(*) AS n FROM clicks
    WHERE link_id = ? AND ts >= datetime('now', 'localtime', 'start of day', ?, 'utc')
    GROUP BY day
  `),
  clicksPerHourToday: db.prepare(`
    SELECT strftime('%H', ts, 'localtime') AS hour, COUNT(*) AS n FROM clicks
    WHERE link_id = ? AND ts >= datetime('now', 'localtime', 'start of day', 'utc')
    GROUP BY hour
  `),
  clicksPerMonth: db.prepare(`
    SELECT strftime('%Y-%m', ts, 'localtime') AS month, COUNT(*) AS n FROM clicks
    WHERE link_id = ? AND ts >= datetime('now', 'localtime', 'start of month', ?, 'utc')
    GROUP BY month
  `),
  // Same bucketing for a custom [from, toExclusive) window. 'utc' on a bare
  // date string reads it as local wall-clock time and shifts it to UTC.
  clicksPerHourInRange: db.prepare(`
    SELECT strftime('%Y-%m-%d %H', ts, 'localtime') AS bucket, COUNT(*) AS n FROM clicks
    WHERE link_id = ? AND ts >= datetime(?, 'utc') AND ts < datetime(?, 'utc')
    GROUP BY bucket
  `),
  clicksPerDayInRange: db.prepare(`
    SELECT date(ts, 'localtime') AS day, COUNT(*) AS n FROM clicks
    WHERE link_id = ? AND ts >= datetime(?, 'utc') AND ts < datetime(?, 'utc')
    GROUP BY day
  `),
  clicksPerMonthInRange: db.prepare(`
    SELECT strftime('%Y-%m', ts, 'localtime') AS month, COUNT(*) AS n FROM clicks
    WHERE link_id = ? AND ts >= datetime(?, 'utc') AND ts < datetime(?, 'utc')
    GROUP BY month
  `),
  // The three splits feed the top-5 lists and the "Weitere" dialog
  // (splitBreakdownList() in views.js); capped at 100 rows, the rest is a static tail row.
  topReferrers: db.prepare(`
    SELECT CASE WHEN referrer = '' THEN '(direkt / QR-Scan)' ELSE referrer END AS ref, COUNT(*) AS n
    FROM clicks WHERE link_id = ? GROUP BY ref ORDER BY n DESC LIMIT 100
  `),
  deviceSplit: db.prepare(`SELECT device, COUNT(*) AS n FROM clicks WHERE link_id = ? GROUP BY device ORDER BY n DESC`),
  browserSplit: db.prepare(`SELECT browser, COUNT(*) AS n FROM clicks WHERE link_id = ? GROUP BY browser ORDER BY n DESC LIMIT 100`),
  // Primary language only ("de-DE" and "de-AT" -> "de"); '' = unknown.
  languageSplit: db.prepare(`
    SELECT lower(CASE WHEN instr(lang, '-') > 0 THEN substr(lang, 1, instr(lang, '-') - 1) ELSE lang END) AS lang_code, COUNT(*) AS n
    FROM clicks WHERE link_id = ? GROUP BY lang_code ORDER BY n DESC LIMIT 100
  `),
  lastClick: db.prepare(`SELECT ts FROM clicks WHERE link_id = ? ORDER BY id DESC LIMIT 1`),
  // The COUNTs only walk the covering (link_id, id) index, but still touch one entry per click.
  recentClicksCount: db.prepare(`SELECT COUNT(*) AS n FROM clicks WHERE link_id = ?`),
  recentClicksNewerCount: db.prepare(`SELECT COUNT(*) AS n FROM clicks WHERE link_id = ? AND id > ?`),
  // Keyset pagination instead of LIMIT/OFFSET: id follows click order and, unlike
  // ts, needs no tie-breaker for same-second rows; the seek stays O(log n) at
  // any depth. Cursor handling: renderLinkDetail() in server.js.
  recentClicksFirst: db.prepare(`SELECT id, ts, referrer, device, browser, lang FROM clicks WHERE link_id = ? ORDER BY id DESC LIMIT ?`),
  recentClicksOlder: db.prepare(`SELECT id, ts, referrer, device, browser, lang FROM clicks WHERE link_id = ? AND id < ? ORDER BY id DESC LIMIT ?`),
  recentClicksNewer: db.prepare(`SELECT id, ts, referrer, device, browser, lang FROM clicks WHERE link_id = ? AND id > ? ORDER BY id ASC LIMIT ?`),
};

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Rejection sampling instead of a plain %: 256 isn't a multiple of
// ALPHABET.length, so a modulo would favor the first characters.
const SLUG_MAX_BYTE = 256 - (256 % ALPHABET.length);
function randomSlug(len = 6) {
  let s = '';
  while (s.length < len) {
    for (const b of crypto.randomBytes(len - s.length)) {
      if (b < SLUG_MAX_BYTE) s += ALPHABET[b % ALPHABET.length];
    }
  }
  return s;
}

function createLink({ slug, targetUrl, title, visibility, ownerId, domain, expiresAt }) {
  let finalSlug = (slug || '').trim();
  if (!finalSlug) {
    do { finalSlug = randomSlug(); } while (stmts.slugExists.get(finalSlug));
  } else if (stmts.slugExists.get(finalSlug)) {
    const err = new Error('Slug ist bereits vergeben.');
    err.code = 'SLUG_TAKEN';
    throw err;
  }
  const vis = visibility === 'org' ? 'org' : 'privat';
  const info = stmts.insertLink.run(finalSlug, targetUrl, title || '', vis, ownerId, domain || '', expiresAt || null);
  return stmts.linkById.get(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Bootstrap: create the first admin if no users exist yet
// ---------------------------------------------------------------------------
function bootstrapAdmin({ username, password }) {
  if (stmts.countUsers.get().n > 0) return null;
  const info = stmts.insertUser.run(username, hashPassword(password), 'admin');
  // orphaned links from the single-user version go to the first admin
  db.prepare(`UPDATE links SET owner_id = ? WHERE owner_id IS NULL`).run(info.lastInsertRowid);
  return stmts.userById.get(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// SSO (Authentik/OIDC, see server.js): a first login without an account
// creates a 'member'. password_hash is '' (column is NOT NULL); verifyPassword()
// returns false for it, so password login is locked out for SSO accounts.
// ---------------------------------------------------------------------------
function provisionSsoUser({ subject, preferredUsername }) {
  // Same character set as USERNAME_RE in server.js (not imported: avoids a circular dependency).
  const cleaned = String(preferredUsername || '').trim().replace(/[^A-Za-z0-9\-_.]/g, '').slice(0, 28);
  const base = cleaned.length >= 2 ? cleaned : 'nutzer';
  let candidate = base;
  let suffix = 1;
  while (stmts.userByName.get(candidate)) {
    candidate = `${base}-${++suffix}`.slice(0, 32);
  }
  const info = stmts.insertSsoUser.run(candidate, subject);
  return stmts.userById.get(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Domains: DOMAINS/BASE_URL only seed the first start (like ADMIN_PASSWORD);
// afterwards managed via /app/domains.
// ---------------------------------------------------------------------------
function seedDomainsIfEmpty(origins) {
  if (stmts.listDomains.all().length > 0) return;
  for (const o of origins) {
    if (o && !stmts.domainExists.get(o)) stmts.insertDomain.run(o);
  }
}

// Hand the user's links to `recipientId`, detach their change-log entries and
// delete the account – all or nothing.
const deleteUserAndReassign = db.transaction((userId, recipientId) => {
  stmts.reassignLinks.run(recipientId, userId);
  stmts.clearAuditUser.run(userId);
  stmts.deleteUser.run(userId);
});

module.exports = { stmts, deleteUserAndReassign, createLink, getSessionSecret, getThemeSetting, setThemeSetting, hashPassword, verifyPassword, bootstrapAdmin, provisionSsoUser, seedDomainsIfEmpty };
