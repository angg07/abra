// A step's time since the run started (app/steps.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stamp } from '../steps.mjs';

test('stamp adds seconds since the start, one decimal, and keeps the step', () => {
  assert.deepEqual(stamp({ name: 'x' }, 1000, 3460), { name: 'x', at: 2.5 });
  assert.equal(stamp({}, 5000, 4000).at, 0); // a clock that went back never gives a negative time
});
