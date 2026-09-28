# Standalone App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI Browser Runner runs on each person's own laptop without accounts, shares projects as `<id>.abr.json` files, and installs on Windows, macOS and Linux with `npm install && npm run setup && npm run app`.

**Architecture:** Part A strips accounts/roles/server mode from `app/server.mjs`, `app/app.js`, `app/index.html`, `app/store.mjs`, `app/history.mjs` and deletes `app/auth.mjs`; the origin check stays as the only gate. Part B adds a pure module `app/bundle.mjs` (pack, validate/unpack, missing variables) and two routes plus UI. Part C adds `app/setup.mjs` (checks with pure helpers) and a small `app/proc.mjs` for OS-specific process handling used by the runner, recorder and Claude engine.

**Tech Stack:** Node ≥ 22.13 (ESM, `node:sqlite`, `node:test`), `playwright-core` / `@playwright/test` / `@playwright/mcp`, plain browser JS.

**Spec:** `docs/superpowers/specs/2026-09-28-standalone-design.md`

## Global Constraints

- No new npm dependencies.
- The server listens on `127.0.0.1` only. Origin check stays: `Host` is `127.0.0.1:<port>` or `localhost:<port>`, and `Sec-Fetch-Site` is `same-origin`, `none` or absent; anything else gets 403.
- Export file: `<project-id>.abr.json`, `format: "ai-browser-runner-project"`, `version: 1`. Never includes secret values, `DBPASS_*`, login sessions, run history, videos, PDFs.
- Import request body at most 20 MB.
- Allowed bundle paths: `*.spec.ts` at the top level, `data/*.csv`, `workflows/*.json`, `*.spec.ts-snapshots/*.png`. PNG as `base64`, the others as `text`.
- Node floor: 22.13.0.
- Unit/integration tests: `node --test app/test/*.test.mjs` (`npm run test:app`). **Never run `npm test`: it runs the Playwright E2E suite against real apps.**
- After any change to `app/server.mjs`, also check the server boots: `PORT=4399 timeout 5 node app/server.mjs` prints `AI Browser Runner → http://127.0.0.1:4399`.
- Code style: match the surrounding code; one-line `//` comments that say why; `ponytail:` comments for deliberate shortcuts with their ceiling.

## Spec clarification (ruled while planning)

The spec says an imported `project.db` must pass `validDb`. `validDb` rejects environments that do not exist on this laptop, so a project exported from a laptop with an `e2e` environment would be rejected as a whole on a laptop without one. Ruling: on import, `db` entries for environments this laptop does not have are **dropped and reported** (`skippedDb` in the summary); the remaining entries must pass `validDb`. Cost if wrong: the importer re-enters database settings for that environment by hand.

## Review Focus

1. **A website open in the same browser drives the app.** With no login, a page on `evil.example` that POSTs to `http://127.0.0.1:4321/run` must be refused (cross-site `Sec-Fetch-Site`, or a foreign `Host` via DNS rebinding). Test: Task 1 step "origin".
2. **A crafted import writes outside the project folder or drops executable files.** `../`, absolute paths, backslashes, drive letters, `.sh` files, a `.spec.ts` under `data/`. Test: Task 3 rejection cases; Task 4 checks nothing was written after a rejected import.
3. **Import "overwrite" destroys the wrong thing.** Overwriting `shop` must replace only `tests/shop/` files and keep its run history, sessions and DB passwords. Test: Task 4 step "overwrite keeps history".
4. **Existing laptops upgrade with an old `app.db`.** The migration that drops `users/sessions/members` must run on a database that has them (and on a fresh one), and History still lists old runs. Test: Task 1 step "migration".
5. **Stop on Windows leaves Chromium running.** Cannot run here; Task 6 unit-tests that `win32` uses `taskkill /T /F` and adds the manual smoke test to the README.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `app/auth.mjs`, `app/reset-password.mjs`, `app/test/auth.test.mjs` | Delete | accounts (gone) |
| `app/store.mjs` | Modify | migration dropping `users`, `sessions`, `members` |
| `app/history.mjs` | Modify | `listRuns` without the `users` join |
| `app/server.mjs` | Modify | no accounts/permissions/server mode; export/import routes |
| `app/app.js`, `app/index.html`, `app/app.css` | Modify | no sign-in, roles, members, users; Export/Import UI |
| `app/test/helpers/app-server.mjs` | Create | start the real server on a spare port with a throwaway DB (shared by integration tests) |
| `app/test/server.integration.test.mjs` | Modify | no login; origin test |
| `app/test/ui.integration.test.mjs` | Create | the page opens straight into Projects, no JS errors |
| `app/bundle.mjs`, `app/test/bundle.test.mjs` | Create | pack/unpack/validate project files; missing `{{vars}}` |
| `app/test/share.integration.test.mjs` | Create | export → import (409, new, overwrite) → replay |
| `app/setup.mjs`, `app/test/setup.test.mjs` | Create | `npm run setup` checks |
| `app/proc.mjs`, `app/test/proc.test.mjs` | Create | Playwright CLI command, process-tree kill, Windows spawn options |
| `app/replay.mjs`, `app/recorder.mjs`, `app/agents.mjs` | Modify | use `app/proc.mjs` |
| `package.json`, `README.md` | Modify | scripts, install per OS |

---

### Task 1: Server without accounts

**Files:**
- Delete: `app/auth.mjs`, `app/reset-password.mjs`, `app/test/auth.test.mjs`
- Modify: `app/store.mjs:14-27`, `app/history.mjs:40-50`, `app/server.mjs` (see steps), `package.json` (`reset-password` script)
- Create: `app/test/helpers/app-server.mjs`
- Modify: `app/test/server.integration.test.mjs`

**Interfaces:**
- Produces: `startApp({ port, env }) → Promise<{ base, req(path, opts), stop() }>` in `app/test/helpers/app-server.mjs` (used by Tasks 2 and 4). `req` sends `content-type: application/json` when `opts.body` is set and passes other `opts.headers` through.

- [ ] **Step 1: Shared test helper**

