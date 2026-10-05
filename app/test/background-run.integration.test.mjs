// "Show browser" off: a saved test runs in the background, you stay where you are, and no live view is opened.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-background', P2 = 'zz-background-2';
let app, browser;
after(async () => { await browser?.close(); if (app) for (const p of [P, P2]) rmSync(join(app.root, 'tests', p), { recursive: true, force: true }); app?.stop(); });

test('with Show browser off a saved test runs in the background', async () => {
  app = await startApp({ port: 4422 });
  const dir = join(app.root, 'tests', P);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: P }));
  writeFileSync(join(dir, 'quick.spec.ts'), `import { test } from '@playwright/test';
test('quick', async ({ page }) => { await test.step('Quick step', async () => { await page.setContent('<h1>q</h1>'); await page.waitForTimeout(1500); }); });`);
  writeFileSync(join(dir, 'slow.spec.ts'), `import { test } from '@playwright/test';
test('slow', async ({ page }) => { for (const n of ['one', 'two', 'three', 'four']) await test.step('Slow ' + n, async () => { await page.setContent('<h1>' + n + '</h1>'); await page.waitForTimeout(1500); }); });`);
  mkdirSync(join(app.root, 'tests', P2), { recursive: true });
  writeFileSync(join(app.root, 'tests', P2, 'project.json'), JSON.stringify({ name: P2 }));
  writeFileSync(join(dir, 'broken.spec.ts'), `import { test, expect } from '@playwright/test';
test('broken', async ({ page }) => { await page.setContent('<p>10</p>'); await expect(page.locator('p')).toHaveText('11', { timeout: 500 }); });`);
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => { if (!localStorage.getItem('last')) localStorage.setItem('last', JSON.stringify({ setupSeen: true })); }); // once: a reload keeps what the app stored
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const screens = []; page.on('request', r => { if (r.url().includes('/screen')) screens.push(r.url()); });
  await page.goto(`${app.base}/#/p/${P}`);
  await page.locator('nav.views [data-view=tests]').click();
  // Show browser sits in the suite bar, which shows while a test is ticked; its choice also applies to a row's ▶
  await page.locator('#testList .item[data-name=quick] input[type=checkbox]').check();
  await page.locator('#replayShowBrowser').uncheck();
  await page.locator('#testList .item[data-name=quick] input[type=checkbox]').uncheck();
  await page.locator('#testList .item[data-name=quick] [data-act=run]').click();
  await page.locator('.live-chip').first().waitFor();
  assert.equal(await page.locator('#view-tests').isVisible(), true); // you stay on Saved tests
  assert.equal(await page.locator('#view-run').isVisible(), false);
  await page.waitForFunction(() => !document.querySelector('.live-chip'), null, { timeout: 30_000 }); // the run ends
  assert.deepEqual(screens, []); // nobody watched: no live view
  const card = page.locator('#summaries .summary').first();
  await card.waitFor();
  assert.match(await card.textContent(), /✓ Passed/);
  assert.match(await card.textContent(), /1 of 1 tests passed/);
  await card.locator('[data-act=open]').click(); // Open result: the full result, as from History
  await page.locator('#result').waitFor();
  assert.match(await page.locator('#result h2').textContent(), /Passed/);
  assert.equal(await page.locator('#summaries .summary').count(), 0); // opening it closes the card

  // a background run you peek at through its chip and then leave still ends in a card; × closes it
  await page.locator('nav.views [data-view=tests]').click();
  await page.locator('#testList .item[data-name=slow] [data-act=run]').click();
  await page.locator('.live-chip').first().click(); // peek
  await page.locator('#view-run').waitFor();
  await page.locator('nav.views [data-view=tests]').click(); // and leave
  const peeked = page.locator('#summaries .summary').first();
  await peeked.waitFor({ timeout: 60_000 });
  assert.match(await peeked.textContent(), /✓ Passed/);
  await peeked.locator('[data-act=close]').click();
  assert.equal(await page.locator('#summaries .summary').count(), 0);

  // a failing run in the background: the card says so and shows the first error
  await page.locator('#testList .item[data-name=broken] [data-act=run]').click();
  const failed = page.locator('#summaries .summary.fail').first();
  await failed.waitFor({ timeout: 60_000 });
  assert.match(await failed.textContent(), /✗ Failed/);
  assert.match(await failed.textContent(), /0 of 1 tests passed/);
  assert.match(await failed.locator('.summary-error').textContent(), /toHaveText/);

  // switching project clears the cards: their results belong to the project they ran in
  await page.evaluate(p => { location.hash = `#/p/${p}`; }, P2);
  await page.locator('#projName', { hasText: P2 }).waitFor();
  assert.equal(await page.locator('#summaries .summary').count(), 0);
  await page.evaluate(p => { location.hash = `#/p/${p}`; }, P);
  await page.locator('#projName', { hasText: P }).waitFor();

  // the choice is remembered
  await page.reload();
  await page.locator('nav.views [data-view=tests]').click();
  assert.equal(await page.locator('#replayShowBrowser').isChecked(), false);
  assert.deepEqual(errors, []); // also: no Notification API error in a headless browser
});
