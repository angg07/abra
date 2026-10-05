// Edit test › Files: upload two files, see them listed with their {{file.X}} value, delete one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-files-ui';
let app, browser;
after(async () => { await browser?.close(); if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });

test('Edit test › Files uploads, lists and deletes files', async () => {
  app = await startApp({ port: 4410 });
  const dir = join(app.root, 'tests', P);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: P }));
  writeFileSync(join(dir, 'claim.spec.ts'), "import { test } from '@playwright/test';\ntest('t', async () => {});\n");
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('last', JSON.stringify({ setupSeen: true })));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${app.base}/#/p/${P}`);
  await page.locator('nav.views [data-view=tests]').click();
  await page.locator('#testList .item[data-name=claim] [data-act=menu]').click();
  await page.locator('#testList .item[data-name=claim] .menu [data-act=edit]').click();
  await page.locator('#editFileIn').setInputFiles([
    { name: 'Template Klaim.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('x') },
    { name: 'polis.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') },
  ]);
  await page.locator('#editFiles').getByText('{{file.polis.pdf}}').waitFor();
  assert.match(await page.locator('#editFiles').textContent(), /\{\{file\.Template-Klaim\.xlsx\}\}/);
  await page.locator('#editFiles li', { hasText: 'polis.pdf' }).getByRole('button', { name: /Delete/ }).click();
  await page.locator('#editFiles').getByText('polis.pdf').waitFor({ state: 'detached' });
  assert.equal(existsSync(join(dir, 'files', 'claim', 'polis.pdf')), false);
  assert.deepEqual(errors, []);
});
