# Parallel Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Several runs (AI runs, replays, fixes, workflows) can go at the same time, each in its own browser, instead of all users waiting in one line.

**Architecture:** Today `app/stage.mjs` is one module-level "stage" (one browser, one live view, fixed CDP ports 9333/9334), and `app/server.mjs` lets one run go at a time (`takeTurn`/`releaseTurn`). We turn the stage into a factory (`createStage()`, one per run), give each run its own CDP port from a pool, its own MCP config and output folder, its own replay output folder, and replace the one-at-a-time line with a limiter: up to `MAX_RUNS` runs at once, plus a lock so two runs never reset the same test database at the same time. Live view, Stop and "Save login session" address a run by its id.

**Tech Stack:** Node 24 (ESM, `node:test`), `playwright-core` (CDP), `@playwright/test` runner, `@playwright/mcp` behind `app/mcp-proxy.mjs`, `@modelcontextprotocol/sdk`, plain browser JS UI (`app/app.js`).

**Spec:** No separate spec file. The requirement comes from the conversation of 2026-09-28: "run paralel: satu browser per run dengan port dinamis". This plan is the spec. Current limits it removes: `app/server.mjs:296-313` (one line for everything) and `app/stage.mjs:11-12` (fixed ports).

## Global Constraints

- No new npm dependencies.
- `MAX_RUNS` (environment variable, default `2`, minimum `1`) caps runs going at once; the rest wait in line (FIFO) exactly as today, with the `queued` SSE event and its `position`.
- CDP ports for run browsers come from `9400`–`9499`. A port that answers `http://127.0.0.1:<port>/json/version` belongs to someone else and is never used.
- A run's secrets must never reach another run: no shared `app/data/run-vars.json` any more.
- Two runs that reset the same database (`project.json` `db.<env>.reset: true`, same host/port/database) never run at the same time.
- Code style: match the surrounding code (short functions, one-line `//` comments that say why, `ponytail:` comment for deliberate shortcuts with their ceiling).
- Unit tests: `node --test app/test/*.test.mjs` (script `npm run test:app`). **Never use `npm test`: it runs the Playwright E2E suite against real apps.**

## Review Focus

1. **A secret of project A shows up in project B's run.** Two AI runs of different projects start within the same second; each MCP proxy must only fill in and mask its own project's secrets. Test: Task 3 (`mcpServerFor` puts the run's vars in the run's own config; proxy reads only `RUN_VARS`).
2. **"Save login session" saves another project's login.** Today `POST /sessions` saves whatever AI browser is open, whichever project it belongs to. After this change it must save the browser of the run id given, and only if that run belongs to the same project. Test: Task 5, step "session guard".
3. **Two replays wipe each other's results.** Playwright empties its `outputDir` when it starts; with one shared `app/data/replay-results`, a second replay deletes the first one's screenshots. Test: Task 4 (two `runTests` at once, both reports and output folders intact).
4. **The client leaves while waiting in line, or the run crashes.** The slot and database lock must be released in every case, or the line blocks forever. Test: Task 1 (`acquire` rejects on abort, release is idempotent) and Task 5 (`withRun` releases in `finally`).
5. **Idle AI browsers pile up.** Each finished AI run keeps its browser 5 minutes for "Save login session"; ten quick runs would keep ten browsers (~300 MB each). At most `MAX_RUNS` finished browsers stay open; older ones close. Test: Task 5, step "idle trim".

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `app/runs.mjs` | Create | Pure logic: `createLimiter` (slots + locks + FIFO), `createPortPool`, `mcpServerFor` |
| `app/test/runs.test.mjs` | Create | Unit tests for `app/runs.mjs` |
| `app/stage.mjs` | Modify | `createStage(ports)` factory; module-level state moves inside it |
| `app/test/stage.integration.test.mjs` | Create | Two stages at once keep separate frames and viewers (launches Chromium) |
| `app/mcp-proxy.mjs` | Modify | Read the run's values from `RUN_VARS` env, not a shared file |
| `app/agents.mjs` | Modify | `openaiCompatible`: keep the default environment when a server brings `env` |
| `app/replay.mjs`, `app/replay.config.ts` | Modify | Per-run CDP port and output folder |
| `app/test/replay.integration.test.mjs` | Create | Two replays at once, separate output |
| `app/server.mjs` | Modify | Limiter instead of `takeTurn`; one stage per run in `active`; `/screen`, `/stop`, `/sessions` by run id |
| `app/app.js` | Modify | Live view per run id; Stop and Save session send the run id |
| `README.md` | Modify | `MAX_RUNS` and what runs in parallel |
| `app/mcp.json` | Delete | Replaced by per-run config from `mcpServerFor` |

---

### Task 1: Limiter, port pool and MCP config builder (`app/runs.mjs`)

**Files:**
- Create: `app/runs.mjs`
- Test: `app/test/runs.test.mjs`

