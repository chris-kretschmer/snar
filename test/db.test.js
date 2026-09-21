// Database layer: passwords, migrations on the real schema, counters, SSO blocklist, transactions.
// Run with `npm test` (Node's built-in test runner). Each file gets its own temporary data directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snar-db-'));
process.env.DATA_DIR = dir;
delete process.env.SESSION_SECRET;
const db = require('../src/db.js');
const { stmts } = db;

const link = (slug, ownerId = 1) => db.createLink({ slug, targetUrl: 'https://example.org/' + slug, title: '', visibility: 'privat', ownerId, domain: '', expiresAt: null });

test('fresh database is migrated to the latest schema version', () => {
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(dir, 'snar.db'), { readonly: true });
  assert.equal(raw.pragma('user_version', { simple: true }), require('../src/migrations.js').MIGRATIONS.length + 1);
  raw.close();
});

test('password hashes carry their parameters and verify', async () => {
  const hash = await db.hashPasswordAsync('correct horse');
  assert.match(hash, /^scrypt\$32768\$8\$3\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(await db.verifyPasswordAsync('correct horse', hash), true);
  assert.equal(await db.verifyPasswordAsync('wrong', hash), false);
  assert.equal(db.needsRehash(hash), false);
});

test('legacy salt:hash passwords still verify and are marked for re-hashing', async () => {
  const salt = crypto.randomBytes(16);
  const legacy = `${salt.toString('hex')}:${crypto.scryptSync('old-password', salt, 32).toString('hex')}`;
  assert.equal(await db.verifyPasswordAsync('old-password', legacy), true);
  assert.equal(await db.verifyPasswordAsync('nope', legacy), false);
  assert.equal(db.needsRehash(legacy), true);
});

test('accounts without a usable hash never verify (SSO accounts)', async () => {
  for (const stored of ['', null, undefined, 'garbage', 'scrypt$x$y$z$q$r']) {
    assert.equal(await db.verifyPasswordAsync('anything', stored), false);
  }
});

test('SESSION_SECRET is used when set and must be long enough', () => {
  process.env.SESSION_SECRET = 'x'.repeat(40);
  assert.equal(db.getSessionSecret(), 'x'.repeat(40));
  process.env.SESSION_SECRET = 'short';
  assert.throws(() => db.getSessionSecret(), /mindestens 32/);
  delete process.env.SESSION_SECRET;
  assert.match(db.getSessionSecret(), /^[0-9a-f]{64}$/);
});

test('user names are unique regardless of case', () => {
  stmts.insertUser.run('Admin', 'x', 'admin');
  assert.equal(stmts.userByName.get('admin').username, 'Admin');
  assert.throws(() => stmts.insertUser.run('ADMIN', 'x', 'member'), /UNIQUE/);
});

test('links.clicks_total follows inserts, retention deletes and link deletion', () => {
  const l = link('counter-1');
  for (let i = 0; i < 3; i++) stmts.insertClick.run(l.id, '', '', '', '');
  assert.equal(stmts.linkById.get(l.id).clicks_total, 3);
  assert.equal(stmts.linksByOwner.all(1).find((x) => x.id === l.id).clicks_total, 3);
  // age two clicks, then apply the retention rule
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(dir, 'snar.db'));
  raw.prepare(`UPDATE clicks SET ts = datetime('now', '-40 days') WHERE id IN (SELECT id FROM clicks WHERE link_id = ? LIMIT 2)`).run(l.id);
  raw.close();
  assert.equal(db.deleteClicksOlderThanDays(30), 2);
  assert.equal(stmts.linkById.get(l.id).clicks_total, 1);
  stmts.deleteLink.run(l.id); // cascade deletes the click and fires the trigger on a vanishing row
  assert.equal(stmts.linkById.get(l.id), undefined);
});

test('deleting an SSO user blocks the subject until it is released', () => {
  const owner = stmts.userByName.get('Admin');
  const sso = db.provisionSsoUser({ subject: 'sub-123', preferredUsername: 'Clara' });
  db.deleteUserAndReassign(sso.id, owner.id);
  assert.equal(stmts.userBySsoSubject.get('sub-123'), undefined);
  const blocked = stmts.ssoBlockedBySubject.get('sub-123');
  assert.equal(blocked.username, 'Clara');
  const listed = stmts.listSsoBlocked.all();
  assert.equal(listed.length, 1);
  stmts.deleteSsoBlocked.run(listed[0].id);
  assert.equal(stmts.ssoBlockedBySubject.get('sub-123'), undefined);
});

test('a link update and its change-log entry succeed or fail together', () => {
  const l = link('audit-1');
  db.updateLinkWithAudit({ id: l.id, userId: 1, oldUrl: l.target_url, newUrl: 'https://example.org/new', title: 't', visibility: 'privat', domain: '', expiresAt: null });
  assert.equal(stmts.linkById.get(l.id).target_url, 'https://example.org/new');
  assert.equal(stmts.linkAuditByLink.all(l.id).length, 1);
  assert.throws(() => db.updateLinkWithAudit({ id: l.id, userId: 1, oldUrl: 'https://example.org/new', newUrl: 'https://example.org/x', title: {}, visibility: 'privat', domain: '', expiresAt: null }));
  assert.equal(stmts.linkAuditByLink.all(l.id).length, 1, 'no log entry for the failed update');
});

test('domains from the environment are seeded once, not again after deleting them all', () => {
  db.seedDomainsIfEmpty(['https://one.example']);
  assert.equal(stmts.listDomains.all().length, 1);
  const d = stmts.listDomains.all()[0];
  db.deleteDomainAndReassign(d.id, d.origin, '');
  assert.equal(stmts.listDomains.all().length, 0);
  db.seedDomainsIfEmpty(['https://one.example']);
  assert.equal(stmts.listDomains.all().length, 0);
});

test('dbPing answers while the database is open', () => {
  assert.equal(db.dbPing(), true);
});

test('database files are private to the owner', { skip: process.platform === 'win32' }, () => {
  assert.equal(fs.statSync(path.join(dir, 'snar.db')).mode & 0o077, 0);
});

test.after(() => { db.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });
