// Schema migrations for the SQLite database.
//
// The CREATE TABLE block in db.js is the frozen baseline (schema version 1). Every later change to
// the schema, such as a new column or table, is a numbered step in MIGRATIONS below and nothing else:
// new installations run the steps too, so a fresh and an upgraded database always end up identical.
// The applied version lives in the database itself (PRAGMA user_version).
//
// Adding a step: append { version: <last + 1>, name, up(db) } to MIGRATIONS. up() gets the open
// database and runs inside a transaction together with the version bump, so a failing step leaves the
// database untouched. Never edit or remove a step that has been released.
//
//   { version: 2, name: 'links.note', up: (db) => db.exec('ALTER TABLE links ADD COLUMN note TEXT') },

const path = require('path');

const BASE_VERSION = 1;
const MIGRATIONS = [];

const pad = (n) => String(n).padStart(2, '0');
function timestamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function hasData(db) {
  try { return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0; } catch { return false; }
}

// Brings the database to the latest version. Returns { from, to, applied, backup }.
function migrate(db, { migrations = MIGRATIONS, baseVersion = BASE_VERSION, dataDir = null, log = console.log } = {}) {
  const steps = [...migrations].sort((a, b) => a.version - b.version);
  steps.forEach((m, i) => {
    if (m.version !== baseVersion + 1 + i) {
      throw new Error(`Migrationen müssen lückenlos nummeriert sein (erwartet ${baseVersion + 1 + i}, gefunden ${m.version}).`);
    }
  });
  const latest = baseVersion + steps.length;

  let current = db.pragma('user_version', { simple: true });
  if (current > latest) {
    throw new Error(`Die Datenbank hat Schema-Version ${current}, diese snar-Version kennt nur bis ${latest}. `
      + 'Bitte snar auf die aktuelle Version bringen (ein Downgrade wird nicht unterstützt).');
  }
  if (current < baseVersion) { // fresh database, or one created before versions existed: the baseline schema is in place
    db.pragma(`user_version = ${baseVersion}`);
    current = baseVersion;
  }

  const pending = steps.filter((m) => m.version > current);
  const result = { from: current, to: latest, applied: [], backup: null };
  if (!pending.length) return result;

  // Existing data: keep a consistent copy next to the database before touching the schema.
  if (dataDir && hasData(db)) {
    const file = path.join(dataDir, `snar-vor-migration-v${current}-${timestamp()}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    result.backup = file;
    log(`Datenbank-Sicherung vor der Migration: ${file}`);
  }

  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    })();
    result.applied.push(m.version);
    log(`Datenbank migriert auf Schema-Version ${m.version} (${m.name}).`);
  }
  return result;
}

module.exports = { migrate, MIGRATIONS, BASE_VERSION };