**Interfaces:**
- Produces:
  - `createLimiter(max: number) → { acquire(keys?: string[], onQueued?: (position: number) => void, signal?: AbortSignal): Promise<release: () => void>, stats(): { active: number, waiting: number } }`
  - `createPortPool(from: number, to: number, inUseElsewhere: (port) => Promise<boolean>) → { take(): Promise<number>, give(port: number): void }`
  - `mcpServerFor(port: number, outputDir: string, runVars: { vars, env, secrets }) → { command: 'node', args: string[], env: { RUN_VARS: string } }`

- [ ] **Step 1: Write the failing tests**

```js
// app/test/runs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, createPortPool, mcpServerFor } from '../runs.mjs';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test app/test/runs.test.mjs`
Expected: FAIL, `Cannot find module '.../app/runs.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// app/runs.mjs
// Parallel runs: a fixed number of slots, a FIFO line, and locks for what two runs must not share
// (a test database that is reset before each run). Pure logic; the server wires it to requests.

// Invariant: after every change no waiting run fits, so a new run may start whenever it fits itself.
export function createLimiter(max) {
  let active = 0;
  const held = new Set(), waiting = [];
  const fits = keys => active < max && keys.every(k => !held.has(k));
  const take = keys => {
    active++; for (const k of keys) held.add(k);
    let done = false;
    return () => { if (done) return; done = true; active--; for (const k of keys) held.delete(k); pump(); };
  };
  function pump() {
    for (let i = 0; i < waiting.length; i++) {
      if (!fits(waiting[i].keys)) continue; // a locked run does not block the ones behind it
      const [w] = waiting.splice(i--, 1);
      w.resolve(take(w.keys));
    }
  }
  return {
    acquire(keys = [], onQueued = () => {}, signal) {
      if (fits(keys)) return Promise.resolve(take(keys));
      return new Promise((resolve, reject) => {
        const w = { keys, resolve };
        waiting.push(w);
        onQueued(waiting.length);
        signal?.addEventListener('abort', () => {
          const i = waiting.indexOf(w);
          if (i >= 0) { waiting.splice(i, 1); reject(new Error('left the queue')); }
        });
      });
    },
    stats: () => ({ active, waiting: waiting.length }),
  };
}

// Browser debugging ports for runs. A port is marked taken before the async check, so two runs never get the same one.
export function createPortPool(from, to, inUseElsewhere) {
  const taken = new Set();
  return {
    async take() {
      for (let p = from; p <= to; p++) {
        if (taken.has(p)) continue;
        taken.add(p);
        if (await inUseElsewhere(p)) { taken.delete(p); continue; } // another program's browser: never drive it
        return p;
      }
      throw new Error(`No free browser port between ${from} and ${to}`);
    },
    give(p) { taken.delete(p); },
  };
}

// The MCP server of one AI run: its own browser, output folder and test values. RUN_VARS holds names and
// environment values only; the proxy reads secret values from .env itself.
export const mcpServerFor = (port, outputDir, runVars) => ({
  command: 'node',
  args: ['mcp-proxy.mjs', '--cdp-endpoint', `http://127.0.0.1:${port}`, '--output-dir', outputDir],
  env: { RUN_VARS: JSON.stringify(runVars) },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test app/test/runs.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add app/runs.mjs app/test/runs.test.mjs