```js
// app/test/helpers/app-server.mjs
// Starts the real app on a spare port with a throwaway database; the caller stops it.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dirname, '..', '..', '..');

export async function startApp({ port, env = {} }) {
  const tmp = mkdtempSync(join(tmpdir(), 'abr-test-'));
  const server = spawn(process.execPath, ['app/server.mjs'], {
    cwd: root, env: { ...process.env, PORT: String(port), APP_DB: join(tmp, 'app.db'), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  server.stderr.on('data', d => { err += d; });
  await new Promise((ok, fail) => {
    server.stdout.on('data', d => String(d).includes('AI Browser Runner') && ok());
    server.on('exit', c => fail(new Error(`server exited ${c}: ${err.slice(-500)}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const req = (path, opts = {}) => fetch(base + path, { ...opts, headers: { ...(opts.body && { 'content-type': 'application/json' }), ...opts.headers } });
  const stop = () => { server.kill('SIGTERM'); rmSync(tmp, { recursive: true, force: true }); };
  return { base, req, stop, root };
}
```

- [ ] **Step 2: Rewrite the server integration test without login, add the origin checks (failing)**

Replace `app/test/server.integration.test.mjs` entirely:

```js
// Boots the real server on a spare port with a throwaway database and replays tests over HTTP (headless
// Chromium): about 20 seconds. Runs side by side, the line beyond MAX_RUNS, the live view by run id,
// "Save login session" staying inside its project, and the origin check that replaces a login.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const projects = ['zz-par-a', 'zz-par-b'];
let app;
before(async () => {
  app = await startApp({ port: 4398, env: { MAX_RUNS: '2' } });
  for (const p of projects) {
    mkdirSync(join(app.root, 'tests', p), { recursive: true });
    writeFileSync(join(app.root, 'tests', p, 'project.json'), JSON.stringify({ name: p }));
    writeFileSync(join(app.root, 'tests', p, 'slow.spec.ts'), `import { test, expect } from '@playwright/test';
test('slow', async ({ page }) => {
  await page.setContent('<h1>slow</h1>');
  await page.waitForTimeout(4000);
  await expect(page.getByRole('heading', { name: 'slow' })).toBeVisible();
});`);
  }
});
after(() => { app.stop(); for (const p of projects) rmSync(join(app.root, 'tests', p), { recursive: true, force: true }); });

// Reads an SSE run stream; resolves with its events once the run is saved
function runStream(path, onEvent = () => {}) {
  return app.req(path).then(async r => {
    const events = [], dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const m = buf.slice(0, i).match(/^event: (\w+)\ndata: (.*)$/s); buf = buf.slice(i + 2);
        if (!m) continue;
        const ev = { type: m[1], data: JSON.parse(m[2]) }; events.push(ev); onEvent(ev);
        if (ev.type === 'saved') return events;
      }
    }
    return events;
  });
}
const idOf = events => events.find(e => e.type === 'run')?.data.id;

test('no sign-in: the API answers straight away', async () => {
  const r = await app.req('/projects');
  assert.equal(r.status, 200);
  assert.ok((await r.json()).some(p => p.id === 'zz-par-a'));
});

