// Every page has its own address: Back/Forward, refresh and links open the same page; guards restore the address
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './helpers/app-server.mjs';
import { answerAsks, askLog } from './helpers/ask.mjs';

const P = 'zz-nav', P2 = 'zz-nav-2';
let app, browser, page, errors;
before(async () => {
  app = await startApp({ port: 4434 });
  for (const p of [P, P2]) { mkdirSync(join(app.root, 'tests', p), { recursive: true }); writeFileSync(join(app.root, 'tests', p, 'project.json'), JSON.stringify({ name: p })); }
  writeFileSync(join(app.root, 'tests', P, 't1.spec.ts'), "import { test } from '@playwright/test';\ntest('t1', async ({ page }) => { await page.setContent('<h1>x</h1>'); });\n");
  writeFileSync(join(app.root, 'tests', P, 'slow.spec.ts'), "import { test } from '@playwright/test';\ntest('slow', async ({ page }) => { await page.setContent('<h1>slow page</h1>'); await page.waitForTimeout(8000); });\n");
  const db = new DatabaseSync(app.dbFile);
  db.prepare('INSERT INTO runs (id, project, started, data) VALUES (?, ?, ?, ?)').run('nav-run', P, Date.now(), JSON.stringify({ id: 'nav-run', project: P, started: Date.now(), status: 'pass', kind: 'replay', title: 'Nav run', task: 'Replay: t1', testNames: ['t1'] }));
  db.close();
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => { if (!localStorage.getItem('last')) localStorage.setItem('last', JSON.stringify({ setupSeen: true })); });
  errors = []; page.on('pageerror', e => errors.push(e.message));
});
after(async () => { await browser?.close(); if (app) for (const p of [P, P2]) rmSync(join(app.root, 'tests', p), { recursive: true, force: true }); app?.stop(); });
const hash = () => page.evaluate(() => location.hash);

test('each page writes its address; Back, Forward and refresh come back to it', async () => {
  await page.goto(`${app.base}/#/p/${P}`); await page.waitForFunction(() => window.__appStarted);
  await page.locator('#view-ai').waitFor();
  await page.locator('nav.views [data-view=tests]').click();
  await page.locator('#view-tests').waitFor();
  assert.equal(await hash(), `#/p/${P}/tests`);
  await page.locator('nav.views [data-view=history]').click();
  assert.equal(await hash(), `#/p/${P}/history`);
  await page.locator('#historyList button.item', { hasText: 'Nav run' }).click();
  await page.locator('#view-run').waitFor();
  assert.equal(await hash(), `#/p/${P}/run/nav-run`);
  await page.goBack();
  await page.locator('#view-history').waitFor();
  assert.equal(await hash(), `#/p/${P}/history`);
  await page.goForward();
  await page.locator('#view-run').waitFor();
  await page.reload(); await page.waitForFunction(() => window.__appStarted);
  await page.locator('#view-run #runTitle', { hasText: 'Nav run' }).waitFor(); // a link to a run opens it
  await page.goto(`${app.base}/#/p/${P}/tests`); await page.locator('#view-tests').waitFor();
  await page.locator('.openSettings').first().click();
  await page.locator('#view-settings').waitFor();
  assert.equal(await hash(), '#/settings');
  await page.locator('#openSetup').click(); await page.locator('#view-setup').waitFor();
  assert.equal(await hash(), '#/requirements');
  await page.locator('#reportProblem').click(); await page.locator('#view-report').waitFor();
  assert.equal(await hash(), '#/report');
  await page.goBack(); await page.locator('#view-setup').waitFor();
  await page.locator('.side-top a.brand').click();
  await page.locator('#home').waitFor(); assert.equal(await hash(), '#/');
  assert.deepEqual(errors, []);
});

test('the switcher keeps the page; a finished live run address lands on History; a guarded Back restores the address', async () => {
  await page.goto(`${app.base}/#/p/${P}/tests`); await page.waitForFunction(() => window.__appStarted);
  await page.locator('#view-tests').waitFor();
  await page.locator('#projSwitch').click();
  await page.locator(`#projMenu [data-go=${P2}]`).click();
  await page.locator('#projName', { hasText: P2 }).waitFor();
  await page.locator('#view-tests').waitFor();
  assert.equal(await hash(), `#/p/${P2}/tests`);
  await page.locator('#toast', { hasText: `Switched to ${P2}` }).waitFor();
  await page.goto(`${app.base}/#/p/${P}/run/live`); await page.waitForFunction(() => window.__appStarted);
  await page.locator('#view-history').waitFor(); // no live run here: History
  assert.equal(await hash(), `#/p/${P}/history`);
  // Settings with a change, then Back, then Cancel: still Settings, still its address
  await page.locator('.openSettings').first().click();
  await page.locator('#tabGuideBtn').click();
  await page.locator('#tabGuide textarea, #tabGuide input:not([type=file]):not([type=checkbox]):not([type=color])').first().fill('changed by the test');
  await answerAsks(page, 'cancel');
  await page.goBack();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#view-settings').isVisible(), true);
  assert.equal(await hash(), '#/settings');
  await answerAsks(page, 'ok');
  await page.locator('nav.views [data-view=ai]').click();
  await page.locator('#view-ai').waitFor();
  await answerAsks(page, null);
  assert.deepEqual(errors, []);
});

test('a live replay shows Test X of Y, Back leaves it running as a chip, the chip brings it back', async () => {
  await page.goto(`${app.base}/#/p/${P}/tests`); await page.waitForFunction(() => window.__appStarted);
  await page.locator('#view-tests').waitFor();
  await page.locator('#runOptions').click();
  await page.locator('#replayRepeat').selectOption('3');
  await page.locator('#testList .item[data-name=t1] input[type=checkbox]').check();
  await page.locator('#runSelected').click();
  await page.locator('#progress', { hasText: /of 3 tests/ }).waitFor();
  assert.equal(await page.locator('#back').isVisible(), true); // Back stays during the run
  assert.match(await hash(), /\/run\/live$/);
  await page.locator('#back').click();
  await page.locator('#view-tests').waitFor();
  await page.locator('#liveChips .live-chip').click();
  await page.locator('#progress').waitFor();
  await page.locator('#result').waitFor({ timeout: 60_000 });
  assert.equal(await page.locator('#progress').isVisible(), false); // gone when the run ends
  assert.match(await hash(), /\/run\/[0-9T-]+-replay-/); // the saved run's address
  assert.deepEqual(errors, []);
});

test('Stop: a toast, a summary, and the last frame stays on the stage', async () => {
  await page.goto(`${app.base}/#/p/${P}/tests`); await page.waitForFunction(() => window.__appStarted);
  await page.locator('#testList .item[data-name=slow] [data-act=run]').click();
  await page.waitForFunction(() => document.getElementById('stage').classList.contains('has-frame'), null, { timeout: 30_000 });
  await page.locator('#stop').click();
  await page.locator('#toast', { hasText: 'Run stopped' }).waitFor();
  await page.locator('#result').waitFor({ timeout: 60_000 });
  assert.match(await page.locator('#result').textContent(), /Stopped/);
  assert.equal(await page.evaluate(() => document.getElementById('stage').classList.contains('has-frame')), true); // not back to "Waiting for the browser"
  assert.deepEqual(errors, []);
});
