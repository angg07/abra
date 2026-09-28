// The app's own database: users, login sessions, project members and run history. One SQLite file
// (app/data/app.db, node:sqlite, no extra dependency); back it up by copying the file.
// Projects themselves stay folders (tests/<project>/project.json) next to their test files.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const dataDir = join(import.meta.dirname, 'data');
mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(process.env.APP_DB ?? join(dataDir, 'app.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');

// Schema versions: add a step, never edit an old one
const MIGRATIONS = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, pass TEXT NOT NULL,
     admin INTEGER NOT NULL DEFAULT 0, must_change INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
     created INTEGER NOT NULL);
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
   CREATE TABLE members (
     project TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('maintainer', 'tester', 'viewer')), PRIMARY KEY (project, user_id));
   CREATE TABLE runs (
     id TEXT PRIMARY KEY, project TEXT, started INTEGER NOT NULL, user_id INTEGER, video TEXT, guide TEXT, data TEXT NOT NULL);
   CREATE INDEX runs_project ON runs (project, started DESC);`,
];
for (let v = db.prepare('PRAGMA user_version').get().user_version; v < MIGRATIONS.length; v++) {
  db.exec('BEGIN'); db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT');
}

// One-time import of the old history.json (not for a separate database, e.g. in unit tests)
const oldHistory = join(dataDir, 'history.json');
if (!process.env.APP_DB && existsSync(oldHistory)) {
  const ins = db.prepare('INSERT OR IGNORE INTO runs (id, project, started, video, guide, data) VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const r of JSON.parse(readFileSync(oldHistory, 'utf8'))) ins.run(r.id, r.project ?? null, r.started, r.video ?? null, r.guide ?? null, JSON.stringify(r));
  db.exec('COMMIT');
  renameSync(oldHistory, `${oldHistory}.imported`);
}

export const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
