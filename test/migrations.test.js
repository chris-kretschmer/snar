// The migration runner itself, with synthetic steps on small databases.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { migrate, MIGRATIONS, BASE_VERSION } = require('../src/migrations.js');

const quiet = () => {};
const version = (db) => db.pragma('user_version', { simple: true });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'snar-mig-'));
const seed = (db) => {
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); CREATE TABLE links (id INTEGER PRIMARY KEY, slug TEXT)');
  db.exec("INSERT INTO users (username) VALUES ('admin'); INSERT INTO links (slug) VALUES ('abc')");
};
const steps = [
  { version: 2, name: 'links.note', up: (db) => db.exec('ALTER TABLE links ADD COLUMN note TEXT') },
  { version: 3, name: 'tags table', up: (db) => db.exec('CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT)') },
];

test('the released steps are numbered without gaps', () => {
  MIGRATIONS.forEach((m, i) => assert.equal(m.version, BASE_VERSION + 1 + i));
});

test('a database without a version is stamped with the baseline', () => {
  const db = new Database(':memory:'); seed(db);
  const r = migrate(db, { migrations: [], log: quiet });
  assert.equal(version(db), BASE_VERSION);
  assert.deepEqual(r.applied, []);
});

test('pending steps run in order, after a backup that holds the old state', () => {
  const dir = tmp();
  const db = new Database(path.join(dir, 'snar.db')); seed(db); db.pragma(`user_version = ${BASE_VERSION}`);
  const r = migrate(db, { migrations: steps, dataDir: dir, log: quiet });
  assert.equal(version(db), 3);
  assert.deepEqual(r.applied, [2, 3]);
  assert.equal(db.prepare('SELECT slug, note FROM links').get().slug, 'abc');
  const backup = fs.readdirSync(dir).find((f) => f.startsWith('snar-vor-migration-v1-'));
  assert.ok(backup);
  const b = new Database(path.join(dir, backup), { readonly: true });
  assert.equal(b.prepare('SELECT COUNT(*) n FROM links').get().n, 1);
  assert.ok(!b.prepare('PRAGMA table_info(links)').all().some((c) => c.name === 'note'));
  b.close();
  assert.deepEqual(migrate(db, { migrations: steps, dataDir: dir, log: quiet }).applied, [], 'second run does nothing');
});

test('a failing step is rolled back, earlier steps stay, a fixed step continues', () => {
  const dir = tmp();
  const db = new Database(path.join(dir, 'snar.db')); seed(db); db.pragma(`user_version = ${BASE_VERSION}`);
  const broken = [steps[0], { version: 3, name: 'broken', up: (d) => { d.exec('CREATE TABLE half (id INTEGER)'); throw new Error('boom'); } }];
  assert.throws(() => migrate(db, { migrations: broken, dataDir: dir, log: quiet }), /boom/);
  assert.equal(version(db), 2);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get(), undefined);
  assert.deepEqual(migrate(db, { migrations: steps, dataDir: dir, log: quiet }).applied, [3]);
});

test('an empty database is migrated without a backup file', () => {
  const dir = tmp();
  const db = new Database(path.join(dir, 'snar.db'));
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); CREATE TABLE links (id INTEGER PRIMARY KEY, slug TEXT)');
  db.pragma(`user_version = ${BASE_VERSION}`);
  migrate(db, { migrations: steps, dataDir: dir, log: quiet });
  assert.ok(fs.readdirSync(dir).every((f) => !f.startsWith('snar-vor')));
});

test('a database from a newer version is refused, gaps and duplicates are rejected', () => {
  const db = new Database(':memory:'); seed(db); db.pragma('user_version = 99');
  assert.throws(() => migrate(db, { migrations: steps, log: quiet }), /Schema-Version 99/);
  assert.equal(version(db), 99);
  assert.throws(() => migrate(new Database(':memory:'), { migrations: [steps[0], { version: 4, name: 'gap', up() {} }], log: quiet }), /lückenlos/);
  assert.throws(() => migrate(new Database(':memory:'), { migrations: [steps[0], steps[0]], log: quiet }), /lückenlos/);
});

test('the case-insensitive user name step keeps going (with a warning) when duplicates already exist', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE); INSERT INTO users (username) VALUES ('Admin'), ('admin')");
  const step = MIGRATIONS.find((m) => m.name.startsWith('users.username'));
  const logs = [];
  step.up(db, { log: (m) => logs.push(m) });
  assert.match(logs[0], /Groß-\/Kleinschreibung/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_users_username_nocase'").get(), undefined);
});
