// Accounts and permissions. Admins create accounts (no sign-up); a new account must change its password at
// first login. Global role: admin (users, settings, secrets, all projects). Per project: maintainer (project,
// its database, members, deleting tests) > tester (run the AI and tests, save and edit tests) > viewer (results).
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { db } from './store.mjs';

export const ROLES = ['viewer', 'tester', 'maintainer']; // each includes the ones before it
const SESSION_MS = 7 * 24 * 3600_000;

/* ---------- passwords ---------- */
export const hashPassword = (pw, salt = randomBytes(16).toString('hex')) => `scrypt:${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
function passwordMatches(pw, stored) {
  const [, salt, hash] = String(stored).split(':');
  return Boolean(hash) && timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(String(pw), salt, 64));
}
export function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new Error('The password needs at least 10 characters');
  if (pw.length > 200) throw new Error('The password is too long');
}
const DUMMY = hashPassword('timing-only'); // unknown emails take as long as wrong passwords

/* ---------- users ---------- */
const publicUser = u => u && { id: u.id, email: u.email, name: u.name, admin: Boolean(u.admin), mustChange: Boolean(u.must_change), active: Boolean(u.active) };
export const userCount = () => db.prepare('SELECT count(*) AS n FROM users').get().n;
export const listUsers = () => db.prepare('SELECT * FROM users ORDER BY name').all().map(publicUser);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createUser({ email, name, password, admin = false, mustChange = true }) {
  email = String(email ?? '').trim(); name = String(name ?? '').trim();
  if (!EMAIL.test(email)) throw new Error('Enter a valid email address');
  if (!name || name.length > 80) throw new Error('Name: 1 to 80 characters');
  checkNewPassword(password);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new Error(`An account for ${email} already exists`);
  const { lastInsertRowid } = db.prepare('INSERT INTO users (email, name, pass, admin, must_change, created) VALUES (?, ?, ?, ?, ?, ?)')
    .run(email, name, hashPassword(password), admin ? 1 : 0, mustChange ? 1 : 0, Date.now());
  return Number(lastInsertRowid);
}

// admin edits: name, admin flag, active; a new password forces a change at next login and ends their sessions
export function updateUser(id, { name, admin, active, password }, byUserId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new Error('User not found');
  if (id === byUserId && (admin === false || active === false)) throw new Error('You cannot remove your own admin role or deactivate yourself');
  const next = { name: name === undefined ? u.name : String(name).trim(), admin: admin === undefined ? u.admin : admin ? 1 : 0, active: active === undefined ? u.active : active ? 1 : 0 };
  if (!next.name || next.name.length > 80) throw new Error('Name: 1 to 80 characters');
  if (u.admin && (!next.admin || !next.active)) {
    const admins = db.prepare('SELECT count(*) AS n FROM users WHERE admin = 1 AND active = 1').get().n;
    if (admins <= 1) throw new Error('This is the last active admin');
  }
  db.prepare('UPDATE users SET name = ?, admin = ?, active = ? WHERE id = ?').run(next.name, next.admin, next.active, id);
  if (password) {
    checkNewPassword(password);
    db.prepare('UPDATE users SET pass = ?, must_change = 1 WHERE id = ?').run(hashPassword(password), id);
    failures.delete(u.email.toLowerCase()); // a reset by an admin also lifts a lockout
  }
  if (password || !next.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
}

export function changeOwnPassword(userId, current, next) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!passwordMatches(current, u.pass)) throw new Error('The current password is wrong');
  checkNewPassword(next);
  if (next === current) throw new Error('Choose a password different from the current one');
  db.prepare('UPDATE users SET pass = ?, must_change = 0 WHERE id = ?').run(hashPassword(next), userId);
}

/* ---------- login ---------- */
// 5 wrong passwords for an email lock it for 10 minutes (in memory: a restart clears it)
const failures = new Map(); // email -> { count, until }
export function login(email, password) {
  const key = String(email ?? '').trim().toLowerCase();
  const f = failures.get(key);
  if (f?.until > Date.now()) throw new Error(`Too many wrong passwords. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} min.`);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(key);
  const ok = passwordMatches(password ?? '', u?.pass ?? DUMMY) && u?.active;
  if (!ok) {
    const n = (f?.until > Date.now() ? 0 : f?.count ?? 0) + 1;
    failures.set(key, n >= 5 ? { count: 0, until: Date.now() + 10 * 60_000 } : { count: n, until: 0 });
    throw new Error('Wrong email or password');
  }
  failures.delete(key);
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').run(sha(token), u.id, Date.now() + SESSION_MS);
  return { token, maxAge: SESSION_MS / 1000 };
}
const sha = t => createHash('sha256').update(t).digest('hex');
export const logout = token => { if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)); };

// the signed-in user for a session token, with their project roles
export function userOf(token) {
  if (!token) return null;
  const u = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ? AND u.active = 1').get(sha(token), Date.now());
  if (!u) return null;
  const roles = Object.fromEntries(db.prepare('SELECT project, role FROM members WHERE user_id = ?').all(u.id).map(m => [m.project, m.role]));
  return { ...publicUser(u), roles };
}

/* ---------- permissions ---------- */
export const roleIn = (user, project) => (user?.admin ? 'maintainer' : user?.roles?.[project]);
export const can = (user, project, need) => { const r = roleIn(user, project); return Boolean(r) && ROLES.indexOf(r) >= ROLES.indexOf(need); };
export const visibleProjects = (user, all) => (user?.admin ? all : all.filter(id => user?.roles?.[id]));

/* ---------- members ---------- */
export const listMembers = project => db.prepare('SELECT u.id, u.name, u.email, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.project = ? ORDER BY u.name').all(project);
export function setMember(project, userId, role) {
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new Error('User not found');
  if (role === null) return void db.prepare('DELETE FROM members WHERE project = ? AND user_id = ?').run(project, userId);
  if (!ROLES.includes(role)) throw new Error('Role must be maintainer, tester or viewer');
  db.prepare('INSERT INTO members (project, user_id, role) VALUES (?, ?, ?) ON CONFLICT (project, user_id) DO UPDATE SET role = excluded.role').run(project, userId, role);
}
export const dropProjectMembers = project => db.prepare('DELETE FROM members WHERE project = ?').run(project);