git commit -m "Run limiter, browser port pool and per-run MCP config (not wired yet)"
```

---

### Task 2: One stage per run (`createStage` in `app/stage.mjs`)

**Files:**
- Modify: `app/stage.mjs` (whole file; line numbers below are today's)
- Modify: `app/server.mjs:7` import and every `stage.` call (temporary single stage, see Step 5)
- Test: `app/test/stage.integration.test.mjs`

**Interfaces:**
- Consumes: `createPortPool` from Task 1.
- Produces: `createStage(ports) → { addViewer(res), currentFrame(), onHighlight(fn), onIssue(fn), ownBrowser(rec, session) → Promise<port>, reservePort() → Promise<port>, watchReplayBrowser(port, rec, signal), saveSession(), startRecording(file, rec), closeWhenIdle(after?: () => void), close() }`; also exported: `HIGHLIGHT_SOURCE`, `portAnswers(port) → Promise<boolean>`.
- Removed exports: `CDP_PORT`, `REPLAY_CDP_PORT`, `broadcast`, `setAudience`, `claimPort`, `shutdown`, module-level `currentFrame`/`addViewer`/`onIssue`/`onHighlight`/`ownBrowser`/`watchReplayBrowser`/`saveSession`/`startRecording`/`closeWhenIdle`.

- [ ] **Step 1: Write the failing integration test**

```js
// app/test/stage.integration.test.mjs
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
  try {
    const [pa, pb] = await Promise.all([a.ownBrowser(rec, null), b.ownBrowser(rec, null)]);
    assert.notEqual(pa, pb);
    assert.equal(await portAnswers(pa), true);
    const va = viewer(), vb = viewer();
    a.addViewer(va.res); b.addViewer(vb.res);
    await until(() => a.currentFrame() && b.currentFrame());
    await until(() => va.got.some(c => c.startsWith('event: frame')) && vb.got.some(c => c.startsWith('event: frame')));
    await b.close(); // closing one run's browser must not touch the other
    const before = va.got.length;
    assert.equal(await portAnswers(pa), true);
    assert.equal(await portAnswers(pb), false);
    assert.ok(va.got.length >= before);
  } finally {
    await a.close(); await b.close();
  }
  assert.equal(await portAnswers(pa), false); // closed and given back
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test app/test/stage.integration.test.mjs`
Expected: FAIL, `createStage` / `portAnswers` is not exported

- [ ] **Step 3: Rewrite `app/stage.mjs` as a factory**

Keep lines 1-10 (header comment, imports), replacing line 1-3 comment with:

```js
// A "stage" is one run's browser, streamed to the UI (CDP screencast) and optionally recorded. Each run has
// its own stage (createStage), so runs can go side by side. Two sources: our own browser for AI runs
// (Playwright MCP drives it over CDP), or the Playwright test runner's browser for replays (we attach over CDP).
```

Delete lines 11-38 (fixed ports, module-level `viewers`/`last`/`audience`, `broadcast`, `currentFrame`, `setAudience`, `addViewer`).

Keep unchanged at module level: `highlighter` + `HIGHLIGHT_SOURCE` (lines 40-137), axe loading (151-156), `hostOf` (146), `IDLE_CLOSE_MS` (246). Export `portAnswers` (line 259) by changing `const portAnswers =` to `export const portAnswers =`.

Delete the module-level `highlightListeners`/`onHighlight` (140-141), `issueListeners`/`onIssue` (144-145), `context`/`attached` (148-149), `idleTimer`/`closeWhenIdle`/`closeAll` (247-255), `claimPort` (260-263), and the module-level functions `ownBrowser`, `watchReplayBrowser`, `saveSession`, `shutdown`, `startRecording` (266-338); they move into the factory below.

Add, after `IDLE_CLOSE_MS`:

```js
export function createStage(ports) {
  const viewers = new Set();
  const last = {}; // replayed to viewers who connect mid-run
  const highlightListeners = new Set(); // guide collectors: the frame that shows a freshly drawn box
  const issueListeners = new Set();     // console errors, exceptions, HTTP >= 400, failed requests
  const held = new Set();               // CDP ports this stage took from the pool
  let context;  // our own browser (AI runs); kept open after a run so its login session can be saved
  let attached; // CDP connection to the test runner's browser (replays)
  let idleTimer;

  const send = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (type, data) => { last[type] = data; for (const res of viewers) send(res, type, data); };

  async function reservePort() { const p = await ports.take(); held.add(p); return p; }
  async function closeAll() {
    clearTimeout(idleTimer);
    await attached?.close().catch(() => {}); attached = null;
    await context?.close().catch(() => {}); context = null;
    for (const p of held) ports.give(p);
    held.clear();
    delete last.frame; // don't record/show the previous browser's last frame
  }

  // castPages: paste today's function body from lines 158-243 here UNCHANGED. It now closes over this
  // stage's broadcast, last, highlightListeners and issueListeners instead of the module-level ones.
  function castPages(ctx, { width, height, highlight, a11y }) { /* lines 159-242 of today's file */ }

  return {
    addViewer(res) { viewers.add(res); for (const [type, data] of Object.entries(last)) send(res, type, data); res.on('close', () => viewers.delete(res)); },
    currentFrame: () => last.frame,
    onHighlight(fn) { highlightListeners.add(fn); return () => highlightListeners.delete(fn); },
    onIssue(fn) { issueListeners.add(fn); return () => issueListeners.delete(fn); },
    reservePort,

    // Fresh browser for an AI run so state never leaks between runs, optionally seeded with a saved login session
    async ownBrowser({ width, height, highlight, device, a11y }, session) {
      await closeAll();
      const port = await reservePort();
      const ctx = context = await chromium.launchPersistentContext('', {
        headless: true,
        // same user agent as replays: the default "HeadlessChrome" one is blocked by anti-bot middleware (403 "Access Denied")
        userAgent: devices['Desktop Chrome'].userAgent,
        // a device profile brings its user agent, pixel ratio, touch and mobile mode; the browser stays Chromium
        ...(device && devices[device] ? (({ defaultBrowserType, ...d }) => d)(devices[device]) : {}),
        viewport: { width, height },
        args: [`--remote-debugging-port=${port}`, ...guard.blockArgs(guard.productionHostsFromSettings())], // production never resolves
      });
      if (session) {
        // persistent contexts can't take storageState directly: restore cookies, then localStorage per origin once per tab
        await ctx.addCookies(session.cookies ?? []);
        await ctx.addInitScript(origins => {
          const o = origins.find(x => x.origin === location.origin);
          if (o && !sessionStorage.getItem('__sessionRestored')) {
            for (const { name, value } of o.localStorage) localStorage.setItem(name, value);
            sessionStorage.setItem('__sessionRestored', '1');
          }
        }, session.origins ?? []);
      }
      const watch = castPages(ctx, { width, height, highlight, a11y });
      await watch(ctx.pages()[0] ?? await ctx.newPage());
      return port;
    },

    // Replays: the test runner launches its own browser on `port` (from reservePort); attach as soon as it is up
    async watchReplayBrowser(port, { width, height, highlight, a11y }, signal) {
      await attached?.close().catch(() => {}); attached = null;
      await context?.close().catch(() => {}); context = null; // a workflow hands over from our browser to the runner's
      while (!signal.aborted) {
        try {
          const b = attached = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
          const ctx = b.contexts()[0];
          const watch = castPages(ctx, { width, height, highlight, a11y });
          const open = ctx.pages();
          if (open.length) await watch(open.at(-1));
          return;
        } catch { await new Promise(r => setTimeout(r, 150)); } // not up yet
      }
    },

    async saveSession() {
      if (!context) throw new Error('This run\'s browser is closed (it closes 5 minutes after the run). Run the AI again, then save its session.');
      return context.storageState();
    },

    // Records the stage to MP4: paste today's startRecording body from lines 316-338 here UNCHANGED
    // (it uses this stage's `last.frame` and `highlightListeners` through the closure; replace its
    // `onHighlight(...)` call with `this.onHighlight(...)` or a local helper).
    startRecording(file, { width, height, fps }) { /* lines 317-337 of today's file */ },

    // The AI browser stays open after a run so its login can be saved, but not forever: it holds a few hundred MB
    closeWhenIdle(after = () => {}) { clearTimeout(idleTimer); idleTimer = setTimeout(() => closeAll().catch(() => {}).then(after), IDLE_CLOSE_MS); },
    async close() { await closeAll(); },
  };
}
```

When pasting `startRecording`, the one reference to the module-level `onHighlight` becomes a local call. Write it as:

```js
    const stopHolding = (fn => { highlightListeners.add(fn); return () => highlightListeners.delete(fn); })(frame => { if (frame) for (let i = 0; i < Math.round(fps * HOLD_S); i++) write(frame); });
