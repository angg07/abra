// Run AI › Attach instructions (.md): the file's text goes with the task, is checked (100 KB), and stays with
// a saved prompt; the form uploads it and names it in the run's address (instr), Run again from History uses instrRun.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-instr';
let app, browser;
after(async () => { await browser?.close(); if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });

test('attached instructions: checked by the server, kept by saved prompts and the Run AI form', async () => {
  app = await startApp({ port: 4437 });
  mkdirSync(join(app.root, 'tests', P), { recursive: true }); writeFileSync(join(app.root, 'tests', P, 'project.json'), JSON.stringify({ name: P }));
  const up = async (name, text) => (await app.req(`/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', body: text, headers: { 'content-type': 'application/octet-stream' } })).json();
  const check = instr => app.req(`/run?${new URLSearchParams({ project: P, url: 'http://127.0.0.1:9/', task: 'Test the form', instr: JSON.stringify(instr), check: '1' })}`);

  // the server: an upload within 100 KB passes, a bigger one or a missing one is refused with a reason
  const ok = await up('plan.md', '# Plan\n1. Open the form');
  assert.equal((await check(ok)).status, 204);
  const big = await up('big.md', 'x'.repeat(100 * 1024 + 1));
  const refused = await check(big);
  assert.equal(refused.status, 400); assert.match(await refused.text(), /100 KB/);
  assert.equal((await check({ id: '0123456789abcdef', name: 'gone.md' })).status, 400);

  // saved prompts keep { name, text }; too big is refused
  const ins = { name: 'plan.md', text: '# Plan\n1. Open the form' };
  const { id } = await (await app.req(`/prompts?project=${P}`, { method: 'POST', body: JSON.stringify({ title: 'With plan', url: 'http://x.test/', task: 'Test the form', instructions: ins }) })).json();
  assert.deepEqual((await (await app.req(`/prompts/${id}?project=${P}`)).json()).instructions, ins);
  const tooBig = await app.req(`/prompts?project=${P}`, { method: 'POST', body: JSON.stringify({ task: 'Test the form', instructions: { name: 'b.md', text: 'x'.repeat(100 * 1024 + 1) } }) });
  assert.equal(tooBig.status, 400);

  // the form: attach, see it, remove; a saved prompt brings it back; Run AI uploads it and names it as instr
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('last', JSON.stringify({ setupSeen: true })));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${app.base}/#/p/${P}/ai`);
  await page.locator('#view-ai').waitFor();
  await page.locator('#aiInstrIn').setInputFiles({ name: 'steps.md', mimeType: 'text/markdown', buffer: Buffer.from('# Steps\nCheck the totals') });
  await page.locator('#aiInstr').getByText('steps.md').waitFor();
  assert.equal(await page.locator('#aiInstrAddText').textContent(), 'Replace instructions');
  await page.locator('#aiInstr button').click();
  assert.equal(await page.locator('#aiInstr li').count(), 0);
  await page.locator('#promptList [data-id] [data-act=open]').first().click();
  await page.locator('#aiInstr').getByText('plan.md').waitFor();
  let runUrl;
  await page.route('**/run?**', route => { runUrl = new URL(route.request().url()); return route.fulfill({ status: 400, body: 'stop here' }); });
  await page.click('#runAiBtn');
  await page.locator('#aiErrs').getByText('stop here').waitFor();
  const instr = JSON.parse(runUrl.searchParams.get('instr'));
  assert.equal(instr.name, 'plan.md');
  assert.match(instr.id, /^[0-9a-f]{16}$/);
  assert.deepEqual(errors, []);
});
