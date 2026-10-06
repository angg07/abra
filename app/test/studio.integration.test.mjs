// Workflow Studio as a page: palette, canvas, inspector; old workflows open unchanged; loops nest; Up/Down/Remove
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';
import { answerAsks, askLog } from './helpers/ask.mjs';

const P = 'zz-studio';
let app, browser, page, errors, dir;
const wf = { name: 'Old one', description: 'kept', params: [], blocks: [
  { type: 'ai', label: 'Log in', key: 'login', url: '', prompt: 'Log in as admin' },
  { type: 'loop', label: 'Each', key: 'each', over: 'csv', csv: 'name\nA\n', blocks: [{ type: 'validate', label: 'V', key: 'v', prompt: 'Saved' }] },
  { type: 'http', label: 'H', key: 'h', method: 'GET', url: 'http://x.test/api', headers: {}, body: '' },
] };
after(async () => { await browser?.close(); if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });

test('an old workflow opens as a page with the new names and saves back unchanged', async () => {
  app = await startApp({ port: 4432 });
  dir = join(app.root, 'tests', P);
  mkdirSync(join(dir, 'workflows'), { recursive: true }); writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: P, url: 'http://shop.test' }));
  const { id } = await (await app.req(`/workflows?project=${P}`, { method: 'POST', body: JSON.stringify(wf) })).json(); // stored the server's way
  const file = join(dir, 'workflows', `${id}.json`), before = readFileSync(file, 'utf8');
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => localStorage.setItem('last', JSON.stringify({ setupSeen: true })));
  errors = []; page.on('pageerror', e => errors.push(e.message));
  await answerAsks(page, 'ok');
  await page.goto(`${app.base}/#/p/${P}`); await page.waitForFunction(() => window.__appStarted);
  await page.locator('nav.views [data-view=workflows]').click();
  await page.locator('#wfList .wf-row [data-act=open]').click();
  await page.locator('#view-studio').waitFor();
  assert.equal(await page.locator('#side').isVisible(), true); // a page, not an overlay
  assert.equal(await page.locator('nav.views [data-view=workflows]').getAttribute('aria-current'), 'page');
  assert.match(await page.locator('.canvas-start').textContent(), /Start · http:\/\/shop\.test/);
  assert.deepEqual(await page.locator('#canvas .blk .blk-type').allTextContents(), ['AI task', 'Loop', 'Check', 'API call']);
  assert.match(await page.locator('#canvas .blk').first().locator('.blk-sum').textContent(), /Log in as admin/);
  await page.locator('#wfName').fill('Old one');
  await page.locator('#wfSave').click();
  await page.locator('#wfDirty').waitFor({ state: 'hidden' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), JSON.parse(before));
});

