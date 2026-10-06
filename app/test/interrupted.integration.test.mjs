// The app starts after being cut off mid-run: History shows that run as interrupted and its scratch folder is gone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-interrupted', ID = '2026-10-03T09-25-03-ai-zzzzzz';
const dbFile = join(mkdtempSync(join(tmpdir(), 'abr-int-')), 'app.db');
let app;
after(() => { if (app) { rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app.stop(); } });

test('a run left running by a killed app is interrupted at the next start, and its live folder removed', async () => {
  app = await startApp({ port: 4418, env: { APP_DB: dbFile } }); // creates the database
  app.stop();
  mkdirSync(join(app.root, 'tests', P), { recursive: true });
  writeFileSync(join(app.root, 'tests', P, 'project.json'), JSON.stringify({ name: P }));
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO runs (id, project, started, data) VALUES (?, ?, ?, ?)')
    .run(ID, P, 1, JSON.stringify({ id: ID, kind: 'ai', project: P, started: 1, status: 'running', task: 'Cut off by the OOM killer' }));
  db.close();
  const live = join(app.root, 'app', 'data', 'live', ID);
  mkdirSync(live, { recursive: true });
  app = await startApp({ port: 4419, env: { APP_DB: dbFile } });
  const runs = await (await app.req(`/history?project=${P}`)).json();
  assert.deepEqual(runs.map(r => [r.id, r.status]), [[ID, 'interrupted']]);
  assert.match(runs[0].error, /ran out of memory/);
  assert.equal(existsSync(live), false);
  // opened from History it reads "Interrupted", never "undefined"
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem('last', JSON.stringify({ setupSeen: true })));
    await page.goto(`${app.base}/#/p/${P}`);
    await page.locator('nav.views [data-view=history]').click();
    await page.locator(`#historyList button.item[data-id="${ID}"]`).click();
    const result = page.locator('#result');
    await result.waitFor();
    assert.match(await result.locator('.result-top b').textContent(), /Interrupted/);
    assert.doesNotMatch(await result.textContent(), /undefined/);
  } finally { await browser.close(); }
});

test('a second start of the app (port taken) leaves the running app\'s runs and folders alone', async () => {
  const db2 = join(mkdtempSync(join(tmpdir(), 'abr-int2-')), 'app.db'), ID2 = '2026-10-03T10-00-00-ai-yyyyyy';
  const first = await startApp({ port: 4420, env: { APP_DB: db2 } });
  const live = join(first.root, 'app', 'data', 'live', ID2);
  try {
    const db = new DatabaseSync(db2);
    db.prepare('INSERT INTO runs (id, project, started, data) VALUES (?, ?, ?, ?)')
      .run(ID2, P, 1, JSON.stringify({ id: ID2, kind: 'ai', project: P, started: 1, status: 'running', task: 'Still going' }));
    mkdirSync(live, { recursive: true });
    const second = await startApp({ port: 4420, env: { APP_DB: db2 } }); // prints "ABRA is already running" and exits
    await new Promise(r => setTimeout(r, 500));
    second.stop();
    const row = JSON.parse(db.prepare('SELECT data FROM runs WHERE id = ?').get(ID2).data);
    db.close();
    assert.equal(row.status, 'running');
    assert.equal(existsSync(live), true);
  } finally { rmSync(live, { recursive: true, force: true }); first.stop(); }
});
