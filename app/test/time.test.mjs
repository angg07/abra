// Times as the mockup shows them (app/time.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { when, dur } from '../time.mjs';

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
const now = at(2026, 10, 5, 9, 42); // a Monday
test('when: just now, today, yesterday, this week, this year, other years', () => {
  assert.equal(when(at(2026, 10, 5, 9, 41), now), 'Just now');
  assert.equal(when(at(2026, 10, 5, 8, 5), now), 'Today, 08:05');
  assert.equal(when(at(2026, 10, 4, 23, 59), now), 'Yesterday, 23:59');
  assert.equal(when(at(2026, 10, 1, 14, 51), now), 'Thu, 14:51');
  assert.equal(when(at(2026, 9, 29, 14, 51), now), 'Tue, 14:51'); // 6 days back: still the weekday
  assert.equal(when(at(2026, 9, 28, 14, 51), now), 'Sep 28');
  assert.equal(when(at(2025, 12, 31, 10, 0), now), 'Dec 31, 2025');
  assert.equal(when(undefined, now), '');
});
test('dur: seconds, minutes with two-digit seconds, hours', () => {
  assert.equal(dur(0), '0s'); assert.equal(dur(11), '11s'); assert.equal(dur(112), '1m 52s'); assert.equal(dur(65), '1m 05s'); assert.equal(dur(3725), '1h 02m');
});
