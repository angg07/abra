import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueSchedules, validSchedules } from '../scheduler.mjs';
import { summary } from '../notify.mjs';

const s = { id: 'morning', enabled: true, time: '07:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], tests: ['checkout'] };
const at = (day, hh, mm) => new Date(2026, 8, day, hh, mm); // Sep 2026: 28 = Monday, 26 = Saturday

test('due at its time on its days, once per day', () => {
  assert.deepEqual(dueSchedules([s], at(28, 6, 59), {}).map(x => x.id), []);            // too early
  assert.deepEqual(dueSchedules([s], at(28, 7, 0), {}).map(x => x.id), ['morning']);     // on time
  assert.deepEqual(dueSchedules([s], at(28, 7, 20), {}).map(x => x.id), ['morning']);    // missed a bit: still runs
  assert.deepEqual(dueSchedules([s], at(28, 7, 45), {}).map(x => x.id), []);             // past the grace window
  assert.deepEqual(dueSchedules([s], at(28, 7, 5), { morning: '2026-09-28' }), []);      // already ran today
  assert.deepEqual(dueSchedules([s], at(26, 7, 0), {}), []);                             // Saturday: not a chosen day
  assert.deepEqual(dueSchedules([{ ...s, enabled: false }], at(28, 7, 0), {}), []);      // switched off
});

test('schedules are validated before saving', () => {
  const exists = (p, n) => p === 'demo' && n === 'checkout';
  assert.equal(validSchedules([{ name: 'Morning run', time: '07:00', days: ['Mon'], project: 'demo', tests: ['checkout'] }], exists)[0].id, 'morning-run');
  assert.throws(() => validSchedules([{ name: 'x', time: '07:00', days: ['Mon'], tests: ['checkout'] }], exists), /Pick a project/);
  assert.throws(() => validSchedules([{ name: 'x', time: '7am', days: ['Mon'], project: 'demo', tests: ['checkout'] }], exists), /HH:MM/);
  assert.throws(() => validSchedules([{ name: 'x', time: '07:00', days: [], project: 'demo', tests: ['checkout'] }], exists), /at least one day/);
  assert.throws(() => validSchedules([{ name: 'x', time: '07:00', days: ['Mon'], project: 'demo', tests: ['gone'] }], exists), /does not exist/);
});

test('notification summary lists failures, flaky tests and app errors', () => {
  const text = summary({ status: 'fail', secs: 42, tests: [
    { title: 'login', status: 'passed' },
    { title: 'claim', status: 'failed', error: 'Error: expect(page).toHaveURL failed\nmore' },
  ], flaky: [{ title: 'login' }], issues: [{ thirdParty: false }, { thirdParty: true }] }, 'Morning');
  assert.match(text, /^❌ Morning: FAILED \(1\/2 tests, 42 s\)/);
  assert.match(text, /• claim: Error: expect\(page\)\.toHaveURL failed$/m);
  assert.match(text, /Flaky: login/);
  assert.match(text, /1 error\(s\) from the application/);
});
