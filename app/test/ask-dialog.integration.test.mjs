// One styled dialog for every confirmation: no browser confirm() or prompt() in the main flows
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-ask', P2 = 'zz-ask-gone';
let app, browser, page, errors, native;
before(async () => {
  app = await startApp({ port: 4436 });
  for (const p of [P, P2]) { mkdirSync(join(app.root, 'tests', p), { recursive: true }); writeFileSync(join(app.root, 'tests', p, 'project.json'), JSON.stringify({ name: p })); }
  for (const t of ['keep', 'drop']) writeFileSync(join(app.root, 'tests', P, `${t}.spec.ts`), `import { test } from '@playwright/test';\ntest('${t}', async () => {});\n`);
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => { if (!localStorage.getItem('last')) localStorage.setItem('last', JSON.stringify({ setupSeen: true })); });
  errors = []; native = 0;
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { native++; d.dismiss(); }); // a browser dialog is a failure here
});
after(async () => { await browser?.close(); if (app) for (const p of [P, P2]) rmSync(join(app.root, 'tests', p), { recursive: true, force: true }); app?.stop(); });
const ask = () => page.locator('#askDlg');

test('delete a test: Cancel keeps it, the danger button removes it', async () => {
  await page.goto(`${app.base}/#/p/${P}/tests`); await page.waitForFunction(() => window.__appStarted);
  const row = page.locator('#testList .item[data-name=drop]');
  await row.locator('[data-act=more]').click();
  await row.locator('.row-menu [data-act=del]').click();
  await ask().waitFor();
  assert.match(await ask().textContent(), /Delete test/);
  await ask().locator('[data-ask=cancel]').click();
  assert.equal(await row.count(), 1);
  await row.locator('[data-act=more]').click();
  await row.locator('.row-menu [data-act=del]').click();
  await ask().locator('[data-ask=ok]').click();
  await row.waitFor({ state: 'detached' });
  assert.equal(native, 0); assert.deepEqual(errors, []);
});

test('delete a project: OK stays off until the name is typed', async () => {
  await page.goto(`${app.base}/#/p/${P2}/ai`); await page.waitForFunction(() => window.__appStarted);
  await page.locator('#projSwitch').click();
  await page.locator('#projMenu [data-edit]').click();
  await page.locator('#projDelete').click();
  await ask().waitFor();
  assert.equal(await ask().locator('[data-ask=ok]').isDisabled(), true);
  await ask().locator('#askInput').fill('wrong');
  assert.equal(await ask().locator('[data-ask=ok]').isDisabled(), true);
  await ask().locator('#askInput').fill(P2);
  await ask().locator('[data-ask=ok]').click();
  await page.locator('#home').waitFor();
  assert.equal(existsSync(join(app.root, 'tests', P2)), false);
  assert.equal(native, 0); assert.deepEqual(errors, []);
});

test('leaving Settings with a change asks once; a second click meanwhile does nothing; Cancel stays', async () => {
  await page.goto(`${app.base}/#/p/${P}/ai`); await page.waitForFunction(() => window.__appStarted);
  await page.locator('.openSettings').first().click();
  await page.locator('#tabGuideBtn').click();
  await page.locator('#tabGuide textarea, #tabGuide input:not([type=file]):not([type=checkbox]):not([type=color])').first().fill('changed by the test');
  await page.locator('nav.views [data-view=tests]').click();
  await ask().waitFor();
  await page.locator('nav.views [data-view=history]').click({ force: true }); // the dialog is modal: this goes nowhere
  assert.equal(await page.locator('#askDlg[open]').count(), 1);
  await ask().locator('[data-ask=cancel]').click();
  assert.equal(await page.locator('#view-settings').isVisible(), true);
  assert.equal(await page.evaluate(() => location.hash), '#/settings');
  await page.locator('nav.views [data-view=tests]').click();
  await ask().locator('[data-ask=ok]').click();
  await page.locator('#view-tests').waitFor();
  assert.equal(native, 0); assert.deepEqual(errors, []);
});
