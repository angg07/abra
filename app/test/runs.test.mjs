import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, createPortPool, mcpServerFor, idleToClose, memoryGate } from '../runs.mjs';

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('limiter: a second run waits for free memory; the first always starts; the line re-checks by itself', async () => {
  let room = false;
  const l = createLimiter(2, { roomForMore: () => room, recheckMs: 20 }), reasons = [];
  const r1 = await l.acquire(); // the first run starts even with too little memory
  let started = false;
  const p2 = l.acquire([], (pos, reason) => reasons.push(reason)).then(r => { started = true; return r; });
  await sleep(60);
  assert.deepEqual(reasons, ['memory']);
  assert.equal(started, false);
  room = true;
  await sleep(60); // no slot came back: the periodic check lets it in
  assert.equal(started, true);
  r1(); (await p2)();
  assert.deepEqual(l.stats(), { active: 0, waiting: 0 });
});

test('limiter: when the other run ends, a run waiting for memory starts at once (it is now the first)', async () => {
  const l = createLimiter(2, { roomForMore: () => false, recheckMs: 60_000 });
  const r1 = await l.acquire();
  let started = false;
  const p2 = l.acquire().then(r => { started = true; return r; });
  await tick();
  assert.equal(started, false);
  r1(); await tick();
  assert.equal(started, true);
  (await p2)();
});

test('limiter: a full line says slot, not memory; leaving the line stops the re-check', async () => {
  const l = createLimiter(1, { roomForMore: () => false, recheckMs: 20 }), reasons = [];
  const r1 = await l.acquire();
  const leave = new AbortController();
  const p2 = l.acquire([], (pos, reason) => reasons.push(reason), leave.signal).catch(e => e.message);
  await tick();
  assert.deepEqual(reasons, ['slot']);
  leave.abort();
  assert.equal(await p2, 'left the queue');
  assert.deepEqual(l.stats(), { active: 1, waiting: 0 });
  r1();
});

test('idleToClose with 0 to keep: every finished run that still holds a browser, none that are running', () => {
  const runs = [
    { id: 'a', done: true, doneAt: 2, browser: true },
    { id: 'b', done: false, doneAt: undefined, browser: true },
    { id: 'c', done: true, doneAt: 1, browser: true },
    { id: 'd', done: true, doneAt: 3, browser: false },
  ];
  assert.deepEqual(idleToClose(runs, 0), ['c', 'a']);
});

test('memoryGate: short of memory, it frees finished runs\' browsers and says no; enough memory, yes without closing anything', () => {
  let free = 1000, freed = 0;
  const gate = memoryGate({ freeMB: () => free, minMB: 2500, freeIdle: () => { freed++; free += 1200; }, platform: 'linux' });
  assert.equal(gate(), false); // short: closes the idle browsers, the next re-check will see the memory
  assert.equal(freed, 1);
  free = 3000;
  assert.equal(gate(), true);
  assert.equal(freed, 1); // enough memory: nothing closed
});

test('memoryGate: on macOS free memory reads far too low, so the gate stays open', () => {
  let freed = 0;
  const gate = memoryGate({ freeMB: () => 300, minMB: 2500, freeIdle: () => { freed++; }, platform: 'darwin' });
  assert.equal(gate(), true);
  assert.equal(freed, 0);
});
