import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, createPortPool, mcpServerFor, idleToClose } from '../runs.mjs';

const tick = () => new Promise(r => setImmediate(r));

test('limiter: up to max at once, the rest wait in order', async () => {
  const l = createLimiter(2), order = [], queued = [];
  const r1 = await l.acquire(), r2 = await l.acquire();
  const p3 = l.acquire([], pos => queued.push(pos)).then(r => { order.push(3); return r; });
  const p4 = l.acquire([], pos => queued.push(pos)).then(r => { order.push(4); return r; });
  await tick();
  assert.deepEqual(queued, [1, 2]);
  assert.deepEqual(l.stats(), { active: 2, waiting: 2 });
  r1(); await tick(); assert.deepEqual(order, [3]);
  r2(); await tick(); assert.deepEqual(order, [3, 4]);
  (await p3)(); (await p4)();
  assert.deepEqual(l.stats(), { active: 0, waiting: 0 });
});

test('limiter: a lock key is held by one run; others with different keys pass', async () => {
  const l = createLimiter(5), got = [];
  const a = await l.acquire(['db:x']);
  l.acquire(['db:x']).then(r => { got.push('x2'); r(); });
  l.acquire(['db:y']).then(r => { got.push('y'); r(); });
  await tick();
  assert.deepEqual(got, ['y']); // not stuck behind the waiting db:x run
  a(); await tick();
  assert.deepEqual(got, ['y', 'x2']);
});

test('limiter: leaving the line and releasing twice are safe', async () => {
  const l = createLimiter(1);
  const r1 = await l.acquire();
  const left = new AbortController();
  const p = l.acquire([], () => {}, left.signal);
  left.abort();
  await assert.rejects(p, /left the queue/);
  r1(); r1(); // second call must not free a slot that is not ours
  const r2 = await l.acquire();
  assert.deepEqual(l.stats(), { active: 1, waiting: 0 });
  r2();
});

test('port pool: skips taken and foreign ports, gives them back', async () => {
  const busy = new Set([9401]);
  const pool = createPortPool(9400, 9402, async p => busy.has(p));
  const [a, b] = await Promise.all([pool.take(), pool.take()]);
  assert.deepEqual([a, b], [9400, 9402]);
  await assert.rejects(pool.take(), /No free browser port between 9400 and 9402/);
  pool.give(9400);
  assert.equal(await pool.take(), 9400);
});

test('mcpServerFor: the run gets its own browser port, folder and values', () => {
  const s = mcpServerFor(9405, '/tmp/run-1/mcp', { vars: { appUrl: 'http://myapp.test' }, env: 'e2e', secrets: ['APP_PASS'] });
  assert.deepEqual(s.args, ['mcp-proxy.mjs', '--cdp-endpoint', 'http://127.0.0.1:9405', '--output-dir', '/tmp/run-1/mcp']);
  assert.deepEqual(JSON.parse(s.env.RUN_VARS), { vars: { appUrl: 'http://myapp.test' }, env: 'e2e', secrets: ['APP_PASS'] });
  assert.deepEqual(Object.keys(s.env), ['RUN_VARS']); // written to disk: never secret values or the whole environment
});

test('limiter.run: the slot and its locks come back even when the run throws', async () => {
  const l = createLimiter(1);
  await assert.rejects(l.run(['db:x'], () => {}, undefined, async () => { throw new Error('disk full'); }), /disk full/);
  assert.deepEqual(l.stats(), { active: 0, waiting: 0 });
  assert.equal(await l.run(['db:x'], () => {}, undefined, async () => 'next run'), 'next run'); // lock free again
});

test('idleToClose: only finished runs that still hold an AI browser, oldest finish first', () => {
  const runs = [
    { id: 'ai-long', done: true, doneAt: 30, browser: true },   // started first, finished last
    { id: 'replay-b', done: true, doneAt: 10, browser: false }, // replays hold no browser to save
    { id: 'ai-c', done: true, doneAt: 20, browser: true },
    { id: 'ai-d', done: true, doneAt: 5, browser: true },
    { id: 'ai-running', done: false, browser: true },
  ];
  assert.deepEqual(idleToClose(runs, 2), ['ai-d']);
  assert.deepEqual(idleToClose(runs, 3), []);
});
