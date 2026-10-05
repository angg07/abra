// A run that waited in line and starts while you are on another page must not open a hidden live view (it would keep
// the screencast running for nobody); its chip opens the live view when you come back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-live-queued';
let app, browser;
after(async () => { await browser?.close(); if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });

test('a queued run that starts while you are elsewhere opens no live view; its chip brings it back', async () => {
  app = await startApp({ port: 4421, env: { MAX_RUNS: '1' } }); // one run at a time: the second waits in line
  const dir = join(app.root, 'tests', P);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: P }));
  writeFileSync(join(dir, 'slow.spec.ts'), `import { test } from '@playwright/test';
test('slow', async ({ page }) => {
  for (const n of ['one', 'two', 'three', 'four']) await test.step('Slow ' + n, async () => { await page.setContent('<h1>' + n + '</h1>'); await page.waitForTimeout(1500); });
});`);
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => { localStorage.setItem('last', JSON.stringify({ setupSeen: true })); });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${app.base}/#/p/${P}`);
  const runSlow = async () => { await page.locator('nav.views [data-view=tests]').click(); await page.locator('#testList .item[data-name=slow] [data-act=run]').click(); };
  await runSlow(); // the first run
  await page.locator('#steps').getByText('Slow one').waitFor({ timeout: 30_000 });
  await runSlow(); // the second one waits in line, its page on screen
  await page.locator('#status', { hasText: /Waiting/ }).waitFor();

  await page.locator('nav.views [data-view=history]').click(); // go elsewhere while it waits
  const screens = []; page.on('request', r => { if (r.url().includes('/screen')) screens.push(r.url()); });
  await page.locator('.live-chip').nth(0).waitFor();
  // the first run ends (~6 s), the second gets its slot and starts: two chips become one running chip
  await page.waitForFunction(() => document.querySelectorAll('.live-chip').length === 1, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  assert.deepEqual(screens, []); // nobody watches it: no live view opened

  await page.locator('.live-chip').first().click(); // back to the run
  await page.locator('#stage.has-frame').waitFor({ timeout: 5000 });
  assert.equal(screens.length, 1);
  assert.deepEqual(errors, []);
});
