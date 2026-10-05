// A run going on in the background must not draw into a History run opened meanwhile, and its own page comes back
// complete from the sidebar chip. Real server and page, headless Chromium (two short replays).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-ui-live';
let app, browser;
after(async () => { await browser?.close(); if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });

test('opening a History run while another run goes on shows that run; the chip brings the live run back', async () => {
  app = await startApp({ port: 4400 });
  const dir = join(app.root, 'tests', P);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: P }));
  writeFileSync(join(dir, 'quick.spec.ts'), `import { test } from '@playwright/test';
test('quick', async ({ page }) => { await test.step('Quick step', async () => { await page.setContent('<h1>q</h1>'); }); });`);
  writeFileSync(join(dir, 'slow.spec.ts'), `import { test } from '@playwright/test';
test('slow', async ({ page }) => {
  for (const n of ['one', 'two', 'three', 'four', 'five']) await test.step('Slow ' + n, async () => { await page.setContent('<h1>' + n + '</h1>'); await page.waitForTimeout(1500); });
});`);
  // a finished run in History
  const r = await app.req(`/replay?${new URLSearchParams({ project: P, tests: 'quick' })}`);
  for await (const chunk of r.body) if (String(Buffer.from(chunk)).includes('event: saved')) break;

  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => { localStorage.setItem('last', JSON.stringify({ setupSeen: true })); });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${app.base}/#/p/${P}`);
  await page.locator('nav.views [data-view=tests]').click();
  await page.locator(`#testList .item[data-name=slow] [data-act=run]`).click();
  const steps = page.locator('#steps');
  await steps.getByText('Slow one').waitFor({ timeout: 30_000 });

  await page.locator('nav.views [data-view=history]').click();
  await page.locator('#historyList button.item').first().click();
  await steps.getByText('Quick step').waitFor();
  await page.waitForTimeout(3500); // the live run goes on meanwhile
  assert.equal(await steps.getByText(/Slow/).count(), 0, 'live steps drawn into the History run');
  assert.doesNotMatch(await page.locator('#status').textContent(), /Running/);
  assert.equal(await page.locator('.live-chip').isVisible(), true);
  assert.equal(await page.locator('#back').isVisible(), true); // the History run's buttons, not Stop

  await page.locator('.live-chip').click();
  await steps.getByText('Slow three').waitFor(); // drawn again from what it streamed
  assert.equal(await steps.getByText('Quick step').count(), 0);
  assert.equal(await steps.getByText('Slow one').count(), 1);
  await page.locator('#result').waitFor({ state: 'visible', timeout: 30_000 });
  assert.match(await page.locator('#status').textContent(), /Passed/);
  assert.deepEqual(errors, []);
});

test('a second run starts while the first goes on; each has its chip and its own page', async () => {
  const dir = join(app.root, 'tests', P);
  writeFileSync(join(dir, 'other.spec.ts'), `import { test } from '@playwright/test';
test('other', async ({ page }) => {
  for (const n of ['one', 'two', 'three', 'four']) await test.step('Other ' + n, async () => { await page.setContent('<h1>' + n + '</h1>'); await page.waitForTimeout(1500); });
});`);
  const t0 = Date.now();
  const page = await browser.newPage();
  await page.addInitScript(() => { localStorage.setItem('last', JSON.stringify({ setupSeen: true })); });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${app.base}/#/p/${P}`);
  const steps = page.locator('#steps');

  await page.locator('nav.views [data-view=tests]').click();
  await page.locator(`#testList .item[data-name=slow] [data-act=menu]`).click(); // slow ran before: Run is in its menu
  await page.locator(`#testList .item[data-name=slow] .menu [data-act=run]`).click();
  await steps.getByText('Slow one').waitFor({ timeout: 30_000 });
  await page.locator('nav.views [data-view=tests]').click();
  await page.locator(`#testList .item[data-name=other] [data-act=run]`).click();
  await steps.getByText('Other one').waitFor({ timeout: 30_000 }); // started, not refused or queued (MAX_RUNS 2)
  assert.equal(await steps.getByText(/Slow/).count(), 0);

  const slowChip = page.locator('.live-chip', { hasText: 'slow' });
  assert.equal(await slowChip.isVisible(), true); // the run on screen has no chip; the other one does
  assert.equal(await page.locator('.live-chip', { hasText: 'other' }).isVisible(), false);
  await slowChip.click();
  await steps.getByText('Slow two').waitFor();
  assert.equal(await steps.getByText(/Other/).count(), 0);
  await page.locator('#result').waitFor({ state: 'visible', timeout: 30_000 });
  assert.match(await page.locator('#status').textContent(), /Passed/);

  // the other run finished meanwhile: it is in History, passed
  await page.waitForFunction(() => !document.body.classList.contains('running'), null, { timeout: 30_000 });
  const runs = await page.evaluate(p => fetch(`/history?project=${p}`).then(r => r.json()), P);
  const list = Array.isArray(runs) ? runs : runs.runs ?? [];
  assert.equal(list.filter(r => r.started >= t0 && r.status === 'pass' && /slow|other/.test((r.testNames ?? []).join())).length, 2);
  assert.deepEqual(errors, []);
  await page.close();
});
