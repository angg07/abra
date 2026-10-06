// Mockup v9 on the pages that existed before it: Projects, Run AI, Record, Saved tests, History, Run result, Settings
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-v9';
let app, browser, errors, hasVideo = false;
const spec = name => `import { test } from '@playwright/test';\ntest(${JSON.stringify(name)}, async ({ page }) => { await page.setContent('<h1>x</h1>'); });\n`;
before(async () => {
  app = await startApp({ port: 4430 });
  const dir = join(app.root, 'tests', P);
  mkdirSync(join(dir, 'workflows'), { recursive: true }); writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: P, url: 'http://shop.test' }));
  for (const t of ['ran', 'fresh']) writeFileSync(join(dir, `${t}.spec.ts`), spec(t));
  writeFileSync(join(dir, 'workflows', 'checkout.json'), JSON.stringify({ name: 'Checkout', blocks: [{ type: 'ai', label: 'A' }, { type: 'loop', label: 'L', blocks: [{ type: 'test', label: 'T' }] }, { type: 'validate', label: 'V' }, { type: 'http', label: 'H' }] }));
  const db = new DatabaseSync(app.dbFile), now = Date.now(), m = 60_000;
  const add = (id, ago, status, extra = {}) => db.prepare('INSERT INTO runs (id, project, started, data) VALUES (?, ?, ?, ?)')
    .run(id, P, now - ago, JSON.stringify({ id, project: P, started: now - ago, status, kind: 'replay', task: id, secs: 4, ...extra }));
  add('v9-ran', 30 * m, 'pass', { title: 'Ran it', testNames: ['ran'], secs: 11, replaySteps: [1, 2, 3, 4, 5].map(i => ({ what: `step ${i}` })) });
  add('v9-ai', 20 * m, 'pass', { kind: 'ai', title: 'AI with video', task: 'Log in and check the title', provider: 'Claude Code', video: 'v9.webm', script: spec('ai'), steps: [{ what: 'Open the page' }] });
  add('v9-bare', 10 * m, 'pass', { title: 'Bare replay' });
  add('v9-stop', 5 * m, 'stopped', { title: 'Stopped by hand' });
  add('v9-rfail', 3 * m, 'fail', { title: 'Suite broke', replaySteps: [{ what: 'first test step' }, { what: 'second test step' }] });
  add('v9-expfail', 2 * m, 'fail', { kind: 'ai', title: 'Expected missed', task: 'Check the banner', expected: 'A banner', expectedMet: false, steps: [{ what: 'Open the page' }, { what: 'Read the page' }] });
  // step marks, step clicks and the past-run stage
  add('v9-marks', 4 * m, 'fail', { title: 'Suite marks', tests: [{ title: 'good', file: 'good.spec.ts', status: 'passed', ms: 10 }, { title: 'bad', file: 'bad.spec.ts', status: 'failed', ms: 10, error: 'x' }],
    replaySteps: [{ section: 'good', level: 1 }, { what: 's1', at: 0.5 }, { what: 's2', at: 1 }, { section: 'bad', level: 1 }, { what: 's3', at: 2 }] });
  const rec = join(app.root, 'app', 'recordings'); mkdirSync(rec, { recursive: true });
  hasVideo = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=160x120:d=6', '-c:v', 'libvpx-vp9', '-b:v', '50k', join(rec, 'zz-v9-stop.mp4')]).status === 0;
  add('v9-stopvid', 3 * m, 'stopped', { kind: 'ai', title: 'Stopped with video', task: 'Do things', video: 'zz-v9-stop.mp4',
    steps: [{ name: 'browser_navigate', input: { url: 'http://x.test' }, at: 1 }, { name: 'browser_click', input: { element: 'A' }, at: 4 }, { name: 'browser_click', input: { element: 'B' }, at: 5 }] });
  db.prepare('UPDATE runs SET video = ? WHERE id = ?').run('zz-v9-stop.mp4', 'v9-stopvid'); // /recordings serves only files a run owns
  // 1.8.0+: steps carry their guide step (g) and the run its video seconds; a snapshot (no g) shows the step before it
  add('v9-mapvid', 3.5 * m, 'pass', { kind: 'ai', title: 'Mapped video', task: 'Do things', video: 'zz-v9-stop.mp4', stepVideo: [2, 5],
    steps: [{ name: 'browser_navigate', input: { url: 'http://x.test' }, at: 1, g: 0 }, { name: 'browser_snapshot', input: {}, at: 3 }, { name: 'browser_click', input: { element: 'A' }, at: 4, g: 1 }] });
  db.prepare('UPDATE runs SET video = ? WHERE id = ?').run('zz-v9-stop.mp4', 'v9-mapvid');
  // each test heading has its own result: they win over tests[] (in report order, wrong with repeats)
  add('v9-headmarks', 4.5 * m, 'pass', { title: 'Head marks', tests: [{ title: 't', file: 't.spec.ts', status: 'passed', ms: 10 }, { title: 't', file: 't.spec.ts', status: 'failed', ms: 10 }],
    replaySteps: [{ section: 't', level: 1, status: 'failed' }, { what: 's1', at: 0.5 }, { section: 't', level: 1, status: 'passed' }, { what: 's2', at: 1 }] });
  const guide = join(app.root, 'app', 'guides', 'zz-v9-guide'); mkdirSync(guide, { recursive: true });
  writeFileSync(join(guide, 'doc.json'), JSON.stringify({ version: 1, blocks: [{ type: 'step', text: 'Open the page', frame: '001.jpg' }, { type: 'step', text: 'Click A', frame: '002.jpg' }] }));
  for (const f of ['001.jpg', '002.jpg']) writeFileSync(join(guide, f), 'jpg');
  add('v9-guide', 2.5 * m, 'pass', { kind: 'ai', title: 'With guide', task: 'Guided', guide: 'zz-v9-guide.pdf', guideDoc: true,
    steps: [{ name: 'browser_navigate', input: { url: 'http://x.test' }, at: 1 }, { name: 'browser_click', input: { element: 'A' }, at: 2 }] });
  db.prepare('UPDATE runs SET guide = ? WHERE id = ?').run('zz-v9-guide.pdf', 'v9-guide'); // /guides serves only what a run owns
  db.close();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (app) { rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); rmSync(join(app.root, 'app', 'guides', 'zz-v9-guide'), { recursive: true, force: true }); rmSync(join(app.root, 'app', 'recordings', 'zz-v9-stop.mp4'), { force: true }); }
  app?.stop();
});
async function open(hash = '', viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(() => { if (!localStorage.getItem('last')) localStorage.setItem('last', JSON.stringify({ setupSeen: true })); });
  errors = []; page.on('pageerror', e => { errors.push(e.message); if (process.env.SHOW_PE) console.log('PAGEERROR', e.stack); });
  await page.goto(`${app.base}/${hash}`);
  await page.waitForFunction(() => window.__appStarted);
  return page;
}

