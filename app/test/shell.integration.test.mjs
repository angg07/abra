// The shell: phone bottom nav and drawer, the Requirements badge, the N shortcut
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-shell';
let app, browser;
after(async () => { await browser?.close(); if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });
async function open(viewport) {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(() => { if (!localStorage.getItem('last')) localStorage.setItem('last', JSON.stringify({ setupSeen: true })); });
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.goto(`${app.base}/#/p/${P}`);
  await page.waitForFunction(() => window.__appStarted);
  await page.locator('#view-ai').waitFor();
  return page;
}
const isOpen = page => page.locator('#side').evaluate(e => e.classList.contains('open'));

test('phone: bottom nav switches views, More opens the drawer, Esc, the scrim and X close it', async () => {
  app = await startApp({ port: 4427 });
  mkdirSync(join(app.root, 'tests', P), { recursive: true }); writeFileSync(join(app.root, 'tests', P, 'project.json'), JSON.stringify({ name: P }));
  browser = await chromium.launch();
  const page = await open({ width: 375, height: 800 });
  assert.equal(await page.locator('#side').isVisible(), false); // off-canvas until opened
  await page.locator('.bottomnav [data-view=tests]').click();
  await page.locator('#view-tests').waitFor();
  assert.equal(await page.locator('.bottomnav [data-view=tests]').getAttribute('aria-current'), 'page');
  await page.locator('#moreBtn').click();
  await page.locator('#scrim.open').waitFor();
  assert.equal(await isOpen(page), true);
  await page.keyboard.press('Escape');
  assert.equal(await isOpen(page), false);
  await page.locator('#moreBtn').click();
  await page.locator('#scrim').click({ position: { x: 360, y: 400 } });
  assert.equal(await isOpen(page), false);
  await page.locator('#sideToggle').click(); // the top bar's menu button
  await page.locator('#side .side-close').click();
  assert.equal(await isOpen(page), false);
  await page.locator('#moreBtn').click();
  await page.locator('nav.views [data-view=history]').click(); // a section closes the drawer
  assert.equal(await isOpen(page), false);
  assert.ok(await page.evaluate(() => document.getElementById('scroll').scrollWidth <= innerWidth));
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('desktop: no bottom nav, no drawer X; N opens Run AI unless typing; the badge counts tools to fix', async () => {
  const page = await open({ width: 1440, height: 900 });
  assert.equal(await page.locator('.bottomnav').isVisible(), false);
  assert.equal(await page.locator('#side .side-close').isVisible(), false);
  await page.locator('nav.views [data-view=tests]').click();
  await page.locator('#testSearch').click();
  await page.keyboard.press('n');
  assert.equal(await page.inputValue('#testSearch'), 'n'); // typing stays typing
  assert.equal(await page.locator('#view-tests').isVisible(), true);
  await page.locator('#testSearch').blur();
  await page.keyboard.press('n');
  await page.locator('#view-ai').waitFor();
  const items = (await (await app.req('/setup/status')).json()).items;
  const want = items.filter(i => i.status === 'bad' || i.status === 'warn').length;
  await page.waitForFunction(w => document.getElementById('reqBadge').hidden === !w, want);
  if (want) assert.equal(await page.locator('#reqBadge').textContent(), String(want));
  assert.deepEqual(page.errors, []);
  await page.close();
});
