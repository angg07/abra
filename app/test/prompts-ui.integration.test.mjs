// Run AI › Save prompt keeps the form (with its file) to run later; a row fills the form back; saving again updates
// the same prompt; deleting the open one or switching project ends "Editing"; a vanished AI keeps a valid choice.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';
import { answerAsks, askLog } from './helpers/ask.mjs';

const P = 'zz-prompts-ui', P2 = 'zz-prompts-ui-2';
let app, browser;
after(async () => { await browser?.close(); if (app) for (const p of [P, P2]) rmSync(join(app.root, 'tests', p), { recursive: true, force: true }); app?.stop(); });

test('save, reopen, update, delete and switch project on the Run AI page', async () => {
  app = await startApp({ port: 4416 });
  for (const p of [P, P2]) { mkdirSync(join(app.root, 'tests', p), { recursive: true }); writeFileSync(join(app.root, 'tests', p, 'project.json'), JSON.stringify({ name: p })); }
  browser = await chromium.launch();
  const page = await browser.newPage();
  await answerAsks(page, 'ok');
  await page.addInitScript(() => localStorage.setItem('last', JSON.stringify({ setupSeen: true })));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const row = '#promptList [data-id=b1-polis-marine-hull]';
  await page.goto(`${app.base}/#/p/${P}`);
  await page.locator('#view-ai').waitFor();
  await page.locator('#promptList').getByText('No saved prompts yet').waitFor();

  // save without running
  await page.fill('#url', 'http://jets.test/');
  await page.click('#filesMore summary'); // Title and files is folded while empty
  await page.fill('#taskTitle', 'B1 Polis Marine Hull');
  await page.fill('#task', 'Create a policy with two vessels');
  await page.locator('#aiFileIn').setInputFiles({ name: 'Slip.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
  await page.locator('#aiFiles').getByText('{{file.Slip.pdf}}').waitFor();
  await page.click('#savePrompt');
  await page.locator(row).waitFor();
  assert.match(await page.locator(row).textContent(), /Not run yet/);
  assert.equal(await page.locator('#promptEditing').isVisible(), true);

  // after a reload the row is still there; opening it fills the form, file included
  await page.reload();
  await page.locator(row).waitFor();
  assert.equal(await page.locator('#promptEditing').isVisible(), false); // a reload starts outside "Editing"
  await page.fill('#task', '');
  await page.click(`${row} [data-act=open]`);
  await page.locator('#aiFiles').getByText('{{file.Slip.pdf}}').waitFor();
  assert.equal(await page.inputValue('#task'), 'Create a policy with two vessels');
  assert.equal(await page.inputValue('#taskTitle'), 'B1 Polis Marine Hull');
  assert.match(await page.locator('#promptEditingName').textContent(), /B1 Polis Marine Hull/);

  // saving again updates the same prompt
  await page.fill('#task', 'Create a policy with three vessels');
  await page.click('#savePrompt');
  let saved;
  for (let i = 0; i < 50 && !/three/.test(saved?.task ?? ''); i++) { await page.waitForTimeout(100); saved = await (await app.req(`/prompts/b1-polis-marine-hull?project=${P}`)).json(); }
  assert.equal(saved.task, 'Create a policy with three vessels');
  assert.deepEqual(saved.files, ['Slip.pdf']);
  assert.equal(await page.locator('#promptList [data-id]').count(), 1);

  // switching project ends "Editing"
  await page.evaluate(p => { location.hash = `#/p/${p}`; }, P2);
  await page.locator('#projName', { hasText: P2 }).waitFor();
  assert.equal(await page.locator('#promptEditing').isVisible(), false);
  await page.evaluate(p => { location.hash = `#/p/${p}`; }, P);
  await page.locator(row).waitFor();

  // deleting the open prompt ends "Editing"; the next save makes a new prompt
  await page.click(`${row} [data-act=open]`);
  await page.locator('#promptEditing').waitFor();
  await page.click(`${row} [data-act=delete]`);
  await page.locator(row).waitFor({ state: 'detached' });
  assert.equal(await page.locator('#promptEditing').isVisible(), false);
  await page.click('#savePrompt');
  await page.locator(row).waitFor();
  assert.equal(await page.locator('#promptList [data-id]').count(), 1);

  // a prompt whose AI no longer exists keeps a valid AI choice
  await app.req(`/prompts?project=${P}`, { method: 'POST', body: JSON.stringify({ title: 'Gone AI', task: 'x', provider: 'no-such-ai', env: 'no-such-env' }) });
  await page.locator('nav.views [data-view=tests]').click();
  await page.locator('nav.views [data-view=ai]').click();
  await page.click('#promptList [data-id=gone-ai] [data-act=open]');
  await page.locator('#promptEditingName', { hasText: 'Gone AI' }).waitFor();
  const provider = await page.inputValue('#provider');
  assert.notEqual(provider, 'no-such-ai');
  assert.ok(await page.locator(`#provider option[value="${provider}"]`).count());

  // a double click on Save prompt saves one prompt, not two
  await page.click('#promptNew');
  await page.click('#filesMore summary');
  await page.fill('#taskTitle', 'Double click');
  await page.fill('#task', 'Saved once');
  await page.dblclick('#savePrompt');
  await page.locator('#promptList [data-id=double-click]').waitFor();
  await page.waitForTimeout(500);
  const all = await (await app.req(`/prompts?project=${P}`)).json();
  assert.deepEqual(all.filter(p => p.title === 'Double click').map(p => p.id), ['double-click']);
  assert.deepEqual(errors, []);
});