test('Projects, Run AI and Record follow the mockup', async () => {
  const page = await open('');
  const card = page.locator('.project[data-id=zz-v9]');
  await card.waitFor();
  assert.equal(await card.locator('[data-edit]').count(), 0); // edit lives in the project menu
  assert.match(await card.textContent(), /Pass rate · \d+ runs/);
  assert.ok(await card.locator('.proj-foot').evaluate(e => e.getBoundingClientRect().height < 52), 'one-line footer');
  assert.ok(await card.locator('.proj-url').evaluate(e => e.scrollWidth <= e.clientWidth), 'URL not cut');
  assert.match(await page.locator('#home .page-head p').textContent(), /each with its own tests, workflows and history/);
  await card.locator('[data-to=ai]').click();
  await page.locator('#view-ai').waitFor();
  assert.equal(await page.locator('#expected').evaluate(e => e.tagName), 'INPUT');
  assert.equal(await page.locator('#savePrompt use').getAttribute('href'), '#i-save');
  assert.match(await page.locator('#taskCount').textContent(), /\/ 10000/);
  assert.ok(await page.locator('#task').evaluate(e => e.getBoundingClientRect().height < 200), 'task box at the mockup height');
  assert.deepEqual(errors, []);
  await page.close();
});

test('Saved tests: Run options opens the bar without ticking; a row opens its last result; ⋯ holds the rest', async () => {
  const page = await open(`#/p/${P}`);
  await page.locator('nav.views [data-view=tests]').click();
  const ran = page.locator('#testList .item[data-name=ran]'), fresh = page.locator('#testList .item[data-name=fresh]');
  await ran.waitFor();
  assert.equal(await page.locator('#suiteSummary').count(), 0);
  await page.locator('#runOptions').click();
  await page.locator('#suitebar').waitFor();
  assert.equal(await page.locator('#runOptions').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#testList input[type=checkbox]:checked').count(), 0);
  assert.match(await ran.textContent(), /5 steps · 11s · View last result/);
  assert.equal(await ran.locator('[data-act=run]').count(), 0); // › instead of ▶ once it ran
  assert.equal(await fresh.locator('[data-act=run]').count(), 1);
  await ran.locator('[data-act=more]').click();
  assert.deepEqual(await ran.locator('.row-menu [data-act]').evaluateAll(b => b.map(x => x.textContent.trim())), ['Run', 'Edit', 'Edit in Run AI', 'Show code', 'Delete']);
  await page.keyboard.press('Escape');
  await ran.locator('.title').click();
  await page.locator('#view-run').waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test('History: Stopped is a grey pill with a stop icon; pills take their own width; phone rows keep the pill on the left', async () => {
  const page = await open(`#/p/${P}`);
  await page.locator('nav.views [data-view=history]').click();
  const pill = page.locator('#historyList .pill.stopped').first();
  await pill.waitFor();
  assert.ok(await pill.locator('use[href="#i-stop"]').count());
  assert.match(await pill.getAttribute('class'), /\bidle\b/); // grey like "Not run yet", not the warn colour
  const widths = await page.locator('#historyList .hist-row > .pill').evaluateAll(ps => ps.map(p => Math.round(p.getBoundingClientRect().width)));
  assert.ok(new Set(widths).size > 1, 'pill column is not fixed width');
  assert.match(await page.locator('#view-history .page-head p').textContent(), /with steps, video and report/);
  await page.setViewportSize({ width: 375, height: 800 });
  const row = page.locator('#historyList .hist-row').first();
  const [p, t] = await Promise.all([row.locator('> .pill').boundingBox(), row.locator('.title').boundingBox()]);
  assert.ok(p.x < t.x && Math.abs(p.y - t.y) < 24, 'pill left of the title on one line');
  assert.deepEqual(errors, []);
  await page.close();
});

test('Run result: flat head with kind pill and title; actions in the head; ⋯ only lists what the run has', async () => {
  const page = await open(`#/p/${P}`);
  await page.locator('nav.views [data-view=history]').click();
  await page.locator('#historyList button.item', { hasText: 'AI with video' }).click();
  await page.locator('#result').waitFor();
  assert.equal(await page.locator('#runKind').textContent(), 'AI run');
  assert.equal(await page.locator('#runTitle').textContent(), 'AI with video');
  assert.equal(await page.locator('.runhead').evaluate(e => getComputedStyle(e).borderTopWidth), '0px'); // flat, not a card
  assert.ok(await page.locator('#result .result-top .big').count());
  assert.match(await page.locator('#result .result-top').textContent(), /Passed/);
  assert.ok(await page.locator('#videoBtn').isVisible());
  assert.ok(await page.locator('#saveTestBtn').isVisible());
  assert.match(await page.locator('#rec').textContent(), /Video saved/);
  assert.ok(await page.locator('#logWrap').isVisible()); // the log is always there
  assert.equal(await page.locator('.result-actions').count(), 0); // the old grid is gone
  await page.locator('#runMore').click();
  assert.deepEqual(await page.locator('#runMoreMenu [data-act]').evaluateAll(b => b.map(x => x.dataset.act)), ['report', 'copy', 'show', 'problem']);
  await page.locator('#runMoreMenu [data-act=show]').click();
  assert.ok(await page.locator('#scriptPre').isVisible());
  await page.locator('#back').click();
  await page.locator('#historyList button.item', { hasText: 'Bare replay' }).click();
  await page.locator('#result').waitFor();
  assert.equal(await page.locator('#runKind').textContent(), 'Replay');
  assert.equal(await page.locator('#videoBtn').isVisible(), false);
  assert.equal(await page.locator('#saveTestBtn').isVisible(), false);
  await page.locator('#runMore').click();
  assert.deepEqual(await page.locator('#runMoreMenu [data-act]').evaluateAll(b => b.map(x => x.dataset.act)), ['report', 'problem']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Settings: the section sits on the page and each block is its own card; tabs at the mockup size; alert callout', async () => {
  const page = await open(`#/p/${P}`);
  await page.locator('.openSettings').first().click();
  const box = sel => page.locator(sel).first().evaluate(e => { const c = getComputedStyle(e); return { border: c.borderTopWidth, bg: c.backgroundColor }; });
  for (const tab of ['tabAi', 'tabSecret', 'tabEnv', 'tabSched', 'tabRec']) {
    await page.locator(`#${tab}Btn`).click();
    const b = await box(`#${tab}`);
    assert.equal(b.border, '0px', tab); assert.equal(b.bg, 'rgba(0, 0, 0, 0)', tab); // no card around the section
  }
  await page.locator('#tabEnvBtn').click();
  if (!await page.locator('#envList .env-row').count()) await page.locator('#addEnv').click();
  assert.notEqual((await box('#envList .env-row')).border, '0px'); // each environment is a card
  await page.locator('#tabSchedBtn').click();
  assert.notEqual((await box('#tabSched .set-card')).border, '0px');
  assert.equal(await page.locator('#tabEnvBtn').evaluate(e => getComputedStyle(e).fontSize), '15px');
  await page.locator('#tabSecretBtn').click();
  assert.equal(await page.locator('#tabSecret .callout use').getAttribute('href'), '#i-alert');
  await page.setViewportSize({ width: 375, height: 800 });
  await page.locator('#tabAiBtn').click();
  assert.ok(await page.evaluate(() => document.getElementById('scroll').scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  await page.close();
});

test('review fixes: Show code stays usable; a replay never guesses the failed step; a missed expected result is not "failed at step N"; N leaves the Studio alone', async () => {
  const page = await open(`#/p/${P}`);
  await page.locator('nav.views [data-view=tests]').click();
  const ran = page.locator('#testList .item[data-name=ran]');
  await ran.locator('[data-act=more]').click();
  await ran.locator('.row-menu [data-act=code]').click();
  await ran.locator('pre.code').click();
  assert.equal(await page.locator('#view-tests').isVisible(), true); // the code, not the last result
  await page.locator('nav.views [data-view=history]').click();
  await page.locator('#historyList button.item', { hasText: 'Suite broke' }).click();
  await page.locator('#result').waitFor();
  assert.equal(await page.locator('#steps .step.fail').count(), 0); // replay steps carry no status
  await page.locator('#back').click();
  await page.locator('#historyList button.item', { hasText: 'Expected missed' }).click();
  await page.locator('#result').waitFor();
  assert.doesNotMatch(await page.locator('#result .result-top b').textContent(), /at step/);
  await page.locator('#back').click();
  await page.locator('nav.views [data-view=workflows]').click();
  await page.locator('#wfNew').click();
  await page.locator('body.studio-open').waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('n');
  assert.equal(await page.evaluate(() => document.body.classList.contains('studio-open')), true);
  assert.equal(await page.locator('#view-ai').isVisible(), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Workflows: one card of rows, mockup block names, Run options instead of the toolbar', async () => {
  const page = await open(`#/p/${P}`);
  await page.locator('nav.views [data-view=workflows]').click();
  const row = page.locator('#wfList .wf-row').first();
  await row.waitFor();
  assert.equal((await row.locator('.chain').textContent()).replace(/\s*→\s*/g, ' → ').trim(), 'AI task → Loop → Check → API call');
  assert.match(await row.textContent(), /Last run Never/);
  assert.equal(await row.locator('[data-act=del]').count(), 0);
  assert.equal(await page.locator('#view-workflows .toolbar').count(), 0);
  assert.equal(await page.locator('#wfEnv').isVisible(), false);
  await page.locator('#wfRunOptions').click();
  await page.locator('#wfEnv').waitFor();
  assert.equal(await page.locator('#wfRunOptions').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(errors, []);
  await page.close();
});

test('Requirements: stats, Required/Optional groups, rows with icon, need · found and why; Continue only on first start', async () => {
  const page = await open(`#/p/${P}`);
  await page.locator('#openSetup').click();
  await page.locator('#view-setup').waitFor();
  assert.equal(await page.locator('#view-setup h1').textContent(), 'Requirements');
  assert.equal(await page.locator('#reqStats .stat').count(), 4);
  assert.equal(await page.locator('#reqRequired .req-row').count(), 2);
  assert.ok(await page.locator('#reqOptional .req-row').count() >= 1);
  const row = page.locator('#reqRequired .req-row').first();
  assert.ok(await row.locator('.req-ico').count());
  assert.match(await row.locator('.row-sub').textContent(), / · /);
  assert.ok((await row.locator('.hint').first().textContent()).length > 5);
  assert.equal(await page.locator('#setupContinue').isVisible(), false); // not on a normal visit
  assert.equal(await page.locator('#openSetup').getAttribute('aria-current'), 'page');
  await page.locator('#setupRecheck').click();
  await page.locator('#toast', { hasText: /Checked \d+ tools/ }).waitFor();
  await page.close();
  const first = await browser.newPage({ viewport: { width: 1440, height: 900 } }); // a first start
  await first.goto(`${app.base}/`); await first.waitForFunction(() => window.__appStarted);
  await first.locator('#view-setup #setupContinue').waitFor();
  await first.close();
  assert.deepEqual(errors, []);
});

test('Report: validation, live preview, a run picked from its ⋯ menu, sent screen with the folder', async () => {
  const page = await open(`#/p/${P}`);
  await page.locator('#reportProblem').click();
  await page.locator('#view-report').waitFor();
  assert.equal(await page.locator('#reportProblem').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('#repShotWrap').isVisible(), false); // no desktop bridge in a plain browser
  await page.locator('#repSend').click();
  await page.locator('#repTitleErr').waitFor();
  await page.fill('#repTitle', 'Video missing');
  await page.fill('#repWhat', 'After a failed run the video is not there');
  await page.locator('#repPrev', { hasText: '# Video missing' }).waitFor(); // cleaned by the server first
  await page.locator('#repPrev', { hasText: 'After a failed run' }).waitFor();
  const popup = page.waitForEvent('popup');
  await page.locator('#repSend').click();
  await (await popup).close();
  await page.locator('#repSent', { hasText: 'Report ready on GitHub' }).waitFor();
  assert.match(await page.locator('#repSent').textContent(), /reports/); // the folder path
  assert.equal(await page.locator('#repOpenFolder').isVisible(), false); // Open folder is desktop only
  // a run's ⋯ → Report a problem with this run: the run is picked
  await page.locator('nav.views [data-view=history]').click();
  await page.locator('#historyList button.item', { hasText: 'AI with video' }).click();
  await page.locator('#runMore').click();
  await page.locator('#runMoreMenu [data-act=problem]').click();
  await page.locator('#view-report').waitFor();
  assert.equal(await page.locator('#repRun').inputValue(), 'v9-ai');
  assert.deepEqual(errors, []);
  await page.close();
});

test('steps: replay steps marked from test results; a click jumps the video or shows the guide shot; Stop sums up', async () => {
  const page = await open(`#/p/${P}/history`);
  await page.locator('#historyList button.item', { hasText: 'Suite marks' }).click();
  await page.locator('#result').waitFor();
  assert.equal(await page.locator('#steps .step.pass').count(), 2); // the passing test's steps
  assert.equal(await page.locator('#steps .step.fail').count(), 1); // the failing test's last step
  await page.locator('#back').click();
  await page.locator('#historyList button.item', { hasText: 'Head marks' }).click();
  await page.locator('#result').waitFor();
  assert.deepEqual(await page.locator('#steps .step').evaluateAll(els => els.map(e => e.classList.contains('fail') ? 'fail' : 'pass')), ['fail', 'pass']);
  if (hasVideo) {
    await page.locator('#back').click();
    await page.locator('#historyList button.item', { hasText: 'Mapped video' }).click();
    await page.waitForFunction(() => document.getElementById('stageVideo').readyState >= 1, null, { timeout: 10_000 });
    await page.locator('#steps .step').nth(2).click();
    assert.equal(await page.locator('#stageVideo').evaluate(v => v.currentTime), 5); // its stepVideo second, not its at
    await page.locator('#steps .step').nth(1).click();
    assert.equal(await page.locator('#stageVideo').evaluate(v => v.currentTime), 2); // the snapshot: the step before it
  }
  await page.locator('#back').click();
  await page.locator('#historyList button.item', { hasText: 'Stopped with video' }).click();
  await page.locator('#result').waitFor();
  assert.match(await page.locator('#result').textContent(), /3 steps done before you stopped it/);
  if (hasVideo) {
    await page.waitForFunction(() => document.getElementById('stageVideo').readyState >= 1, null, { timeout: 10_000 });
    await page.locator('#steps .step').nth(1).click();
    assert.equal(Math.round(await page.locator('#stageVideo').evaluate(v => v.currentTime)), 4); // its at
  }
  await page.locator('#back').click();
  await page.locator('#historyList button.item', { hasText: 'With guide' }).click();
  await page.locator('#stageShot').waitFor(); // the last step's screenshot, with a caption
  assert.match(await page.locator('#stageShot').getAttribute('src'), /002\.jpg$/);
  assert.match(await page.locator('#caption').textContent(), /Step 2/);
  await page.locator('#steps .step').first().click();
  assert.match(await page.locator('#stageShot').getAttribute('src'), /001\.jpg$/);
  await page.locator('#back').click();
  await page.locator('#historyList button.item', { hasText: 'Bare replay' }).click();
  await page.locator('#result').waitFor();
  await page.locator('#steps').dispatchEvent('click'); // nothing to show: no error
  assert.deepEqual(errors, []);
  await page.close();
});

test('inline validation: Run AI lists what needs attention, a refused start shows why; Record and Report check on blur', async () => {
  const page = await open(`#/p/${P}/ai`);
  await page.locator('#view-ai').waitFor();
  assert.equal(await page.evaluate(() => document.getElementById('f').noValidate), true); // no browser bubbles
  await page.fill('#url', ''); await page.fill('#task', 'short');
  await page.locator('#f button[type=submit]').first().click();
  await page.locator('#aiErrs', { hasText: '2 fields need attention' }).waitFor();
  assert.ok(await page.locator('#urlErr').isVisible()); assert.ok(await page.locator('#taskErr').isVisible());
  assert.equal(await page.locator('#view-ai').isVisible(), true);
  await page.fill('#url', 'http://x.test/'); await page.locator('#url').blur();
  assert.equal(await page.locator('#urlErr').isVisible(), false);
  await page.fill('#url', '{{nosuchvar}}/x'); await page.fill('#task', 'Open the page and check it');
  await page.locator('#f button[type=submit]').first().click();
  await page.locator('#aiErrs', { hasText: /nosuchvar/ }).waitFor(); // the server's reason, not "Connection lost"
  assert.equal(await page.locator('#view-ai').isVisible(), true);
  assert.equal(await page.locator('#f button[type=submit]').first().isDisabled(), false);
  await page.locator('nav.views [data-view=record]').click();
  await page.fill('#recUrl', 'notaurl');
  await page.locator('#recForm button[type=submit]').first().click();
  await page.locator('#recUrlErr').waitFor();
  await page.locator('#reportProblem').click();
  await page.locator('#repTitle').focus(); await page.locator('#repWhat').focus(); // Title left empty
  await page.locator('#repTitleErr').waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test('New project: three fields, errors under each, stays on Projects with a toast; Edit project keeps the full form', async () => {
  const page = await open('#/');
  await page.locator('#newProject').click();
  const dlg = page.locator('#newProjDlg');
  await dlg.waitFor();
  assert.equal(await dlg.locator('input, select, textarea').count(), 3);
  await page.locator('#npCreate').click();
  await page.locator('#npNameErr').waitFor();
  await page.fill('#npName', P); // exists already
  await page.fill('#npUrl', 'ftp://x');
  await page.locator('#npCreate').click();
  await page.locator('#npUrlErr').waitFor();
  await page.fill('#npUrl', 'http://new.test');
  await page.locator('#npCreate').click();
  await page.locator('#npNameErr', { hasText: /already exists|another/ }).waitFor(); // the server's reason, under Name
  await page.fill('#npName', 'zz-v9-new');
  await page.locator('#npCreate').click();
  await dlg.waitFor({ state: 'hidden' });
  await page.locator('#toast', { hasText: 'Project created' }).waitFor();
  assert.equal(await page.locator('#home').isVisible(), true);
  await page.locator('.project[data-id=zz-v9-new]').waitFor();
  assert.ok(await page.locator('.project[data-id=zz-v9-new]').isVisible());
  await page.goto(`${app.base}/#/p/zz-v9-new/ai`); await page.waitForFunction(() => window.__appStarted);
  await page.locator('#projSwitch').click();
  await page.locator('#projMenu [data-edit]').click();
  await page.locator('#projDlg').waitFor();
  assert.ok(await page.locator('#projDesc').isVisible()); // Edit project: the full form
  rmSync(join(app.root, 'tests', 'zz-v9-new'), { recursive: true, force: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('details: empty searches, Failed count, toasts, Settings tab keys, the phone header', async () => {
  const page = await open(`#/p/${P}/tests`);
  await page.locator('#testList .item').first().waitFor();
  await page.fill('#testSearch', 'zzzz');
  await page.locator('#testList .empty', { hasText: 'No tests match' }).waitFor();
  await page.locator('#clearTestSearch').click();
  assert.ok(await page.locator('#testList .item[data-name=ran]').isVisible());
  await page.locator('nav.views [data-view=history]').click();
  await page.locator('#historyList button.item').first().waitFor();
  const failed = await page.locator('[data-filter=fail] [data-count]').textContent();
  assert.equal(failed, '3'); // v9-rfail, v9-expfail, v9-marks: not the stopped ones
  await page.fill('#histSearch', 'zzzz');
  await page.locator('#historyList .empty', { hasText: 'No runs here' }).waitFor();
  await page.locator('#showAllRuns').click();
  assert.equal(await page.inputValue('#histSearch'), '');
  assert.ok(await page.locator('#historyList button.item').count() > 3);
  // toasts
  await page.locator('nav.views [data-view=workflows]').click();
  await page.locator('#wfNew').click();
  await page.fill('#wfName', 'Toast check');
  await page.fill('#insp textarea[name=prompt]', 'Open the home page'); // the AI task, selected
  await page.locator('#canvas .blk').nth(1).click();
  await page.fill('#insp textarea[name=prompt]', 'The home page is shown'); // the Check
  await page.locator('#wfSave').click();
  await page.locator('#toast', { hasText: 'Saved "Toast check"' }).waitFor();
  rmSync(join(app.root, 'tests', P, 'workflows', 'toast-check.json'), { force: true });
  await page.locator('.openSettings').first().click();
  await page.locator('#tabGuideBtn').click();
  await page.locator('#tabGuide textarea, #tabGuide input:not([type=file]):not([type=checkbox]):not([type=color])').first().fill('changed by the test');
  await page.locator('#discardP').click();
  await page.locator('#toast', { hasText: 'Changes discarded' }).waitFor();
  // tab keys
  await page.locator('#tabAiBtn').click(); await page.locator('#tabAiBtn').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#tabSecretBtn').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await page.locator('#tabLookBtn').getAttribute('aria-selected'), 'true');
  // phone header
  await page.setViewportSize({ width: 320, height: 700 });
  await page.locator('nav.views [data-view=tests]').evaluate(b => b.click());
  await page.locator('#view-tests').waitFor();
  assert.ok(await page.evaluate(() => document.getElementById('scroll').scrollWidth <= innerWidth));
  assert.equal(await page.locator('#runOptions .lbl').isVisible(), false);
  const ran = page.locator('#testList .item[data-name=ran]');
  assert.equal(await ran.locator('.pill').isVisible(), false); // as the mockup: no pill wrapping under the row on phones
  assert.deepEqual(errors, []);
  await page.close();
});
