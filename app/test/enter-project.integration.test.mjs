// Opening a project: a section picked while the project is still loading stays open,
// instead of being replaced by the default Run AI page when loading finishes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-enter-project';
let app, browser;
after(async () => { await browser?.close(); if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });

test('a section clicked while the project loads is not replaced by Run AI', async () => {
  app = await startApp({ port: 4413 });
  const dir = join(app.root, 'tests', P);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: P }));
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('last', JSON.stringify({ setupSeen: true })));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(app.base + '/');
  await page.waitForFunction(() => window.__appStarted);
  // a slow /settings keeps the project loading long enough to click a section in between
  let slow = true;
  await page.route('**/settings', async r => { if (slow) await new Promise(ok => setTimeout(ok, 800)); r.continue(); });
  await page.evaluate(p => { location.hash = `#/p/${p}`; }, P);
  await page.locator('nav.views [data-view=tests]').click();
  await page.waitForTimeout(1200);
  slow = false;
  assert.equal(await page.locator('#view-tests').isVisible(), true);
  assert.equal(await page.locator('#view-ai').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('the project sections stay hidden until the project is known (no click on them with no project yet)', async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('last', JSON.stringify({ setupSeen: true })));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let release; const slow = new Promise(r => { release = r; });
  await page.route('**/projects', async r => { await slow; r.continue(); }); // the project list arrives late
  await page.goto(`${app.base}/#/p/${P}`);
  await page.waitForFunction(() => window.__appStarted);
  assert.equal(await page.locator('nav.views [data-view=tests]').isVisible(), false);
  release();
  await page.locator('nav.views [data-view=tests]').waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});
