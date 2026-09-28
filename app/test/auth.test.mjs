import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.APP_DB = ':memory:';
const auth = await import('../auth.mjs');
const { addRun, listRuns } = await import('../history.mjs');

const admin = auth.createUser({ email: 'Admin@x.id', name: 'Admin', password: 'correct horse 1', admin: true });
const tina = auth.createUser({ email: 'tina@x.id', name: 'Tina', password: 'tester password' });

test('login: right password gives a session; wrong ones lock after 5 tries', () => {
  const { token } = auth.login('admin@X.id', 'correct horse 1'); // email is case-insensitive
  assert.equal(auth.userOf(token).admin, true);
  auth.logout(token);
  assert.equal(auth.userOf(token), null);
  for (let i = 0; i < 5; i++) assert.throws(() => auth.login('tina@x.id', 'nope'), /Wrong email or password/);
  assert.throws(() => auth.login('tina@x.id', 'tester password'), /Too many wrong passwords/);
  assert.throws(() => auth.login('ghost@x.id', 'whatever'), /Wrong email or password/); // same answer for unknown emails
});

test('roles: admin can all; members only in their project, by rank', () => {
  auth.setMember('shop', tina, 'tester');
  const { token } = (() => { auth.updateUser(tina, { password: 'a new password 2' }, admin); return auth.login('Tina@x.id', 'a new password 2'); })();
  const t = auth.userOf(token), a = { admin: true, roles: {} };
  assert.equal(t.mustChange, true); // admin set the password: she must choose her own
  assert.equal(auth.can(t, 'shop', 'tester'), true);
  assert.equal(auth.can(t, 'shop', 'maintainer'), false);
  assert.equal(auth.can(t, 'crm', 'viewer'), false);
  assert.equal(auth.can(a, 'crm', 'maintainer'), true);
  assert.deepEqual(auth.visibleProjects(t, ['crm', 'shop']), ['shop']);
});

test('the last admin cannot be demoted, nor can admins demote themselves', () => {
  assert.throws(() => auth.updateUser(admin, { admin: false }, admin), /your own admin role/);
  assert.throws(() => auth.updateUser(admin, { active: false }, tina), /last active admin/);
});

test('history lists only the projects asked for; an empty list shows nothing', () => {
  addRun({ id: 'r1', project: 'shop', started: 1, userId: tina, kind: 'ai', steps: [1] });
  addRun({ id: 'r2', project: 'crm', started: 2, kind: 'replay' });
  assert.deepEqual(listRuns(['shop']).map(r => [r.id, r.by, r.steps]), [['r1', 'Tina', undefined]]);
  assert.deepEqual(listRuns([]), []);
  assert.equal(listRuns().length, 2);
});
