// Launches two headless Chromium browsers: slower than the unit tests (a few seconds)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStage, portAnswers } from '../stage.mjs';
import { createPortPool } from '../runs.mjs';

const viewer = () => { const got = []; return { got, res: { write: c => got.push(String(c)), on() {} } }; };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };

test('two stages run side by side with separate ports, frames and viewers', async () => {
  const ports = createPortPool(9480, 9489, portAnswers);
  const rec = { width: 640, height: 400, highlight: false, a11y: false };
  const a = createStage(ports), b = createStage(ports);
  let pa, pb;
  try {
    [pa, pb] = await Promise.all([a.ownBrowser(rec, null), b.ownBrowser(rec, null)]);
    assert.notEqual(pa, pb);
    assert.equal(await portAnswers(pa), true);
    const va = viewer(), vb = viewer();
    a.addViewer(va.res); b.addViewer(vb.res);
    await until(() => a.currentFrame() && b.currentFrame());
    await until(() => va.got.some(c => c.startsWith('event: frame')) && vb.got.some(c => c.startsWith('event: frame')));
    await b.close(); // closing one run's browser must not touch the other
    assert.equal(await portAnswers(pa), true);
    assert.equal(await portAnswers(pb), false);
  } finally {
    await a.close(); await b.close();
  }
  assert.equal(await portAnswers(pa), false); // closed and given back
});

test('releasePort gives a runner port back to the pool at once, not when the run ends', async () => {
  const given = [];
  const pool = { take: async () => 9555, give: p => given.push(p) };
  const s = createStage(pool);
  const p = await s.reservePort();
  s.releasePort(p);
  assert.deepEqual(given, [9555]);
  await s.close();
  assert.deepEqual(given, [9555]); // not given back twice
});