test('origin: other sites and foreign host names are refused', async () => {
  assert.equal((await app.req('/projects', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await app.req('/projects', { headers: { host: 'evil.example:4398' } })).status, 403);
  assert.equal((await app.req('/projects', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
});

test('runs go side by side up to MAX_RUNS; live view and saved sessions follow the run id', async () => {
  const replay = p => `/replay?${new URLSearchParams({ project: p, tests: 'slow', record: '0', guide: '0' })}`;
  let firstId;
  const started = new Promise(r => { firstId = r; });
  const a = runStream(replay('zz-par-a'), e => e.type === 'run' && firstId(e.data.id));
  const b = runStream(replay('zz-par-b'));
  const runA = await started;
  const c = runStream(replay('zz-par-a')); // a third run while two go: it waits for a slot

  const live = await app.req(`/screen?${new URLSearchParams({ run: runA })}`);
  assert.equal(live.status, 200);
  live.body.cancel();
  assert.notEqual((await app.req('/screen?run=nope')).status, 200);

  const [ea, eb, ec] = await Promise.all([a, b, c]);
  assert.equal(ea.some(e => e.type === 'queued'), false);
  assert.equal(eb.some(e => e.type === 'queued'), false);
  assert.equal(ec.some(e => e.type === 'queued'), true);
  assert.ok(idOf(ea) && idOf(eb) && idOf(ea) !== idOf(eb));

  const cross = await app.req('/sessions', { method: 'POST', body: JSON.stringify({ project: 'zz-par-b', name: 'x', run: idOf(ea) }) });
  assert.notEqual(cross.status, 200);
  assert.match(await cross.text(), /another project/);
});
```

Note: Node's `fetch` refuses to set the `host` header silently on some versions. If the `host` assertion gets `200`, send the request with `node:http` instead:

```js
import http from 'node:http';
const rawStatus = (path, headers) => new Promise((ok, fail) => http.get({ host: '127.0.0.1', port: 4398, path, headers }, r => { r.resume(); ok(r.statusCode); }).on('error', fail));
// assert.equal(await rawStatus('/projects', { host: 'evil.example:4398' }), 403);
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test app/test/server.integration.test.mjs`
Expected: FAIL: `no sign-in` gets `401` ("Sign in first"); the parallel-run test fails on `401` too.

- [ ] **Step 4: Migration and history without users**

`app/store.mjs`: append one step to `MIGRATIONS` (never edit the existing ones):

```js
  // standalone app: one person per install, no accounts (runs.user_id stays, unused)
  `DROP TABLE IF EXISTS members; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users;`,
```

`app/history.mjs` `listRuns`: drop the join and `by`:

```js
  const rows = list.length
    ? db.prepare(`SELECT data FROM runs WHERE project IN (${list.map(() => '?').join(',')}) ORDER BY started DESC`).all(...list)
    : db.prepare('SELECT data FROM runs ORDER BY started DESC').all();
  return rows.map(({ data }) => {
```

and in the returned object remove `by: by ?? undefined,`. `addRun` keeps writing `user_id` as `null` (it already writes `r.userId ?? null`).

- [ ] **Step 5: Server: remove accounts, permissions and server mode**

In `app/server.mjs`:

1. Delete the `./auth.mjs` import (line 16).
2. Replace the block `/* ---------- accounts and access ---------- */` (lines 718-740) with:

```js
/* ---------- access ---------- */
// One person per install: no accounts. The origin check below is what keeps other websites out.
const denied = (msg, status = 403) => Object.assign(new Error(msg), { status });
const runOr404 = run => { if (!run) throw denied('Run not found', 404); return run; };
```

3. `sameOrigin` (line 746): `const known = /^(127\.0\.0\.1|localhost):\d+$/.test(host);`
4. In `route()`, delete from `/* ----- sign in ----- */` through the line `if (user.mustChange) throw denied(...)` (lines 768-795), and delete the whole `/* ----- users (admin) and the member picker ----- */` block (lines 828-836) and the `/projects/<id>/members` route (`memMatch`, lines 911-916).
5. Replace permission calls everywhere in `app/server.mjs`, mechanically:
   - `need(user, X, '<role>')` → `projectDir(X)` (it also checked the project exists; keep that). Inside conditional forms like `if (pr) need(user, pr, 'maintainer'); else needAdmin(user);` → `if (pr) projectDir(pr);`.
   - `needAdmin(user);` → delete the statement.
   - `needRun(user, R)` / `needRun(user, R, '<role>')` → `runOr404(R)`.
   - `liveRun`: `const liveRun = id => { const run = active.get(id); if (!run) throw denied('That run is not running'); return run; };` and its callers drop the role argument: `liveRun(q('run'))`, `liveRun(runId)`.
   - `userId: user.id` in the four run routes → delete the property; in `runOnStage`, `aiRun`, `replayRun`, `fixRun`, `workflowRun` remove the `userId` parameter and `...(userId && { userId })` in `entry`.
6. `/settings` GET (lines 839-845): always the full answer:

```js
  if (p === '/settings' && m === 'GET') {
    const providers = loadProviders().map(pr => ({ ...pr, ready: ready(pr) }));
    // never send key/secret values to the browser, only names and whether a key is set
    return json(res, { engines: Object.keys(engines), days: DAYS, activeEnv: defaultEnv(), recording: loadRecording(), providers, devices: DEVICES, schedules: loadSettingsFile().schedules ?? [], guide: loadGuide(), guideLangs: GUIDE_LANGS, hasLogo: existsSync(logoFile), notify: loadSettingsFile().notify ?? {}, secrets: secretNames(), secretProjects: secretProjects(), environments: loadEnvironments() });
  }
```

7. `/settings` POST: delete the line `if (SERVER_MODE && saved.some(...)) throw ...` (line 856).
8. `/projects` GET (lines 866-878): list every project; `role` and the maintainer-only spread go:

```js
    const all = listProjects(), ids = all.map(pr => pr.id);
    const runs = listRuns(ids);
    return json(res, all.map(({ db, ...pr }) => {
      const own = runs.filter(r => r.project === pr.id);
      return {
        ...pr, tests: listTests(pr.id).map(t => t.name), runs: own.length,
        last: own[0] ? { status: own[0].status, started: own[0].started } : null, recent: own.slice(0, 12).map(r => r.status),
        secrets: projectSecrets(pr.id), sessions: listSessions(pr.id),
        db, dbPassSet: Object.fromEntries(Object.keys(db ?? {}).map(e => [e, Boolean(process.env[dbPassKey(pr.id, e)])])),
      };
    }));
```

9. Project DELETE: remove `dropProjectMembers(id);`.
10. Workflow HTTP block (line 596): remove the `SERVER_MODE && …` condition and its `throw` (local mode never had it).
11. `/record` (line 981): remove `if (SERVER_MODE) throw …`.
12. `/fix` provider list (line 1040): `const providers = loadProviders();` — keep whatever the line does after the filter.
13. `listen(PORT, HOST, …)` → `listen(PORT, '127.0.0.1', () => { console.log(\`AI Browser Runner → http://127.0.0.1:${PORT}\`); });` (the setup-code log line goes).

Verify nothing is left:

Run: `grep -n "SERVER_MODE\|APP_HOSTS\|\bHOST\b\|setupCode\|sessionToken\|sessionCookie\|isLoopback\|\buser\b\|userId\|needAdmin\|needRun\|need(\|roleIn\|visibleProjects\|Members\|auth.mjs" app/server.mjs`
Expected: no output.

Delete the files and the npm script:

```bash
git rm -q app/auth.mjs app/reset-password.mjs app/test/auth.test.mjs
node -e "const f='package.json',p=require('./'+f);delete p.scripts['reset-password'];require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
```

- [ ] **Step 6: Migration check on an old database** (Review Focus 4)

Append to `app/test/server.integration.test.mjs` is not needed; add this to a new block in the same file, since it needs a DB with the old tables:

```js
test('migration: an app.db with accounts upgrades, history stays', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const file = join(mkdtempSync(join(tmpdir(), 'abr-old-')), 'app.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT, pass TEXT, admin INTEGER, must_change INTEGER, active INTEGER, created INTEGER);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER, expires INTEGER);
    CREATE TABLE members (project TEXT, user_id INTEGER, role TEXT);
    CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT, started INTEGER NOT NULL, user_id INTEGER, video TEXT, guide TEXT, data TEXT NOT NULL);
    INSERT INTO users VALUES (1,'a@b.c','A','x',1,0,1,0);
    INSERT INTO runs VALUES ('r1','zz-par-a',1,1,NULL,NULL,'{"id":"r1","project":"zz-par-a","started":1,"kind":"replay","status":"pass"}');
    PRAGMA user_version = 2;`);
  old.close();
  const upgraded = await startApp({ port: 4397, env: { APP_DB: file } });
  try {
    const runs = await (await upgraded.req('/history?project=zz-par-a')).json();
    assert.ok(runs.some(r => r.id === 'r1'));
    const db = new DatabaseSync(file, { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('users','sessions','members')").get().n, 0);
    db.close();
  } finally { upgraded.stop(); }
});
```

Before relying on `PRAGMA user_version = 2`: check how many steps `MIGRATIONS` in `app/store.mjs` had before this task (`node -e "…"` or count the entries). Set `user_version` to that count so only the new drop step runs. Check the history route name: `grep -n "p === '/history'" app/server.mjs`; use its real query parameter for the project.

- [ ] **Step 7: Run the tests and the boot check**

Run: `node --test app/test/*.test.mjs` then `PORT=4399 timeout 5 node app/server.mjs`
Expected: all PASS (auth tests are gone); boot prints `AI Browser Runner → http://127.0.0.1:4399`.

- [ ] **Step 8: Commit**

```bash
git add -A app/server.mjs app/store.mjs app/history.mjs app/test package.json
git commit -m "Standalone: no accounts, roles or server mode; the origin check guards the local API"
```

---

### Task 2: UI without sign-in, roles, members and users

**Files:**
- Modify: `app/app.js` (lines 32-39, 42-66, 70-82, 108, 125-130, 147-148, 171, 177, 191-212, 433, 582, 601, 666-676, 745-753, 816-821, 1010-1050), `app/index.html` (lines 15-30, 48-61, 72, 132, 146, 154, 156, 186, 195, 260-275, 308, 368-376, 383), `app/app.css` (auth/me styles)
- Create: `app/test/ui.integration.test.mjs`

**Interfaces:**
- Consumes: `startApp` from Task 1.

- [ ] **Step 1: Write the failing UI test**

```js
// app/test/ui.integration.test.mjs
// Opens the real page in headless Chromium: it must land on Projects with no sign-in and no script errors.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startApp } from './helpers/app-server.mjs';

let app, browser;
after(async () => { await browser?.close(); app?.stop(); });

test('the page opens on Projects without signing in', async () => {
  app = await startApp({ port: 4396 });
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(app.base);
  await page.locator('#shell').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.locator('#authView').count(), 0); // the sign-in screen is gone
  assert.equal(await page.locator('#newProject').isVisible(), true);
  await page.locator('.openSettings').click();
  assert.equal(await page.locator('#tabUsersBtn').count(), 0);
  assert.deepEqual(errors, []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test app/test/ui.integration.test.mjs`
Expected: FAIL: `#shell` stays hidden (the page calls `/auth/me`, which no longer exists after Task 1, and shows the error on the auth screen).

- [ ] **Step 3: `index.html`**

- Delete `<main class="auth" id="authView">…</main>` (lines 15-30).
- In the sidebar foot, delete `<div class="me">…</div>` (lines 57-62) and the `data-need="admin"` attribute on `.openSettings`.
- Delete the Settings tab button `tabUsersBtn` (line 195) and the panel `<div class="tabpanel" id="tabUsers">…</div>` (lines 262-275).
- In the project dialog, delete from `<h3>Members</h3>` through the `memberAddBtn` row (lines 369-376); keep `<div id="projPeople">` with its "Saved login sessions" part.
- Remove every `data-need="…"` and `data-local` attribute (keep `data-proj`): `grep -n 'data-need\|data-local' app/index.html` → no output afterwards.
- `.shell` loses `hidden` (it is shown right away): `<div class="shell" id="shell">`.
- The Settings header (line 186) text "Shared by every project…" stays.

- [ ] **Step 4: `app.js`**

- Lines 32-39: replace with

```js
// elements marked data-proj show only inside a project (the sidebar's sections)
function applyRoles() {
  for (const el of document.querySelectorAll('[data-proj]')) el.hidden = !project;
}
```

- Lines 42-66 (auth screen, sign-out, change password): delete.
- `boot()` (lines 70-82):

```js
async function boot() {
  try {
    await loadSettings();
    $('model').value = saved.model || '';
    route();
  } catch (err) {
    $('projectList').innerHTML = `<div class="emptybox"><strong>The app could not load</strong>${esc(err.message)}. Check that the server is running (npm run app), then reload this page.</div>`;
  }
}
```

- Every `canDo('<role>')` → `true`, then simplify the expression by hand (e.g. `${canDo('tester') ? X : ''}` → `${X}`, `show(canDo('tester') ? 'ai' : 'history')` → `show('ai')`, `!canDo('tester')` → `false`).
- `me.admin || p.role === 'maintainer' ? A : B` → `A`; `me.admin ? A : B` → `A`; `...(me.admin ? [...] : [])` → `...[...]`; `$('projDelete').hidden = !p || !me.admin` → `$('projDelete').hidden = !p`.
- Project dialog members (lines 192-212): delete the member list loading/rendering and the `memberAddBtn` handler; keep sessions.
- Settings Users (lines 1010-1050): delete the users list, `nuAdd` handler, and the tab wiring for `tabUsers`.
- History search (line 745): `${r.task} ${r.provider ?? ''}`; line 753: remove the `r.by` part of the sub-line.

Verify: `grep -n "canDo\|\bme\b\.\|me?\.\|serverMode\|/auth/\|/users\|members\|mustChange\|authView\|signOut\|changePw\|meName\|meAvatar\|nuAdd\|\.role\b\|\.by\b" app/app.js` → no output.

- [ ] **Step 5: `app.css`**

Delete the rules for `.auth`, `.auth-card`, `.me`, `.avatar`, `.me-name` (`grep -n "\.auth\|\.me\b\|\.me-name\|\.avatar" app/app.css`).

- [ ] **Step 6: Run the tests**

Run: `node --test app/test/*.test.mjs`
Expected: all PASS, including `ui.integration.test.mjs`.

- [ ] **Step 7: Commit**

```bash
git add app/app.js app/index.html app/app.css app/test/ui.integration.test.mjs
git commit -m "Standalone UI: opens straight into Projects; no sign-in, roles, members or users"
```

---

### Task 3: `app/bundle.mjs` (pack, validate, unpack, missing values)

**Files:**
- Create: `app/bundle.mjs`, `app/test/bundle.test.mjs`

**Interfaces:**
- Produces:
  - `packProject(dir: string, project: object, secretNames: string[]) → bundle` — `project` is the parsed `project.json` plus `id`; reads every file under `dir` except `project.json`.
  - `unpackBundle(bundle: unknown) → { project: object, secrets: string[], files: { path: string, data: Buffer }[] }` — throws `Error` with a readable message on anything invalid; never touches the disk.
  - `missingVars(files: { path, data }[], envs: { vars: object }[]) → string[]` — sorted, unique.
  - `BUNDLE_FORMAT = 'ai-browser-runner-project'`, `BUNDLE_VERSION = 1`.

- [ ] **Step 1: Write the failing tests**

```js
// app/test/bundle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packProject, unpackBundle, missingVars } from '../bundle.mjs';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
function sampleDir() {
  const dir = mkdtempSync(join(tmpdir(), 'abr-bundle-'));
  writeFileSync(join(dir, 'project.json'), '{"name":"Shop"}');
  writeFileSync(join(dir, 'login.spec.ts'), "await page.goto('{{shopUrl}}/login');\nfill('{{today}} {{data.user}} {{APP_PASS}}');");
  mkdirSync(join(dir, 'data')); writeFileSync(join(dir, 'data', 'login.csv'), 'user\nann\n');
  mkdirSync(join(dir, 'workflows')); writeFileSync(join(dir, 'workflows', 'buy.json'), '{"name":"Buy","blocks":[{"prompt":"{{params.x}} {{blocks.a.b}} {{item.name}} {{baseUrl}}"}]}');
  mkdirSync(join(dir, 'login.spec.ts-snapshots')); writeFileSync(join(dir, 'login.spec.ts-snapshots', 'home.png'), png);
  return dir;
}
const good = () => packProject(sampleDir(), { id: 'shop', name: 'Shop' }, ['APP_PASS']);

test('pack → unpack gives back the same bytes, text and PNG', () => {
  const b = good();
  assert.equal(b.format, 'ai-browser-runner-project'); assert.equal(b.version, 1);
  assert.deepEqual(b.secrets, ['APP_PASS']);
  assert.equal(b.files['project.json'], undefined);
  const out = unpackBundle(JSON.parse(JSON.stringify(b)));
  const byPath = Object.fromEntries(out.files.map(f => [f.path, f.data]));
  assert.deepEqual(Object.keys(byPath).sort(), ['data/login.csv', 'login.spec.ts', 'login.spec.ts-snapshots/home.png', 'workflows/buy.json']);
  assert.deepEqual(byPath['login.spec.ts-snapshots/home.png'], png);
  assert.equal(byPath['data/login.csv'].toString(), 'user\nann\n');
  assert.equal(out.project.id, 'shop');
});

const withFile = (path, entry) => { const b = good(); b.files[path] = entry; return b; };
const bad = [
  ['path with ..', withFile('../x.spec.ts', { text: '' }), /not allowed/],
  ['absolute path', withFile('/etc/x.spec.ts', { text: '' }), /not allowed/],
  ['windows drive', withFile('C:\\x.spec.ts', { text: '' }), /not allowed/],
  ['backslash', withFile('data\\x.csv', { text: '' }), /not allowed/],
  ['shell script', withFile('data/x.sh', { text: '' }), /not allowed/],
  ['test under data/', withFile('data/x.spec.ts', { text: '' }), /not allowed/],
  ['png as text', withFile('login.spec.ts-snapshots/a.png', { text: 'x' }), /base64/],
  ['both text and base64', withFile('a.spec.ts', { text: 'x', base64: 'eA==' }), /exactly one/],
  ['wrong format', { ...good(), format: 'zip' }, /not an AI Browser Runner project file/],
  ['wrong version', { ...good(), version: 2 }, /version 2/],
  ['bad project id', { ...good(), project: { id: '../x', name: 'X' } }, /project id/],
  ['not an object', 'hello', /not an AI Browser Runner project file/],
];
for (const [name, bundle, message] of bad)
  test(`rejects: ${name}`, () => assert.throws(() => unpackBundle(bundle), message));

test('missingVars: environment values that no environment has; built-ins and secrets are not reported', () => {
  const { files } = unpackBundle(good());
  assert.deepEqual(missingVars(files, [{ vars: { appUrl: 'x' } }]), ['baseUrl', 'shopUrl']);
  assert.deepEqual(missingVars(files, [{ vars: { shopUrl: 'x' } }, { vars: { baseUrl: 'y' } }]), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test app/test/bundle.test.mjs`
Expected: FAIL, `Cannot find module '.../app/bundle.mjs'`

- [ ] **Step 3: Implement**

```js
// app/bundle.mjs
// A project as one JSON file (<id>.abr.json) to hand to someone else, and the checks an imported file must
// pass. An imported file comes from another person: nothing in it is trusted until unpackBundle accepts it.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const BUNDLE_FORMAT = 'ai-browser-runner-project';
export const BUNDLE_VERSION = 1;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/; // same rule as app/library.mjs
const SEG = '[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}';
// the only files a project folder holds; anything else (scripts, other folders) is refused
const ALLOWED = [
  { re: new RegExp(`^${SEG}\\.spec\\.ts$`), kind: 'text' },
  { re: new RegExp(`^data/${SEG}\\.csv$`), kind: 'text' },
  { re: new RegExp(`^workflows/${SEG}\\.json$`), kind: 'text' },
  { re: new RegExp(`^${SEG}\\.spec\\.ts-snapshots/${SEG}\\.png$`), kind: 'base64' },
];
const kindOf = path => (path.includes('..') ? undefined : ALLOWED.find(a => a.re.test(path))?.kind);

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));

export function packProject(dir, project, secretNames) {
  const files = {};
  for (const abs of walk(dir)) {
    const path = relative(dir, abs).split(sep).join('/');
    const kind = kindOf(path);
    if (!kind) continue; // project.json and anything the app does not share
    const data = readFileSync(abs);
    files[path] = kind === 'base64' ? { base64: data.toString('base64') } : { text: data.toString('utf8') };
  }
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exported: new Date().toISOString(), project, secrets: [...secretNames], files };
}

export function unpackBundle(b) {
  if (!b || typeof b !== 'object' || b.format !== BUNDLE_FORMAT) throw new Error('This is not an AI Browser Runner project file');
  if (b.version !== BUNDLE_VERSION) throw new Error(`This project file is version ${b.version}; this app reads version ${BUNDLE_VERSION}. Update the app.`);
  const project = b.project;
  if (!project || typeof project !== 'object' || !PROJECT_ID.test(String(project.id ?? ''))) throw new Error('The file has no valid project id');
  const secrets = Array.isArray(b.secrets) ? b.secrets.filter(n => /^[A-Z][A-Z0-9_]{0,59}$/.test(n)) : [];
  if (!b.files || typeof b.files !== 'object') throw new Error('The file lists no files');
  const files = Object.entries(b.files).map(([path, entry]) => {
    const kind = kindOf(path);
    if (!kind) throw new Error(`File "${path}" is not allowed in a project`);
    const has = ['text', 'base64'].filter(k => typeof entry?.[k] === 'string');
    if (has.length !== 1) throw new Error(`File "${path}" must have exactly one of text or base64`);
    if (has[0] !== kind) throw new Error(`File "${path}" must be stored as ${kind}`);
    return { path, data: kind === 'base64' ? Buffer.from(entry.base64, 'base64') : Buffer.from(entry.text, 'utf8') };
  });
  return { project, secrets, files };
}

// {{name}} values the imported files use that no environment on this laptop defines. Built-ins (vars-core)
// and workflow/data references are filled in by the app itself; UPPERCASE names are secrets.
const BUILT_IN = /^(today(\s*[+-]\s*\d+)?|now(\s.*)?|random|data\..+|params\..+|blocks\..+|item(\..+)?)$/;
export function missingVars(files, envs) {
  const defined = new Set(envs.flatMap(e => Object.keys(e.vars ?? {})));
  const used = new Set();
  for (const f of files) {
    if (f.path.endsWith('.png')) continue;
    for (const [, raw] of f.data.toString('utf8').matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
      const name = raw.trim();
      if (BUILT_IN.test(name) || /^[A-Z][A-Z0-9_]*$/.test(name)) continue;
      if (!defined.has(name)) used.add(name);
    }
  }
  return [...used].sort();
}
```

Before relying on `BUILT_IN`: open `app/vars-core.cjs` and check the exact forms of `now` (it takes a format: `name === 'now'` and a `fmt`). Adjust `now(\s.*)?` to the real syntax (e.g. `now:…` or `now|…`) so `{{now …}}` is never reported.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test app/test/bundle.test.mjs`
Expected: PASS, 15 tests

- [ ] **Step 5: Commit**

```bash
git add app/bundle.mjs app/test/bundle.test.mjs
git commit -m "Project bundle: pack, validate and unpack <id>.abr.json; report missing environment values"
```

---

### Task 4: Export and import in the server and the UI

**Files:**
- Modify: `app/server.mjs` (imports; `readBody`; routes after the project routes), `app/app.js`, `app/index.html`
- Create: `app/test/share.integration.test.mjs`

**Interfaces:**
- Consumes: `packProject`, `unpackBundle`, `missingVars` (Task 3); `startApp` (Task 1).
- Produces (HTTP): `GET /projects/<id>/export` → the bundle with `content-disposition: attachment; filename="<id>.abr.json"`; `POST /projects/import` body `{ bundle, mode?: 'overwrite' | 'new' }` → `200 { id, files, missingSecrets, missingVars, skippedDb }` or `409 { conflict, suggestion }`.

- [ ] **Step 1: Write the failing integration test**

```js
// app/test/share.integration.test.mjs
// Export a project over HTTP, import it back (conflict, as new, overwrite), and replay the imported test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

let app;
const ids = ['zz-share', 'zz-share-2'];
before(async () => {
  app = await startApp({ port: 4395 });
  const dir = join(app.root, 'tests', 'zz-share');
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: 'Share', db: { nowhere: { type: 'postgres', host: 'localhost', port: 5432, database: 'x_e2e', user: 'u' } } }));
  writeFileSync(join(dir, 'hello.spec.ts'), `import { test, expect } from '@playwright/test';
test('hello', async ({ page }) => { await page.setContent('<h1>{{unknownUrl}}</h1>'.replace('{{unknownUrl}}', 'hi')); await expect(page.getByRole('heading', { name: 'hi' })).toBeVisible(); });`);
  writeFileSync(join(dir, 'data', 'hello.csv'), 'a\n1\n');
});
after(() => { app.stop(); for (const id of ids) rmSync(join(app.root, 'tests', id), { recursive: true, force: true }); });

const post = body => app.req('/projects/import', { method: 'POST', body: JSON.stringify(body) });

test('export, then import: conflict, as new, overwrite; a bad file writes nothing', async () => {
  const r = await app.req('/projects/zz-share/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="zz-share\.abr\.json"/);
  const bundle = await r.json();
  assert.deepEqual(Object.keys(bundle.files).sort(), ['data/hello.csv', 'hello.spec.ts']);

  const conflict = await post({ bundle });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { conflict: 'zz-share', suggestion: 'zz-share-2' });

  const asNew = await post({ bundle, mode: 'new' });
  assert.equal(asNew.status, 200);
  const sum = await asNew.json();
  assert.equal(sum.id, 'zz-share-2'); assert.equal(sum.files, 2);
  assert.deepEqual(sum.missingVars, ['unknownUrl']);
  assert.deepEqual(sum.skippedDb, ['nowhere']); // no such environment on this laptop
  const list = await (await app.req('/projects')).json();
  assert.equal(list.find(p => p.id === 'zz-share-2').name, 'Share (2)');

  // overwrite replaces the files and keeps the project's history (Review Focus 3)
  delete bundle.files['data/hello.csv'];
  const over = await post({ bundle: { ...bundle, project: { ...bundle.project, id: 'zz-share-2' } }, mode: 'overwrite' });
  assert.equal(over.status, 200);
  assert.equal(existsSync(join(app.root, 'tests', 'zz-share-2', 'data', 'hello.csv')), false);

  // a rejected file writes nothing (Review Focus 2)
  const before = readdirSync(join(app.root, 'tests')).sort();
  const evil = await post({ bundle: { ...bundle, project: { ...bundle.project, id: 'zz-evil' }, files: { ...bundle.files, '../../x.spec.ts': { text: 'x' } } }, mode: 'new' });
  assert.equal(evil.status, 400);
  assert.deepEqual(readdirSync(join(app.root, 'tests')).sort(), before);
});

test('the imported test replays and passes', async () => {
  const r = await app.req(`/replay?${new URLSearchParams({ project: 'zz-share-2', tests: 'hello', record: '0', guide: '0' })}`);
  const text = await r.text();
  assert.match(text, /event: saved/);
  assert.match(text, /"status":"passed"/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test app/test/share.integration.test.mjs`
Expected: FAIL: `/projects/zz-share/export` answers 404.

- [ ] **Step 3: Server routes**

In `app/server.mjs`:

```js
import { packProject, unpackBundle, missingVars } from './bundle.mjs';
```

`readBody` gets a limit parameter (default unchanged):

```js
const readBody = (req, limit = 500_000) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', c => { body += c; if (body.length > limit) { reject(new Error('Request body too large')); req.destroy(); } });
```

Add after the project DELETE route:

```js
  /* ----- share a project as one file ----- */
  const expMatch = p.match(/^\/projects\/([a-z0-9-]+)\/export$/);
  if (expMatch && m === 'GET') {
    const id = expMatch[1];
    const { id: _, ...meta } = readProject(id);
    const bundle = packProject(projectDir(id), { id, ...meta }, projectSecrets(id));
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${id}.abr.json"` });
    return res.end(JSON.stringify(bundle));
  }
  if (p === '/projects/import' && m === 'POST') {
    const { bundle, mode } = await readBody(req, 20_000_000);
    const { project, secrets, files } = unpackBundle(bundle); // throws before anything is written
    const envNames = new Set(loadEnvironments().map(e => e.name));
    const skippedDb = Object.keys(project.db ?? {}).filter(e => !envNames.has(e));
    const db = validDb(Object.fromEntries(Object.entries(project.db ?? {}).filter(([e]) => envNames.has(e))));
    const taken = id => listProjects().some(pr => pr.id === id) || existsSync(join(testsDir, id));
    let id = project.id, name = project.name;
    if (taken(id) && mode !== 'overwrite') {
      let n = 2; while (taken(`${project.id}-${n}`)) n++;
      if (mode !== 'new') return json(res, { conflict: id, suggestion: `${project.id}-${n}` }, 409);
      id = `${project.id}-${n}`; name = `${project.name} (${n})`;
    }
    const dir = join(testsDir, id);
    if (mode === 'overwrite' && existsSync(dir)) for (const f of readdirSync(dir)) if (f !== 'project.json') rmSync(join(dir, f), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const { created } = existsSync(join(dir, 'project.json')) ? JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) : {};
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ name, description: project.description ?? '', url: project.url ?? '', env: envNames.has(project.env) ? project.env : '', ...(Object.keys(db).length && { db }), created: created ?? Date.now() }, null, 2) + '\n');
    for (const f of files) { mkdirSync(join(dir, f.path, '..'), { recursive: true }); writeFileSync(join(dir, f.path), f.data); }
    // bind the secrets this laptop already has; report the rest
    const have = new Set(secretNames()), scopes = secretProjects();
    for (const n of secrets.filter(n => have.has(n))) scopes[n] = [...new Set([...(scopes[n] ?? []), id])];
    writeFileSync(settingsPath, JSON.stringify({ ...loadSettingsFile(), secretProjects: scopes }, null, 2) + '\n');
    return json(res, { id, files: files.length, missingSecrets: secrets.filter(n => !have.has(n)), missingVars: missingVars(files, loadEnvironments()), skippedDb });
  }
```

Check imports at the top of `app/server.mjs`: `testsDir` from `./library.mjs` (add to its import list if missing); `readdirSync`, `rmSync`, `mkdirSync`, `writeFileSync`, `readFileSync`, `existsSync` from `node:fs` are already imported (verify with `sed -n 3p app/server.mjs`).

Note on `fail()`: `unpackBundle` and `validDb` throw plain `Error`s, so `route`'s catch answers `400` with the message, which is what the test expects.

- [ ] **Step 4: UI**

`app/index.html`:
- Projects page actions (line 72): add next to `#newProject`:
  `<button type="button" class="btn ghost" id="importProject">Import</button><input type="file" id="importFile" accept=".json,application/json" hidden>`
- Project dialog (near `#projDelete`, line 383): add `<button type="button" class="link" id="projExport">Export project</button>`.

`app/app.js`:

```js
/* ---------- share a project as a file ---------- */
$('projExport').onclick = () => { location.href = `/projects/${encodeURIComponent(editingProject.id)}/export`; };
$('importProject').onclick = () => $('importFile').click();
$('importFile').onchange = async () => {
  const f = $('importFile').files[0]; $('importFile').value = '';
  if (!f) return;
  try {
    const bundle = JSON.parse(await f.text());
    const names = Object.keys(bundle.files ?? {});
    if (!confirm(`Import "${bundle.project?.name ?? f.name}" (${names.length} files)?\n\n${names.slice(0, 20).join('\n')}${names.length > 20 ? '\n…' : ''}\n\nTest files are code that runs on this computer: import only files from people you trust.`)) return;
    const send = mode => fetch('/projects/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bundle, mode }) });
    let r = await send();
    if (r.status === 409) {
      const { conflict, suggestion } = await r.json();
      const overwrite = confirm(`A project "${conflict}" already exists.\n\nOK: overwrite its tests (history and sessions stay)\nCancel: import as a new project "${suggestion}"`);
      r = await send(overwrite ? 'overwrite' : 'new');
    }
    if (!r.ok) throw new Error(await r.text());
    const s = await r.json();
    const todo = [
      s.missingSecrets.length && `Secrets to add (Settings → Secrets): ${s.missingSecrets.join(', ')}`,
      s.missingVars.length && `Environment values to add (Settings → Environments): ${s.missingVars.join(', ')}`,
      s.skippedDb.length && `Database settings skipped for environments you do not have: ${s.skippedDb.join(', ')}`,
    ].filter(Boolean);
    toast(`Imported ${s.files} files into "${s.id}".${todo.length ? ' ' + todo.join('. ') + '.' : ''}`);
    location.hash = `#/p/${s.id}`; route();
  } catch (err) { toast(`Import failed: ${err.message}`); }
};
```

(`toast` exists in `app/app.js`; `editingProject` is the project dialog's current project — check the name with `grep -n "editingProject" app/app.js`.)

- [ ] **Step 5: Run the tests**

Run: `node --test app/test/*.test.mjs`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add app/server.mjs app/app.js app/index.html app/test/share.integration.test.mjs
git commit -m "Export a project as <id>.abr.json and import it (overwrite or as new), with a summary of what to fill in"
```

---

### Task 5: `npm run setup`

**Files:**
- Create: `app/setup.mjs`, `app/test/setup.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `nodeOk(version: string, floor = '22.13.0') → boolean`, `hasLibx264(encodersOutput: string) → boolean` exported from `app/setup.mjs`; running the file directly performs the checks.

- [ ] **Step 1: Write the failing tests**

```js
// app/test/setup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeOk, hasLibx264 } from '../setup.mjs';

test('nodeOk: 22.13.0 is the floor', () => {
  assert.equal(nodeOk('v22.12.0'), false);
  assert.equal(nodeOk('v22.13.0'), true);
  assert.equal(nodeOk('v24.3.0'), true);
  assert.equal(nodeOk('v20.19.1'), false);
});

test('hasLibx264: reads ffmpeg -encoders output', () => {
  assert.equal(hasLibx264(' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)\n V....D mjpeg'), true);
  assert.equal(hasLibx264(' V....D mpeg4                MPEG-4 part 2\n'), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test app/test/setup.test.mjs`
Expected: FAIL, `Cannot find module '.../app/setup.mjs'`

- [ ] **Step 3: Implement**

```js
// app/setup.mjs
// npm run setup: checks what the app needs on this computer and installs the browsers. ❌ stops (exit 1),
// ⚠️ is a feature that will not work until fixed. Importing the file (tests) runs nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const nodeOk = (version, floor = '22.13.0') => {
  const a = version.replace(/^v/, '').split('.').map(Number), b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
export const hasLibx264 = out => /^\s*V\S*\s+libx264\b/m.test(out);

const HOW = {
  node: { win32: 'winget install OpenJS.NodeJS.LTS', darwin: 'brew install node', linux: 'https://nodejs.org (or your package manager)' },
  ffmpeg: { win32: 'winget install ffmpeg', darwin: 'brew install ffmpeg', linux: 'sudo apt install ffmpeg' },
};
const how = what => HOW[what][process.platform] ?? HOW[what].linux;

function main() {
  const root = join(import.meta.dirname, '..');
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  let failed = false;
  const ok = m => console.log(`✅ ${m}`), warn = m => console.log(`⚠️  ${m}`), bad = m => { console.log(`❌ ${m}`); failed = true; };

  if (nodeOk(process.version)) ok(`Node ${process.version}`); else bad(`Node ${process.version} is too old: 22.13 or newer is needed. Install: ${how('node')}`);

  // Two Playwright copies need their own Chromium: the test runner's and Playwright MCP's
  for (const [label, cli] of [['test runner', 'node_modules/@playwright/test/cli.js'], ['AI browser (Playwright MCP)', 'node_modules/@playwright/mcp/node_modules/playwright/cli.js']]) {
    if (!existsSync(join(root, cli))) { bad(`${label}: ${cli} is missing. Run npm install first.`); continue; }
    const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { cwd: root, stdio: 'inherit' });
    if (r.status === 0) ok(`Chromium for the ${label}`);
    else bad(`Chromium for the ${label} did not install.${process.platform === 'linux' ? ' Missing system libraries? Run: sudo npx playwright install-deps chromium' : ''}`);
  }

  const ff = run(process.env.FFMPEG ?? 'ffmpeg', ['-hide_banner', '-encoders']);
  if (ff.status === 0 && hasLibx264(ff.stdout)) ok('ffmpeg with libx264 (videos)');
  else warn(`ffmpeg with libx264 not found: runs work, videos will not. Install: ${how('ffmpeg')}`);

  const claude = run('claude', ['--version']);
  if (claude.status === 0) ok(`Claude Code ${claude.stdout.trim()}`);
  else warn('Claude Code not found: install it (https://claude.com/claude-code) and sign in, or add an API key in Settings → AI.');

  const env = join(root, '.env');
  if (!existsSync(env)) { writeFileSync(env, '# API keys and secrets, written by the app (Settings). Never commit this file.\n'); ok('.env created'); }

  console.log(failed ? '\nFix the ❌ items, then run npm run setup again.' : '\nReady: npm run app');
  process.exit(failed ? 1 : 0);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
```

`package.json` scripts: `"setup": "node app/setup.mjs"` (replaces the MCP-only Chromium install).

- [ ] **Step 4: Run to verify it passes, and run setup once**

Run: `node --test app/test/setup.test.mjs` → PASS, 2 tests.
Run: `npm run setup` → Expected: ✅ Node, ✅ Chromium ×2, ✅ or ⚠️ ffmpeg, ✅ or ⚠️ Claude Code, ends with "Ready: npm run app", exit code 0.

- [ ] **Step 5: Commit**

```bash
git add app/setup.mjs app/test/setup.test.mjs package.json
git commit -m "npm run setup: checks Node, installs both Chromium builds, checks ffmpeg and Claude Code, creates .env"
```

---

### Task 6: Windows process handling, and the README

**Files:**
- Create: `app/proc.mjs`, `app/test/proc.test.mjs`
- Modify: `app/replay.mjs:7,52-64`, `app/recorder.mjs:10,33`, `app/agents.mjs:13-22`, `README.md`

**Interfaces:**
- Produces:
  - `playwrightCli(root: string) → { command: string, args: string[] }` — `process.execPath` + `<root>/node_modules/@playwright/test/cli.js`.
  - `killTree(pid: number, { platform = process.platform, run = spawnSync, kill = process.kill } = {}) → void` — `win32`: `taskkill /pid <pid> /T /F`; else `kill(-pid, 'SIGTERM')`. Never throws.
  - `spawnOptions(platform = process.platform) → { shell?: true }` — `{ shell: true }` on `win32`, else `{}`; for commands installed as `.cmd` shims (`claude`).

- [ ] **Step 1: Write the failing tests**

```js
// app/test/proc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playwrightCli, killTree, spawnOptions } from '../proc.mjs';

test('playwrightCli runs the test runner through node, on every OS', () => {
  const c = playwrightCli('/app');
  assert.equal(c.command, process.execPath);
  assert.match(c.args[0].replaceAll('\\', '/'), /\/app\/node_modules\/@playwright\/test\/cli\.js$/);
});

test('killTree: taskkill /T /F on Windows, the process group elsewhere', () => {
  const calls = [];
  killTree(42, { platform: 'win32', run: (cmd, args) => calls.push([cmd, ...args]), kill: () => calls.push(['kill']) });
  assert.deepEqual(calls, [['taskkill', '/pid', '42', '/T', '/F']]);
  calls.length = 0;
  killTree(42, { platform: 'linux', run: () => calls.push(['run']), kill: (pid, sig) => calls.push(['kill', pid, sig]) });
  assert.deepEqual(calls, [['kill', -42, 'SIGTERM']]);
  assert.doesNotThrow(() => killTree(42, { platform: 'linux', kill: () => { throw new Error('ESRCH'); } }));
});

test('spawnOptions: a shell only on Windows (claude is claude.cmd there)', () => {
  assert.deepEqual(spawnOptions('win32'), { shell: true });
  assert.deepEqual(spawnOptions('darwin'), {});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test app/test/proc.test.mjs`
Expected: FAIL, `Cannot find module '.../app/proc.mjs'`

- [ ] **Step 3: Implement**

```js
// app/proc.mjs
// What differs between Windows and macOS/Linux when the app starts or stops other programs.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// node_modules/.bin/playwright is a shell script (a .cmd on Windows): run the CLI file with node instead
export const playwrightCli = root => ({ command: process.execPath, args: [join(root, 'node_modules', '@playwright', 'test', 'cli.js')] });

// Stop a runner and the browser it started. Windows has no process groups: taskkill /T ends the whole tree.
export function killTree(pid, { platform = process.platform, run = spawnSync, kill = process.kill } = {}) {
  try {
    if (platform === 'win32') run('taskkill', ['/pid', String(pid), '/T', '/F']);
    else kill(-pid, 'SIGTERM');
  } catch {} // already gone
}

// npm-installed commands (claude) are .cmd shims on Windows, which spawn only finds through a shell
export const spawnOptions = (platform = process.platform) => (platform === 'win32' ? { shell: true } : {});
```

- [ ] **Step 4: Use it**

`app/replay.mjs`: `import { playwrightCli, killTree } from './proc.mjs';`, delete `const bin = …` (line 7), and:

```js
    const { command, args: cli } = playwrightCli(root);
    const child = spawn(command, [...cli, 'test', ...files.map(f => relative(root, f)), '--config', 'app/replay.config.ts', /* rest of today's args unchanged */], {
      cwd: root,
      detached: process.platform !== 'win32', // own process group on macOS/Linux, so Stop can kill the runner and its browser together
      ...
    });
    signal.addEventListener('abort', () => killTree(child.pid));
```

`app/recorder.mjs`: `import { playwrightCli } from './proc.mjs';`, delete `const bin = …` (line 10), and line 33:

```js
  const { command, args: cli } = playwrightCli(root);
  const child = current = spawn(command, [...cli, ...args], { cwd: root, stdio: 'ignore', env: process.env });
```

`app/agents.mjs`: `import { spawnOptions } from './proc.mjs';` and add `...spawnOptions()` to the `spawn('claude', [...], { cwd, stdio: … })` options object. With `shell: true` Node joins the arguments into one command line, so every argument that can hold spaces must be quoted. Before shipping, check which `claude` arguments are free text (the prompt, the system prompt): if any is passed as an argument rather than on stdin, pass it on stdin on `win32` instead (`stdio: ['pipe', …]` and `child.stdin.end(prompt)`), since quoting arbitrary text for `cmd.exe` is not safe. Read `app/agents.mjs:11-30` first and record what you did as a ruling.

- [ ] **Step 5: README**

Replace the `## Setup` section with:

```markdown
## Install

AI Browser Runner runs on your own computer (Windows, macOS or Linux). You need:

- **Node.js 22.13 or newer**: Windows `winget install OpenJS.NodeJS.LTS`, macOS `brew install node`, Linux https://nodejs.org or your package manager.
- **ffmpeg** (for videos; everything else works without it): Windows `winget install ffmpeg`, macOS `brew install ffmpeg`, Linux `sudo apt install ffmpeg`.
- **An AI engine**: [Claude Code](https://claude.com/claude-code) signed in with your subscription, or an API key added later in Settings → AI.

Then, in the app's folder:

```bash
npm install
npm run setup   # checks the above and installs the browsers
npm run app     # http://127.0.0.1:4321
```

### Share a project

In a project, **Edit → Export project** saves `<project>.abr.json`. On another computer, **Projects → Import**
reads it. Secrets, database passwords, login sessions and run history are never in the file: after importing,
the app lists the secrets and environment values to add. Test files are code that runs on your computer:
import only files from people you trust.
```

Remove the `## Shared server (server mode)` section entirely; move its `**Parallel runs**` paragraph (the `MAX_RUNS` one) under "Using it". Search for leftovers: `grep -n "APP_MODE\|APP_HOSTS\|server mode\|reset-password\|sign in\|admin" README.md` → rewrite or delete each hit.

Add a section for the Windows smoke test (the fixes above cannot be tested on Linux):

```markdown
### Checking a Windows install

1. `npm run setup` shows ✅ for Node and both Chromium builds.
2. Import a project file and replay one of its tests: it passes and the live view shows the browser.
3. Start a long replay and press Stop: it stops, and Task Manager shows no Chromium left from it.
4. With Claude Code installed, start an AI run: it starts (no `spawn claude ENOENT`).
```

- [ ] **Step 6: Run the tests and the boot check**

Run: `node --test app/test/*.test.mjs` → all PASS (the replay/parallel/share integration tests now start the runner through `playwrightCli` and stop it through `killTree`).
Run: `PORT=4399 timeout 5 node app/server.mjs` → boots.

- [ ] **Step 7: Commit**

```bash
git add app/proc.mjs app/test/proc.test.mjs app/replay.mjs app/recorder.mjs app/agents.mjs README.md
git commit -m "Runs on Windows too: Playwright CLI through node, taskkill for Stop, claude through a shell; README install per OS"
```
