// Run history: a run still marked running is hidden, and becomes "interrupted" when the app starts again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.APP_DB = join(mkdtempSync(join(tmpdir(), 'abr-hist-')), 'app.db'); // before the store opens the database
const { addRun, listRuns, getRun, markInterrupted, INTERRUPTED } = await import('../history.mjs');

test('a running run is hidden from History, then marked interrupted once when the app starts again', () => {
  addRun({ id: 'r-live', kind: 'ai', started: 2, project: 'p', status: 'running', task: 'Create a policy' });
  addRun({ id: 'r-done', kind: 'ai', started: 1, project: 'p', status: 'pass', task: 'Log in' });
  assert.deepEqual(listRuns('p').map(r => r.id), ['r-done']);
  assert.deepEqual(markInterrupted(), ['r-live']);
  const r = getRun('r-live');
  assert.equal(r.status, 'interrupted');
  assert.equal(r.error, INTERRUPTED);
  assert.equal(r.task, 'Create a policy');
  assert.equal(getRun('r-done').status, 'pass');
  assert.deepEqual(listRuns('p').map(r => r.id), ['r-live', 'r-done']);
  assert.deepEqual(markInterrupted(), []); // nothing left to mark
});

test('a run that finishes replaces its running entry under the same id', () => {
  addRun({ id: 'r-ok', kind: 'replay', started: 3, project: 'q', status: 'running', task: 'Suite' });
  addRun({ id: 'r-ok', kind: 'replay', started: 3, project: 'q', status: 'pass', task: 'Suite' });
  assert.deepEqual(listRuns('q').map(r => [r.id, r.status]), [['r-ok', 'pass']]);
});