```

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `node --test app/test/stage.integration.test.mjs`
Expected: PASS, 1 test

- [ ] **Step 5: Keep the server working with one shared stage (temporary)**

In `app/server.mjs`, so the app still runs between Task 2 and Task 5:

```js
// line 7
import { createStage, portAnswers } from './stage.mjs';
import { createPortPool } from './runs.mjs';
// right after the imports block
const ports = createPortPool(9400, 9499, portAnswers);
const stage = createStage(ports); // Task 5 replaces this with one stage per run
```

Then:
- `app/server.mjs:314` `await stage.shutdown()` → `await stage.close()`
- `app/server.mjs:338` delete `stage.setAudience(project);`
- `app/server.mjs:431` `await stage.claimPort(stage.REPLAY_CDP_PORT);` → `const cdpPort = await stage.reservePort();`
- `app/server.mjs:434` `stage.watchReplayBrowser(rec, watchSignal)` → `stage.watchReplayBrowser(cdpPort, rec, watchSignal)`
- `app/server.mjs:443` add `cdpPort,` to the `runTests(files, { ... })` options (Task 4 makes `runTests` use it; until then it is ignored)
- `app/server.mjs:794` `/screen`: `sse(res); return stage.addViewer(res);` (temporarily visible to every signed-in user; Task 5 restricts it per run)

Between this task and Task 3, **AI runs do not work**: the browser now gets a port from the pool while `app/mcp.json` still points MCP at 9333. Replays work. Do Task 3 before using AI runs; do not ship this commit alone.

- [ ] **Step 6: Run all unit tests**

Run: `node --test app/test/*.test.mjs`
Expected: PASS, all (43 existing + 5 from Task 1 + 1 integration)

- [ ] **Step 7: Commit**

```bash
git add app/stage.mjs app/server.mjs app/test/stage.integration.test.mjs
git commit -m "Stage becomes a factory: one browser, live view and recorder per instance"
```

---

### Task 3: Per-run MCP server and run values (no shared `run-vars.json`)

**Files:**
- Modify: `app/mcp-proxy.mjs:21-24`
- Modify: `app/agents.mjs:1-10` (import) and `:55`
- Modify: `app/server.mjs:53-54`, `:118-123` (`writeRunVars`), `:293-294` (`clearMcpScratch`), `aiRun` (`:392-427`), `fixRun` (`:497-553`), `workflowRun` (`:555-675`)
- Delete: `app/mcp.json`
- Test: `app/test/runs.test.mjs` (already covers `mcpServerFor`); manual check in Step 6

**Interfaces:**
- Consumes: `mcpServerFor(port, outputDir, runVars)` (Task 1); `stage.ownBrowser(...) → port` (Task 2).
- Produces: `mcpFor(runDir, port, env, project) → { mcpConfigPath: string, mcpServer: object }` in `app/server.mjs`, passed to `engines[...]({ ..., mcpConfigPath, mcpServer, cwd: dir })`.

- [ ] **Step 1: Proxy reads its run's values from the environment**

`app/mcp-proxy.mjs`, replace lines 21-24:

```js
// {{...}} test values (dates, random, environment variables, secrets) are resolved right before a tool runs.
// The server starts one proxy per AI run and passes that run's environment values and allowed secret
// names in RUN_VARS. Only the run's project's secrets can be filled in, and only those are masked.
let runVars = {}, envName = '', allowed = [];
try { ({ vars: runVars = {}, env: envName = '', secrets: allowed = [] } = JSON.parse(process.env.RUN_VARS ?? '{}')); } catch {}
```

Remove `readFileSync` from the `node:fs` import on line 6 if nothing else uses it (nothing does).

- [ ] **Step 2: OpenAI-compatible engine keeps PATH/HOME when a server brings `env`**

`StdioClientTransport` uses only the given `env` when one is set, and the proxy needs `HOME` to find Playwright's browsers. In `app/agents.mjs` add to the SDK stdio import `getDefaultEnvironment`, and change line 55:

```js
  await mcp.connect(new StdioClientTransport({ ...mcpServer, env: { ...getDefaultEnvironment(), ...mcpServer.env }, cwd, stderr: 'ignore' }));
```

- [ ] **Step 3: Server builds one MCP config per run**

In `app/server.mjs` delete lines 53-54 (`mcpConfigPath`, `mcpServer` from `mcp.json`), delete `writeRunVars` (line 123) and `clearMcpScratch` (lines 293-294). Import `mcpServerFor` from `./runs.mjs`. Add near the old `writeRunVars`:

```js
// One MCP server per AI run: its own browser port, output folder and environment values.
// Claude Code reads the config from a file; the OpenAI-compatible engine takes the object.
function mcpFor(runDir, port, env, project) {
  const mcpServer = mcpServerFor(port, join(runDir, 'mcp'), { vars: env.vars, env: env.name, secrets: projectSecrets(project) });
  const mcpConfigPath = join(runDir, 'mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { playwright: mcpServer } }));
  return { mcpConfigPath, mcpServer };
}
```

`withRun` creates the run folder and passes it to the body. In `withRun` (after `const video = ...`, line 335):

```js
  const runDir = join(dataDir, 'live', id); // this run's MCP config and output, replay output; removed when the run ends
  mkdirSync(runDir, { recursive: true });
```

add `runDir` to the object passed to `body(...)` on line 362, and in `finally` after `addRun(entry);`:

```js
    rmSync(runDir, { recursive: true, force: true });
```

- [ ] **Step 4: Use it in the three AI paths**

`aiRun`: take `runDir` from the body arguments, delete `writeRunVars(env, project);` and `clearMcpScratch();`, and replace lines 400 and 417-419:

```js
    const port = await stage.ownBrowser(rec, sessionData);
    const mcp = mcpFor(runDir, port, env, project);
```
```js
    const { text } = await engines[provider.engine]({
      provider, model: model || provider.model, prompt, system: SYSTEM, ...mcp, cwd: dir,
    }, emit, signal);
```

`fixRun`: same change (its `writeRunVars` at line 504, `clearMcpScratch` + `ownBrowser` at 507-508, engine call at 527 → `...mcp` instead of `mcpConfigPath, mcpServer`). `fixRun` gets `runDir` from `ctx`.

`workflowRun`: delete `writeRunVars(env, project);` (line 559). `openBrowser` sets the config each time a browser opens (a `test` block closes it, a later AI block reopens it on a new port):

```js
    let mcp = null;
    const openBrowser = async () => {
      if (browserOpen) return;
      const port = await stage.ownBrowser(rec, storage);
      mcp = mcpFor(runDir, port, env, project);
      browserOpen = true;
      startRecording();
    };
```

and line 644 → `engines[provider.engine]({ provider, model: model || provider.model, prompt, system: WF_SYSTEM, ...mcp, cwd: dir }, emit, signal)`. `workflowRun`'s body gets `runDir` from its arguments. Also line 625 `const file = join(dataDir, \`wf-storage-${entry.id}.json\`);` → `const file = join(runDir, 'wf-storage.json');` (removed with the run folder).

- [ ] **Step 5: Delete `app/mcp.json` and old scratch folders from `.gitignore`**

```bash
git rm app/mcp.json
```

In `.gitignore` remove the line `app/runs/` (the MCP output now lives in `app/data/live/<run>/mcp`, already ignored with `app/data/`).

- [ ] **Step 6: Verify by hand (needs an AI provider)**

1. `node --test app/test/*.test.mjs` → all PASS.
2. Restart the app (`npm run app`), sign in, create a throwaway project, add an environment value `appUrl=https://example.com` and a secret `DEMO_PASS` bound to the project.
3. Delete the old shared file: `rm -f app/data/run-vars.json`.
4. Start an AI run: URL `{{appUrl}}`, task `Open the page and report its main heading.`
5. Expected: the run passes and its first step navigated to `https://example.com` (the proxy filled `{{appUrl}}` from `RUN_VARS`); `app/data/live/` is empty after the run; `app/data/run-vars.json` does not come back.
6. If instead the AI got an error about an unknown `{{appUrl}}`, Claude Code did not pass the config's `env` to the proxy. Do **not** add `...process.env` to the config (the file on disk would then hold every secret). Instead: in `mcpServerFor` put the values in a file `join(outputDir, '..', 'run-vars.json')` and pass only its path as `env: { RUN_VARS_FILE: path }`; in the proxy read `JSON.parse(readFileSync(process.env.RUN_VARS_FILE, 'utf8'))`. Update the Task 1 test to match.

- [ ] **Step 7: Commit**

```bash
git add -A app/mcp-proxy.mjs app/agents.mjs app/server.mjs .gitignore
git commit -m "One MCP server per AI run: own browser port, output folder and values; no shared run-vars.json"
```

---

### Task 4: Per-run replay port and output folder

**Files:**
- Modify: `app/replay.mjs:5,51-63`
- Modify: `app/replay.config.ts:13,17,25`
- Modify: `app/server.mjs` `playTests` (`:430-448`)
- Test: `app/test/replay.integration.test.mjs`

**Interfaces:**
- Consumes: `stage.reservePort()` (Task 2), `runDir` from `withRun` (Task 3).
- Produces: `runTests(files, { ..., cdpPort: number, outputDir: string }, handlers, signal)`.

- [ ] **Step 1: Write the failing integration test**

```js
// app/test/replay.integration.test.mjs
// Runs the real Playwright test runner twice at once (headless Chromium): a few seconds
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runTests } from '../replay.mjs';

const root = join(import.meta.dirname, '..', 'data', 'test-parallel'); // under the repo so @playwright/test resolves
const spec = (name, color) => `import { test, expect } from '@playwright/test';
test('${name}', async ({ page }) => {
  await page.setContent('<h1 style="color:${color}">${name}</h1>');
  await page.waitForTimeout(1500);
  await expect(page.getByRole('heading', { name: '${name}' })).toBeVisible();
});`;

test('two replays at once keep their own port, output and report', async () => {
  rmSync(root, { recursive: true, force: true });
  const dirs = ['a', 'b'].map(n => { const d = join(root, `tests-${n}`); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${n}.spec.ts`), spec(n, n === 'a' ? 'red' : 'blue')); return d; });
  const run = (d, i) => runTests([join(d, `${['a', 'b'][i]}.spec.ts`)], {
    width: 640, height: 400, testDir: d, cdpPort: 9490 + i, outputDir: join(root, `out-${i}`), slowMo: 0,
  }, { onLine: () => {}, onStep: () => {} }, new AbortController().signal);
  try {
    const [ra, rb] = await Promise.all(dirs.map(run));
    assert.equal(ra.ok, true); assert.equal(rb.ok, true);
    assert.deepEqual([ra.tests[0].title, rb.tests[0].title], ['a', 'b']);
    assert.equal(existsSync(join(root, 'out-0')), true);
    assert.equal(existsSync(join(root, 'out-1')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test app/test/replay.integration.test.mjs`
Expected: FAIL: both runners use the fixed port 9334 and the shared `data/replay-results`; typically one run has no report ("Playwright produced no report") or a browser launch error for the busy port.

- [ ] **Step 3: `runTests` takes the port and folder**

`app/replay.mjs`: delete line 5 (`import { REPLAY_CDP_PORT } from './stage.mjs';`) and, if `dataDir` is then unused, line 6. In `runTests`, add `cdpPort, outputDir` to the destructured options and replace line 52 and the env entries:

```js
  const reportFile = `${outputDir}.json`; // next to the output folder: Playwright empties the folder itself when it starts
```
```js
        REPLAY_W: String(width), REPLAY_H: String(height), REPLAY_DEVICE: device ?? '', REPLAY_CDP_PORT: String(cdpPort),
        REPLAY_OUTPUT: outputDir,
        REPLAY_REPORT: reportFile, REPLAY_SLOWMO: String(slowMo), REPLAY_STORAGE: sessionFile ?? '', REPLAY_TESTDIR: testDir ?? '',
```

`app/replay.config.ts`:

```ts
  outputDir: process.env.REPLAY_OUTPUT || './data/replay-results', // one folder per run: Playwright empties it when a run starts
```

and on line 25 keep `process.env.REPLAY_CDP_PORT ?? 9334` (the fallback is only for running the config by hand).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test app/test/replay.integration.test.mjs`
Expected: PASS, 1 test

- [ ] **Step 5: `playTests` passes the run's own port and folder**

`app/server.mjs`, `playTests` gets `runDir` in its second argument group (`{ send, signal, entry, mask, startRecording, addGuideStep, runDir }`, the body context already has it from Task 3) and becomes:

```js
  const cdpPort = await stage.reservePort(); // this run's runner browser; the live view attaches to it
  ...
  const watching = stage.watchReplayBrowser(cdpPort, rec, watchSignal).then(() => { if (!watchSignal.aborted) startRecording(); });
  ...
  try { result = await runTests(files, { ...rec, cdpPort, outputDir: join(runDir, `replay-${Date.now()}`), sessionFile: ..., /* rest unchanged */ }, { onLine, onStep }, signal); }
