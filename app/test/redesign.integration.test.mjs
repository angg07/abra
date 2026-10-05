// The pages laid out like the OpenDesign mockup: what each one shows comes from real data, and every new control works.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-rd', PF = 'zz-rd-fail', PE = 'zz-rd-empty', PS = 'zz-rd-stopped';
let app, browser, errors;
const spec = name => `import { test } from '@playwright/test';\ntest(${JSON.stringify(name)}, async ({ page }) => { await page.setContent('<h1>x</h1>'); });\n`;
before(async () => {
  app = await startApp({ port: 4424 });
  for (const p of [P, PF, PE, PS]) { mkdirSync(join(app.root, 'tests', p, 'workflows'), { recursive: true }); writeFileSync(join(app.root, 'tests', p, 'project.json'), JSON.stringify({ name: p })); }
  for (const t of ['fresh', 'ran', 'other']) writeFileSync(join(app.root, 'tests', P, `${t}.spec.ts`), spec(t));
  writeFileSync(join(app.root, 'tests', P, 'workflows', 'w.json'), JSON.stringify({ name: "W <b>quote's", blocks: [{ type: 'ai', label: 'A' }, { type: 'loop', label: 'L', blocks: [{ type: 'test', label: 'T' }] }, { type: 'validate', label: 'V' }] }));
  const db = new DatabaseSync(app.dbFile), now = Date.now(), h = 3_600_000;
  const add = (id, project, ago, status, extra = {}) => db.prepare('INSERT INTO runs (id, project, started, data) VALUES (?, ?, ?, ?)')
    .run(id, project, now - ago, JSON.stringify({ id, project, started: now - ago, status, kind: 'replay', task: id, secs: 4, ...extra }));
  add('rd-1', P, h, 'pass', { title: 'Ran it', testNames: ['ran'], replaySteps: [{ what: 'a' }, { what: 'b' }, { what: 'c' }] });
  add('rd-2', P, 2 * h, 'fail', { title: 'Broke', testNames: ['other'] });
  add('rd-3', P, 3 * h, 'pass', { title: 'Old pass', testNames: ['other'] });
  add('rd-4', PF, h, 'fail', { title: 'Failing project' });
  add('rd-5', PS, h, 'stopped', { title: 'Stopped by hand' }); // stopped is not failed
  db.close();
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); if (app) for (const p of [P, PF, PE, PS]) rmSync(join(app.root, 'tests', p), { recursive: true, force: true }); app?.stop(); });
async function open(hash = '') {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => { if (!localStorage.getItem('last')) localStorage.setItem('last', JSON.stringify({ setupSeen: true })); });
  errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${app.base}/${hash}`);
  await page.waitForFunction(() => window.__appStarted);
  return page;
}

test('Projects: stats come from the data, cards show pass rate, counts and actions', async () => {
  const page = await open();
  await page.locator('.project[data-id=zz-rd]').waitFor({ timeout: 5000 }).catch(async e => { console.log('DBG', errors, (await page.locator('#home').innerText()).slice(0, 300)); throw e; });
  const stat = n => page.locator('#projStats .stat').nth(n).locator('.num').textContent();
  assert.equal(await stat(0), '5'); // runs this week over every project
  assert.equal(await stat(1), '40%');
  assert.equal(await stat(2), '1'); // zz-rd-fail's last run failed
  assert.equal(await stat(3), '0');
  const card = page.locator('.project[data-id=zz-rd]');
  assert.match(await card.textContent(), /Pass rate · last 3 runs/);
  assert.equal(await card.locator('.meter-top b').textContent(), '67%');
  assert.match(await card.textContent(), /3 tests/);
  assert.match(await card.textContent(), /1 workflow(?!s)/);
  assert.match(await card.locator('.pill').first().textContent(), /Passed/);
  assert.match(await page.locator('.project[data-id=zz-rd-empty]').textContent(), /No runs yet/);
  assert.doesNotMatch(await page.locator('#home').textContent(), /NaN/);
  await card.locator('[data-to=tests]').click();
  await page.locator('#view-tests').waitFor();
  await page.locator('nav.views [data-view=home]').click();
  await page.locator('.project[data-id=zz-rd] [data-to=ai]').click();
  await page.locator('#view-ai').waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test('Run AI: a variable chip inserts at the cursor, the counter counts, the summary follows Change settings and a saved prompt', async () => {
  const page = await open(`#/p/${P}`);
  await page.locator('#view-ai').waitFor();
  await page.locator('#varChips [data-var="{{today}}"]').waitFor();
  await page.fill('#task', 'log in then');
  await page.locator('#task').evaluate(t => t.setSelectionRange(6, 6)); // after "log in"
  await page.locator('#varChips [data-var="{{today}}"]').click();
  assert.equal(await page.inputValue('#task'), 'log in {{today}} then');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'task');
  assert.equal(await page.locator('#taskCount').textContent(), '21 / 10000');
  assert.equal(await page.locator('#filesMore').getAttribute('open'), null); // no title or files: folded
  await page.locator('#rsMore summary').click();
  await page.locator('#guide').check();
  await page.locator('#showBrowser').uncheck();
  assert.match(await page.locator('#sumOut').textContent(), /PDF guide/);
  assert.doesNotMatch(await page.locator('#sumOut').textContent(), /Visible browser/);
  // a saved prompt fills the form by code: the summary follows it too
  const providers = (await (await app.req('/settings')).json()).providers.filter(p => p.ready);
  const current = await page.inputValue('#provider'), other = providers.find(p => p.id !== current);
  await app.req(`/prompts?project=${P}`, { method: 'POST', body: JSON.stringify({ title: 'No PDF', task: 'do it', guide: false, record: true, provider: other.id, model: '' }) });
  await page.locator('nav.views [data-view=tests]').click();
  await page.locator('nav.views [data-view=ai]').click();
  await page.locator('#promptList [data-id=no-pdf] [data-act=open]').click();
  await page.locator('#promptEditingName', { hasText: 'No PDF' }).waitFor();
  assert.doesNotMatch(await page.locator('#sumOut').textContent(), /PDF guide/);
  assert.equal(await page.locator('#sumAi').textContent(), `${other.label} · ${other.model || 'default'}`); // the prompt's AI with its own default model
  assert.equal(await page.locator('#taskCount').textContent(), '5 / 10000');
  assert.equal(await page.locator('#filesMore').getAttribute('open'), ''); // it has a title: unfolded
  assert.deepEqual(errors, []);
  await page.close();
});

