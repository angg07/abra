// Boots the real server on a spare port with a throwaway database and replays tests over HTTP (headless
// Chromium): about 20 seconds. Runs side by side, the line beyond MAX_RUNS, the live view by run id,
// "Save login session" staying inside its project, and the origin check that replaces a login.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
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

// fetch() will not send a made-up Host or Sec-Fetch-Site header, so these go through node:http
const rawStatus = (path, headers) => new Promise((ok, fail) => http.get({ host: '127.0.0.1', port: 4398, path, headers }, r => { r.resume(); ok(r.statusCode); }).on('error', fail));
test('the API needs the page cookie: a request from another site (even an old browser, even a GET) is refused', async () => {
  assert.equal(await rawStatus('/projects', {}), 403); // no cookie: not opened from the app's own page
  assert.equal(await rawStatus('/replay?project=zz-par-a&tests=slow', {}), 403); // an <img src> would start a run
  assert.equal(await rawStatus('/', {}), 200); // the page itself hands out the cookie
});

test('origin: other sites and foreign host names are refused', async () => {
  assert.equal(await rawStatus('/projects', { 'sec-fetch-site': 'cross-site', cookie: app.cookie }), 403);
  assert.equal(await rawStatus('/projects', { host: 'evil.example:4398', cookie: app.cookie }), 403);
  assert.equal(await rawStatus('/projects', { 'sec-fetch-site': 'same-origin', cookie: app.cookie }), 200);
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
    PRAGMA user_version = 1;`); // the schema before the standalone app: one migration step
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
