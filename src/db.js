const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

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
  sso_subject   TEXT  -- Authentik's stable "sub" claim; NULL = local account. Uniqueness via idx_users_sso_subject (SQLite doesn't allow UNIQUE directly on ALTER TABLE ADD COLUMN, see migration below)
);

CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT UNIQUE NOT NULL,
  target_url TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'privat',     -- 'privat' | 'org'
  owner_id   INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
-- Dashboard/personal vault filter by owner_id, shared vault by visibility –
-- without an index this would be a full table scan over links on every request.
CREATE INDEX IF NOT EXISTS idx_links_owner ON links(owner_id);
CREATE INDEX IF NOT EXISTS idx_links_visibility ON links(visibility);

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

{
  const cols = db.prepare(`PRAGMA table_info(links)`).all().map(c => c.name);
  if (!cols.includes('visibility')) {
    db.exec(`ALTER TABLE links ADD COLUMN visibility TEXT NOT NULL DEFAULT 'privat'`);
  }
  if (!cols.includes('owner_id')) {
    db.exec(`ALTER TABLE links ADD COLUMN owner_id INTEGER REFERENCES users(id)`);
  }
  if (!cols.includes('domain')) {
    db.exec(`ALTER TABLE links ADD COLUMN domain TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.includes('expires_at')) {
    // NULL = never expires. Same format as other timestamps: 'YYYY-MM-DD HH:MM:SS', UTC.
    db.exec(`ALTER TABLE links ADD COLUMN expires_at TEXT`);
  }
  // old "oeffentlich" (public) links become org links in the vault
  db.exec(`UPDATE links SET visibility = 'org' WHERE visibility = 'oeffentlich'`);

  // Session invalidation on password change (existing databases)
  const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
  if (!userCols.includes('token_version')) {
    db.exec(`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0`);
  }
  if (!userCols.includes('last_login_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN last_login_at TEXT`);
  }
  // SSO login (Authentik/OIDC, see server.js) – separate unique index instead
  // of an inline UNIQUE on the column definition, because SQLite doesn't
  // allow "ALTER TABLE ADD COLUMN ... UNIQUE". A unique index still allows
  // any number of NULLs (local accounts without an SSO link).
  if (!userCols.includes('sso_subject')) {
    db.exec(`ALTER TABLE users ADD COLUMN sso_subject TEXT`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso_subject ON users(sso_subject)`);

  // "Set as default" for domains (existing databases)
  const domainCols = db.prepare(`PRAGMA table_info(domains)`).all().map(c => c.name);
  if (!domainCols.includes('sort_order')) {
    db.exec(`ALTER TABLE domains ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
  }
}

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
// Passwords: scrypt (Node built-in, no bcrypt package needed)
// ---------------------------------------------------------------------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

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
  linksByOwner: db.prepare(`
    SELECT l.*, u.username AS owner_name, COUNT(c.id) AS clicks_total
    FROM links l
    LEFT JOIN users u ON u.id = l.owner_id
    LEFT JOIN clicks c ON c.link_id = l.id
    WHERE l.owner_id = ? GROUP BY l.id ORDER BY l.created_at DESC
  `),
  // Personal vault: only the user's own links with visibility "privat"
  // (the dashboard/"create" view still shows all of the user's own links,
  // including org links).
  linksByOwnerPrivate: db.prepare(`
    SELECT l.*, u.username AS owner_name, COUNT(c.id) AS clicks_total
    FROM links l
    LEFT JOIN users u ON u.id = l.owner_id
    LEFT JOIN clicks c ON c.link_id = l.id
    WHERE l.owner_id = ? AND l.visibility = 'privat' GROUP BY l.id ORDER BY l.created_at DESC
  `),
  // Same click JOIN as linksByOwner: any member may open an org link and see
  // its full stats via "Details" (see canManage in server.js), so the total
  // click count already belongs in the vault overview.
  vaultLinks: db.prepare(`
    SELECT l.*, u.username AS owner_name, COUNT(c.id) AS clicks_total
    FROM links l
    LEFT JOIN users u ON u.id = l.owner_id
    LEFT JOIN clicks c ON c.link_id = l.id
    WHERE l.visibility = 'org'
    GROUP BY l.id
    ORDER BY l.title COLLATE NOCASE, l.slug
  `),

  // Domains (manageable under /app/domains, admin-only). sort_order first,
  // id as a tiebreaker (stable order among equal sort_order, e.g. all left
  // at 0) – the lowest sort_order is the default domain.
  listDomains: db.prepare(`
    SELECT d.*, COUNT(l.id) AS links_count
    FROM domains d LEFT JOIN links l ON l.domain = d.origin
    GROUP BY d.id ORDER BY d.sort_order ASC, d.id ASC
  `),
  domainById: db.prepare(`SELECT * FROM domains WHERE id = ?`),
  domainExists: db.prepare(`SELECT 1 FROM domains WHERE origin = ?`),
  insertDomain: db.prepare(`INSERT INTO domains (origin) VALUES (?)`),
  deleteDomain: db.prepare(`DELETE FROM domains WHERE id = ?`),
  // Sets sort_order strictly below the current minimum – this guarantees the
  // domain ends up first, no matter how often it's repeated.
  setDefaultDomain: db.prepare(`UPDATE domains SET sort_order = (SELECT MIN(sort_order) - 1 FROM domains) WHERE id = ?`),
  reassignLinkDomain: db.prepare(`UPDATE links SET domain = ? WHERE domain = ?`),

  insertClick: db.prepare(`INSERT INTO clicks (link_id, referrer, device, browser, lang) VALUES (?, ?, ?, ?, ?)`),
  clicksTotal: db.prepare(`SELECT COUNT(*) AS n FROM clicks WHERE link_id = ?`),
  // Time-range buckets in server local time ('localtime' = OS timezone, set
  // in the container via TZ + tzdata): storage stays UTC, but hours/days/
  // months should cut where users actually experience the day – otherwise
  // "today" would start at 1 or 2 a.m. The window boundaries are aligned to
  // day/month precision (start of day/month, then back to UTC for comparing
  // against ts).
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
  topReferrers: db.prepare(`
    SELECT CASE WHEN referrer = '' THEN '(direkt / QR-Scan)' ELSE referrer END AS ref, COUNT(*) AS n
    FROM clicks WHERE link_id = ? GROUP BY ref ORDER BY n DESC LIMIT 8
  `),
  deviceSplit: db.prepare(`SELECT device, COUNT(*) AS n FROM clicks WHERE link_id = ? GROUP BY device ORDER BY n DESC`),
  browserSplit: db.prepare(`SELECT browser, COUNT(*) AS n FROM clicks WHERE link_id = ? GROUP BY browser ORDER BY n DESC LIMIT 8`),
  recentClicks: db.prepare(`SELECT ts, referrer, device, browser, lang FROM clicks WHERE link_id = ? ORDER BY ts DESC LIMIT 25`),
};

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Rejection sampling instead of a plain %: 256 isn't a multiple of
// ALPHABET.length, so a byte modulo would slightly favor the alphabet's
// first characters. Bytes at or above MAX_BYTE (the largest multiple of the
// alphabet length under 256) are discarded and redrawn, so every character
// is exactly equally likely.
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
  // assign orphaned links from the single-user version to the first admin
  db.prepare(`UPDATE links SET owner_id = ? WHERE owner_id IS NULL`).run(info.lastInsertRowid);
  return stmts.userById.get(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// SSO (Authentik/OIDC, see server.js): a person's first successful login
// without an existing account automatically creates a 'member' account.
// password_hash is deliberately left as an empty string rather than NULL
// (the column is NOT NULL) – verifyPassword() correctly returns false for
// that already (not a valid "salt:hash" pair), so password login is
// automatically locked out for SSO accounts, with no special-case code
// needed elsewhere.
// ---------------------------------------------------------------------------
function provisionSsoUser({ subject, preferredUsername }) {
  // Same character set as USERNAME_RE in server.js (not imported here, to
  // avoid reversing the db.js -> server.js dependency direction).
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
// Domains: DOMAINS/BASE_URL only take effect on the very first start as the
// initial stock (like ADMIN_PASSWORD) – management afterwards happens via
// /app/domains.
// ---------------------------------------------------------------------------
function seedDomainsIfEmpty(origins) {
  if (stmts.listDomains.all().length > 0) return;
  for (const o of origins) {
    if (o && !stmts.domainExists.get(o)) stmts.insertDomain.run(o);
  }
}

module.exports = { db, stmts, createLink, getSessionSecret, hashPassword, verifyPassword, bootstrapAdmin, provisionSsoUser, seedDomainsIfEmpty };