test('palette adds below the selected block, inside a selected loop, never a loop in a loop; Up/Down/Remove', async () => {
  const top = () => page.locator('#canvas > .blk-wrap > .blk .blk-type').allTextContents();
  await page.locator('#canvas .blk', { hasText: 'Log in as admin' }).click();
  await page.locator('.palette [data-add=extract]').click();
  assert.deepEqual(await top(), ['AI task', 'Extract', 'Loop', 'API call']);
  await page.locator('#canvas > .blk-wrap > .blk', { hasText: 'Loop' }).click();
  await page.locator('.palette [data-add=test]').click();
  assert.equal(await page.locator('.blk-children .blk').count(), 2); // inside the loop
  await page.locator('.palette [data-add=loop]').click();
  assert.equal(await page.locator('.blk-children .blk-type', { hasText: 'Loop' }).count(), 0); // never nested
  assert.deepEqual(await top(), ['AI task', 'Extract', 'Loop', 'Loop', 'API call']);
  await page.locator('#canvas > .blk-wrap > .blk').nth(1).click();
  assert.equal(await page.locator('#bUp').isDisabled(), false);
  await page.locator('#bUp').click();
  assert.equal((await top())[0], 'Extract');
  assert.equal(await page.locator('#bUp').isDisabled(), true); // first block
  await page.locator('#bDel').click(); // the confirm is accepted
  await page.locator('#toast', { hasText: 'Block removed' }).waitFor();
  assert.equal(await page.locator('#wfDirty').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('new workflow starts with AI task + Check; More options keeps the advanced fields; ⋯ has JSON and Delete; phone head wraps', async () => {
  await page.locator('#wfBack').click(); // unsaved changes: the confirm is accepted
  await page.locator('#view-workflows').waitFor();
  await page.locator('#wfNew').click();
  await page.locator('#view-studio').waitFor();
  assert.deepEqual(await page.locator('#canvas .blk .blk-type').allTextContents(), ['AI task', 'Check']);
  assert.equal(await page.locator('#canvas .blk[aria-pressed=true] .blk-n').textContent(), '1');
  assert.equal(await page.locator('#wfDirty').isVisible(), true);
  await page.locator('#insp summary', { hasText: 'More options' }).click();
  for (const label of ['Name', 'Key', 'Open this URL first', 'Continue with the next block if this one fails']) assert.ok(await page.locator('#insp').getByText(label).count(), label);
  await page.locator('#wfSave').click();
  await page.locator('#wfNameErr').waitFor();
  await page.locator('#wfMore').click();
  assert.deepEqual(await page.locator('#wfMoreMenu [data-act]').evaluateAll(b => b.map(x => x.textContent.trim())), ['Show JSON', 'Delete workflow']);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 800 });
  assert.ok(await page.evaluate(() => document.getElementById('scroll').scrollWidth <= innerWidth));
  assert.ok(await page.locator('#wfRun').isVisible());
  const box = await page.locator('#wfRun').boundingBox();
  assert.ok(box.x + box.width <= 375, 'Run fits the screen');
  assert.deepEqual(errors, []);
});

test('bad JSON keeps the workflow; switching project with unsaved edits and cancelling keeps the project', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#wfMore').click();
  await page.locator('#wfMoreMenu [data-act=json]').click();
  const before = await page.locator('#canvas .blk .blk-type').allTextContents();
  for (const bad of ['{"blocks":[{"type":"foo"}]}', '{"blocks":[null]}', '{"blocks":[{"type":"loop","blocks":[{"type":"loop","blocks":[]}]}]}', '{"blocks":[],"params":"x"}']) {
    await page.locator('#wfJsonText').fill(bad);
    await page.locator('#wfJsonApply').click();
    assert.match(await page.locator('#wfJsonErr').textContent(), /JSON/, bad);
    assert.equal(await page.locator('#wfJsonDlg').evaluate(d => d.open), true, bad);
  }
  await page.locator('#wfJsonCancel').click();
  assert.deepEqual(await page.locator('#canvas .blk .blk-type').allTextContents(), before);
  // another project while the Studio has unsaved edits: Cancel stays here, in this project
  mkdirSync(join(app.root, 'tests', 'zz-studio-b'), { recursive: true }); writeFileSync(join(app.root, 'tests', 'zz-studio-b', 'project.json'), JSON.stringify({ name: 'zz-studio-b' }));
  await answerAsks(page, 'cancel');
  await page.evaluate(() => { location.hash = '#/p/zz-studio-b'; });
  await page.waitForTimeout(500);
  assert.match(await page.evaluate(() => location.hash), new RegExp(`^#/p/${P}/workflows/`)); // still this project's Studio
  assert.equal(await page.locator('#projName').textContent(), P);
  assert.equal(await page.locator('#view-studio').isVisible(), true);
  await answerAsks(page, 'ok');
  rmSync(join(app.root, 'tests', 'zz-studio-b'), { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

test('Delete workflow from ⋯ removes it and goes back to the list', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#wfBack').click();
  await page.locator('#wfList .wf-row [data-act=open]').first().click();
  await page.locator('#wfMore').click();
  await page.locator('#wfMoreMenu [data-act=delete]').click(); // the confirm is accepted
  await page.locator('#view-workflows').waitFor();
  await page.waitForFunction(() => !document.querySelector('#wfList .wf-row')); // the list reloads after the delete
  assert.deepEqual(errors, []);
});