```

(`Date.now()` because a workflow can replay several `test` blocks in one run; `keepVisualDiffs` copies the images out before the run folder is removed.) Callers of `playTests` pass `ctx` already; make sure `replayRun` and `fixRun` and `workflowRun` forward `runDir` in that `ctx` (they spread the body context).

- [ ] **Step 6: Run all tests**

Run: `node --test app/test/*.test.mjs`
Expected: PASS, all

- [ ] **Step 7: Commit**

```bash
git add app/replay.mjs app/replay.config.ts app/server.mjs app/test/replay.integration.test.mjs
git commit -m "Replays use the run's own browser port and output folder"
```

---

### Task 5: Several runs at once in the server and the UI

**Files:**
- Modify: `app/server.mjs` (runs section `:296-390`, `/screen` `:794`, `/stop` `:817-820`, `/sessions` `:913-921`, `runSchedule` `:687-704`, route calls to `takeTurn` `:1043,1056,1071,1079`, signal handler `:314`)
- Modify: `app/app.js` (`startLive` `:348-355` and its call `:81`, run start `:460-467`, stop `:505-510`, save session `:606-612`)
- Modify: `README.md`

**Interfaces:**
- Consumes: `createLimiter` (Task 1), `createStage(ports)` (Task 2), `mcpFor` (Task 3), `runTests` with `cdpPort`/`outputDir` (Task 4).
- Produces (HTTP): `GET /screen?run=<id>`, `POST /stop?run=<id>`, `POST /sessions` body `{ project, name, run }` (or `{ project, name, flowId }` for recordings, unchanged).

- [ ] **Step 1: Replace the one-at-a-time line with the limiter and a run registry**

In `app/server.mjs` delete lines 296-313 (`running`, `waiting`, `takeTurn`, `releaseTurn`, `currentAbort`) and the temporary shared `const stage = createStage(ports);` from Task 2. Add `createLimiter` to the `./runs.mjs` import. Put in their place:

```js
/* ---------- runs ---------- */
// Up to MAX_RUNS runs at once, each with its own browser (stage). More wait in line (FIFO); a client that
// leaves while waiting drops out. Runs that reset the same test database never overlap.
const MAX_RUNS = Math.max(1, Number(process.env.MAX_RUNS) || 2);
const slots = createLimiter(MAX_RUNS);
const active = new Map(); // run id -> { stage, project, abort, done }: live view, Stop and "Save login session" by id
function takeTurn(res, keys) {
  const left = new AbortController();
  res.on('close', () => left.abort());
  return slots.acquire(keys, position => res.write(`event: queued\ndata: ${JSON.stringify({ position })}\n\n`), left.signal);
}
const dbLock = (project, env) => { const db = projectDb(project, env.name)?.cfg; return db?.reset ? [`db:${db.host}:${db.port}/${db.database}`] : []; };
// A finished AI run keeps its browser 5 minutes for "Save login session"; keep at most MAX_RUNS of those
function trimIdle() {
  const idle = [...active.entries()].filter(([, r]) => r.done);
  for (const [id, r] of idle.slice(0, Math.max(0, idle.length - MAX_RUNS))) { active.delete(id); r.stage.close(); }
}
```

Line 314 (signal handler):

```js
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { console.log(`Stopped (${sig})`); await Promise.all([...active.values()].map(r => r.stage.close())); process.exit(0); }); // Playwright's own handler doesn't exit
```

- [ ] **Step 2: `withRun` waits for a slot and owns the run's stage**

Delete `let currentRun = null;` (line 328). `withRun` takes `locks` in its options and starts with the wait:

```js
async function withRun(res, { kind, record, guide, label, project, userId, locks = [] }, body) {
  const release = await takeTurn(res, locks); // may wait in line; throws if the client leaves meanwhile
  const send = (type, data) => { if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  const abort = new AbortController();
  res.on('close', () => abort.abort()); // tab closed
  const started = Date.now();
  const id = `${stamp(started)}-${kind}-${randomBytes(3).toString('hex')}`; // runs can now start in the same second
  // (video, entry, runDir as before)
  const stage = createStage(ports);
  const run = { stage, project, abort, done: false };
  active.set(id, run);
```

Replace every `stage.` inside `withRun` (`currentFrame`, `onHighlight`, `onIssue`, `startRecording`) with the local `stage` (same names). Delete `stage.setAudience(project);`. Add `stage` to the object passed to `body(...)`. In `finally`, replace `stage.closeWhenIdle();` and `releaseTurn();` with:

```js
    run.done = true;
    stage.closeWhenIdle(() => active.delete(id));
    trimIdle();
    release();
```

- [ ] **Step 3: Bodies use the run's stage; routes stop calling `takeTurn`**

- `aiRun`, `fixRun`, `workflowRun`, `playTests`: take `stage` from the body context (`ctx`) and use it wherever they call `stage.` today (`ownBrowser`, `reservePort`, `watchReplayBrowser`, `saveSession`, `currentFrame`).
- Pass the database lock into `withRun`: `aiRun` → `withRun(res, { kind: 'ai', ..., locks: dbLock(project, env) }, ...)`; the same `locks: dbLock(project, env)` in `replayRun`, `fixRun` (`dbLock(run.project, env)`), `workflowRun`.
- Routes: remove `await takeTurn(res);` on lines 1043, 1056, 1071, 1079 (keep `sse(res);`). `runSchedule`: remove `await takeTurn(res);` (line 694); `withRun` waits now.

- [ ] **Step 4: Live view, Stop and Save session by run id**

```js
  const liveRun = (id, user, role) => {
    const run = active.get(id);
    if (!run || !can(user, run.project, role)) throw denied('That run is not running, or not in your projects');
    return run;
  };
```

- `/screen` (line 794): `if (p === '/screen') { const run = liveRun(q('run'), user, 'viewer'); sse(res); return run.stage.addViewer(res); }`
- `/stop` (lines 817-820): `if (p === '/stop' && m === 'POST') { liveRun(q('run'), user, 'tester').abort.abort(); res.writeHead(204); return res.end(); }`
- `/sessions` (lines 913-921), **session guard**: read `run` from the body; replace `await stage.saveSession()` with

```js
    const state = flowId ? JSON.parse(flowStorage(flowId)) : await (() => {
      const r = liveRun(runId, user, 'tester');
      if (r.project !== pr) throw denied('That run belongs to another project'); // never save one project's login into another
      return r.stage.saveSession();
    })();
```

with `const { project: pr, name, flowId, run: runId } = await readBody(req);`.

Check that `denied` is the helper already used on today's line 818 (it is).

- [ ] **Step 5: UI follows its own run**

`app/app.js`:

```js
/* ---------- live view ---------- */
let live;
function startLive(runId) { // the browser of one run; the server checks the run is in your projects
  live?.close();
  live = new EventSource('/screen?' + new URLSearchParams({ run: runId }));
  live.addEventListener('frame', e => { $('frame').src = 'data:image/jpeg;base64,' + JSON.parse(e.data); $('stage').classList.add('has-frame'); });
  live.addEventListener('url', e => { $('addr').textContent = JSON.parse(e.data); });
}
```

- Line 81: delete `startLive();` (no stream until a run starts).
- In `start()` before opening `es`: `$('stage').classList.remove('has-frame'); $('addr').textContent = 'about:blank';` (what the old `reset` event did).
- `es.addEventListener('run', ...)`: after `current.id = JSON.parse(e.data).id;` add `startLive(current.id);`.
- `queued` text: `` setStatus(`Waiting for a free run slot (#${JSON.parse(e.data).position} in line)`, 'run') ``.
- Stop (line 509): `` fetch(`/stop?${new URLSearchParams({ run: current.id })}`, { method: 'POST' }).catch(() => finish()); ``
- Save session (line 608): body `JSON.stringify({ project: project.id, name, run: run.id })`.

- [ ] **Step 6: Verify: unit tests, then two runs at once by hand**

1. `node --test app/test/*.test.mjs` → all PASS.
2. Restart with `MAX_RUNS=2 npm run app`.
3. In a throwaway project, save a test `slow` (Saved tests → New test):

```ts
import { test, expect } from '@playwright/test';
test('slow', async ({ page }) => {
  await page.setContent('<h1>slow</h1>');
  await page.waitForTimeout(8000);
  await expect(page.getByRole('heading', { name: 'slow' })).toBeVisible();
});
```

4. Open the app in two browser windows (or two users). Replay `slow` in both within a few seconds. Expected: both show "Running" (no "Waiting…"), both live views show their own page, both finish in ~10 s, and History shows two passed runs with different ids.
5. Start a third replay while two are going. Expected: "Waiting for a free run slot (#1 in line)", then it runs when one finishes.
6. Stop one of two running replays. Expected: only that one stops.
7. Session guard: from project A's finished AI run, call `POST /sessions` with `project: <B>` and `run: <A's run id>` (browser devtools: `fetch('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'b', name: 'x', run: '<id>' }) })`). Expected: 403-style error "That run belongs to another project".
8. Idle trim: with `MAX_RUNS=1`, run three quick AI runs in a row; `ps aux | grep -c "remote-debugging-port=94"` stays at most 2 (one idle + one running).

- [ ] **Step 7: Document**

`README.md`, in the "Shared server" section, add:

```markdown
**Parallel runs**: up to `MAX_RUNS` runs (AI, replays, fixes, workflows) go at once, each in its own browser
(default `MAX_RUNS=2`; each browser needs a few hundred MB of memory). More runs wait in line. Runs that reset
the same test database always take turns. Browser debugging ports come from 9400–9499.
```

- [ ] **Step 8: Commit**

```bash
git add app/server.mjs app/app.js README.md
git commit -m "Several runs at once: one browser per run, MAX_RUNS slots, database reset lock; live view, Stop and Save session by run id"
```

---

## Not in this plan

- **Watching a teammate's run live.** Today anyone in the project sees whatever run is on the one stage. After this plan the live view follows the run you started; a run started by someone else is visible through History once it ends. A "Running now" list is a separate, small follow-up.
- **Record flow (codegen)** stays single (`app/recorder.mjs`): it opens a headed browser on the machine running the app, so it is local-only and one person at a time anyway.
- **Isolation between users' test code** (container / OS user): unchanged; see the README's server-mode notes.
