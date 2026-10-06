// Edit in Run AI from the row menu and from Edit test fills the form and shows "Editing test"; Cancel ends it;
// a result run for that test shows Update, which asks first when the run failed and writes to the run's project.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './helpers/app-server.mjs';
import { answerAsks, waitAsk } from './helpers/ask.mjs';

const P = 'zz-edit-ai', P2 = 'zz-edit-ai-2';
let app, browser;
after(async () => { await browser?.close(); if (app) for (const p of [P, P2]) rmSync(join(app.root, 'tests', p), { recursive: true, force: true }); app?.stop(); });
const spec = url => `import { test } from '@playwright/test';\ntest('t', async ({ page }) => { await page.goto('${url}'); });\n`;

test('Edit in Run AI, Cancel, and Update from the result', async () => {
  app = await startApp({ port: 4426 });
  for (const p of [P, P2]) { mkdirSync(join(app.root, 'tests', p, 'sources'), { recursive: true }); writeFileSync(join(app.root, 'tests', p, 'project.json'), JSON.stringify({ name: p })); }
  const dir = join(app.root, 'tests', P);
  writeFileSync(join(dir, 'nb.spec.ts'), spec('http://jets.test/nb'));
  writeFileSync(join(dir, 'sources', 'nb.json'), JSON.stringify({ title: 'NB', url: 'http://jets.test/nb', task: 'Create a new business', env: 'e2e', record: false, guide: true }));
  writeFileSync(join(dir, 'hand.spec.ts'), spec('http://jets.test/hand'));
  writeFileSync(join(dir, 'gone-ai.spec.ts'), spec('http://jets.test/gone'));
  writeFileSync(join(dir, 'sources', 'gone-ai.json'), JSON.stringify({ url: 'http://jets.test/gone', task: 'Old AI', provider: 'deleted-ai', model: 'old-model' }));
  const db = new DatabaseSync(app.dbFile);
  const run = { id: 'zz-edit-run', kind: 'ai', project: P, started: Date.now(), status: 'fail', editOf: 'nb', url: 'http://jets.test/nb2', task: 'Create two', script: spec('http://jets.test/nb2') };
  db.prepare('INSERT INTO runs (id, project, started, user_id, video, guide, data) VALUES (?, ?, ?, NULL, NULL, NULL, ?)').run(run.id, P, run.started, JSON.stringify(run));
  db.close();

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => localStorage.setItem('last', JSON.stringify({ setupSeen: true })));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await answerAsks(page, 'ok');
  await page.goto(`${app.base}/#/p/${P}`);
  await page.waitForFunction(() => window.__appStarted);

  // from the row menu: the saved source fills the form
  await page.locator('nav.views [data-view=tests]').click();
  await page.locator('#testList .item[data-name=nb] [data-act=more]').click();
  await page.locator('#testList .row-menu [data-act=ai]').click();
  await page.locator('#testEditing').waitFor();
  assert.equal(await page.locator('#testEditingName').textContent(), 'nb');
  assert.deepEqual([await page.inputValue('#url'), await page.inputValue('#task'), await page.isChecked('#guide'), await page.isChecked('#record')],
    ['http://jets.test/nb', 'Create a new business', true, false]);
  assert.equal(await page.locator('#testEditingHint').isVisible(), false);
  await page.locator('#testEditCancel').click();
  assert.equal(await page.locator('#testEditing').isVisible(), false);

  // an AI deleted since: the current AI stays, and so does its model
  const model = await page.inputValue('#model');
  await page.locator('nav.views [data-view=tests]').click();
  await page.locator('#testList .item[data-name=gone-ai] [data-act=more]').click();
  await page.locator('#testList .row-menu [data-act=ai]').click();
  await page.locator('#testEditingName', { hasText: 'gone-ai' }).waitFor();
  assert.equal(await page.inputValue('#model'), model);

  // from Edit test, a hand-written test: URL from its code, a hint to write the instructions; unsaved edits ask first
  await page.locator('nav.views [data-view=tests]').click();
  await page.locator('#testList .item[data-name=hand] [data-act=more]').click();
  await page.locator('#testList .row-menu [data-act=edit]').click();
  await page.locator('#editCode').fill('changed');
  await page.locator('#editInAi').click();
  await waitAsk(page, /unsaved/);
  await page.locator('#testEditing').waitFor();
  assert.equal(await page.inputValue('#url'), 'http://jets.test/hand');
  assert.equal(await page.locator('#testEditingHint').isVisible(), true);

  // switching project ends the edit
  await page.goto(`${app.base}/#/p/${P2}`);
  await page.waitForFunction(() => document.getElementById('projName').textContent === 'zz-edit-ai-2');
  assert.equal(await page.locator('#testEditing').isVisible(), false);
  // the result of a run made for nb: Update asks first (the run failed)
  await page.goto(`${app.base}/#/p/${P}`);
  await page.waitForFunction(() => document.getElementById('projName').textContent === 'zz-edit-ai');
  await page.locator('nav.views [data-view=history]').click();
  await page.locator('#historyList button.item', { hasText: 'Create two' }).click();
  await page.locator('button', { hasText: 'Update nb' }).click();
  await page.locator('button', { hasText: 'Updated tests/zz-edit-ai/nb.spec.ts' }).waitFor();
  await page.locator('#toast', { hasText: 'Updated nb' }).waitFor();
  await waitAsk(page, /did not pass/);
  assert.match(readFileSync(join(dir, 'nb.spec.ts'), 'utf8'), /nb2/);
  assert.deepEqual(errors, []);
});