test('Saved tests: ▶ for a new test, the row menu, View last result and the suite bar', async () => {
  const page = await open(`#/p/${P}`);
  await page.locator('nav.views [data-view=tests]').click();
  const ran = page.locator('#testList .item[data-name=ran]');
  await ran.waitFor();
  assert.match(await ran.textContent(), /3 steps · 4s · View last result/);
  assert.equal(await page.locator('#testList .item[data-name=fresh] [data-act=run]').count(), 1); // ▶
  assert.equal(await ran.locator('[data-act=run]').count(), 0);
  await ran.locator('[data-act=menu]').click();
  assert.deepEqual(await ran.locator('.menu [data-act]').evaluateAll(b => b.map(x => x.textContent.trim())), ['Run', 'Edit', 'Show code', 'Delete']);
  await ran.locator('.menu [data-act=code]').click();
  await ran.locator('pre.code').waitFor();
  assert.equal(await ran.locator('.menu').count(), 0); // the menu closes after an action
  assert.equal(await page.locator('#suitebar').isVisible(), false);
  // the choices ▶ and Run use are always in view, and open the bar without ticking anything
  assert.match(await page.locator('#suiteSummary').textContent(), /Run once/);
  await page.locator('#replayRepeat').evaluate(s => { s.value = '3'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.match(await page.locator('#suiteSummary').textContent(), /Repeat 3×/);
  await page.locator('#suiteSummary').click();
  await page.locator('#suitebar').waitFor();
  await page.locator('#suiteSummary').click();
  await page.locator('#suitebar').waitFor({ state: 'hidden' });
  await page.locator('#testList .item[data-name=fresh] input[type=checkbox]').check();
  await page.locator('#suitebar').waitFor();
  assert.match(await page.locator('#runSelected').textContent(), /Run 1 test/);
  await page.locator('#selAll').check();
  assert.equal(await page.locator('#suiteCount').textContent(), '3 selected');
  assert.match(await page.locator('#runSelected').textContent(), /Run 3 tests/);
  await page.locator('#suiteClear').click();
  await page.locator('#suitebar').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#testList input[type=checkbox]:checked').count(), 0);
  await ran.locator('[data-act=last]').click(); // View last result
  await page.locator('#result').waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test('History: filter counts, kind · steps · who per row; Workflows: the block chain, names shown as text', async () => {
  const page = await open(`#/p/${P}`);
  await page.locator('nav.views [data-view=history]').click();
  await page.locator('#historyList button.item').first().waitFor();
  assert.match(await page.locator('[data-filter=all]').textContent(), /All\s*3/);
  assert.match(await page.locator('[data-filter=fail]').textContent(), /Failed\s*1/);
  assert.match(await page.locator('#historyList button.item').first().textContent(), /Replay · 3 steps · Playwright/);
  await page.locator('[data-filter=fail]').click();
  assert.equal(await page.locator('#historyList button.item').count(), 1);
  await page.locator('nav.views [data-view=workflows]').click();
  const wf = page.locator('#wfList .item').first();
  await wf.waitFor();
  assert.match(await wf.textContent(), /AI Task\s*→\s*Loop\s*→\s*Validate/);
  assert.match(await wf.textContent(), /Never/);
  assert.match(await wf.locator('.title').textContent(), /W <b>quote's/); // as text, not markup
  assert.deepEqual(errors, []);
  await page.close();
});

test('Settings: providers as cards with a badge and Configure; Appearance as cards; Requirements and Record flow render', async () => {
  const page = await open();
  await page.locator('.openSettings').click();
  const card = page.locator('#plist .prov').first();
  await card.locator('.prov-ico').waitFor();
  assert.match(await card.locator('summary').textContent(), /Configure/);
  assert.equal(await card.locator('summary .pill').count(), 1);
  await card.locator('summary').click();
  await card.locator('[name=label]').waitFor();
  await page.locator('#tabLookBtn').click();
  assert.equal(await page.locator('.theme-opt[data-theme-pick=dark] .theme-prev').count(), 1);
  await page.locator('#openSetup').click();
  await page.locator('#setupList .setup-item .pill').first().waitFor();
  await page.goto(`${app.base}/#/p/${P}`);
  await page.locator('nav.views [data-view=record]').click();
  await page.locator('#recForm.record-card').waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test('Narrow screen: a test row and a History row keep room for their name', async () => {
  const page = await open(`#/p/${P}`);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.locator('#sideToggle').click();
  await page.locator('nav.views [data-view=tests]').click();
  const w = sel => page.locator(sel).first().evaluate(e => e.getBoundingClientRect().width);
  assert.ok(await w('#testList .item[data-name=ran] .title') > 120, 'test name has room');
  assert.ok(await page.evaluate(() => document.getElementById('scroll').scrollWidth <= innerWidth), 'no sideways scroll');
  await page.locator('#sideToggle').click();
  await page.locator('nav.views [data-view=history]').click();
  assert.ok(await w('#historyList button.item .title') > 120, 'run title has room');
  assert.deepEqual(errors, []);
  await page.close();
});
