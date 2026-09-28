// Opens the real page in headless Chromium: it must land on Projects with no sign-in and no script errors.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

let app, browser;
after(async () => { await browser?.close(); if (app) rmSync(join(app.root, 'tests', 'zz-ui-import'), { recursive: true, force: true }); app?.stop(); });

test('the page opens on Projects without signing in', async () => {
  app = await startApp({ port: 4396 });
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(app.base);
  await page.locator('#shell').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.locator('#authView').count(), 0); // the sign-in screen is gone
  assert.equal(await page.locator('#newProject').isVisible(), true);
  await page.locator('.openSettings').click();
  assert.equal(await page.locator('#tabUsersBtn').count(), 0);
  assert.deepEqual(errors, []);
});

test('Import reads a project file and opens the imported project', async () => {
  const page = await browser.newPage();
  page.on('dialog', d => d.accept()); // the file list confirmation
  await page.goto(app.base);
  await page.locator('#importProject').waitFor();
  const bundle = { format: 'ai-browser-runner-project', version: 1, project: { id: 'zz-ui-import', name: 'UI import' }, secrets: [],
    files: { 'a.spec.ts': { text: "import { test } from '@playwright/test';\ntest('a', async () => {});" } } };
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#importProject').click();
  await (await chooser).setFiles({ name: 'zz-ui-import.abr.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
  await page.waitForURL(/#\/p\/zz-ui-import$/, { timeout: 5000 });
  await page.locator('#projName', { hasText: 'UI import' }).waitFor({ timeout: 5000 }); // route() loads the project list first
});

test('Settings: a change shows the save bar and marks its tab; Discard reverts; leaving asks first; Save keeps it', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const files = ['settings.json', 'providers.json'].map(f => join(app.root, 'app', f));
  const saved = files.map(f => readFileSync(f)); // Save writes the real files: put them back afterwards
  const page = await browser.newPage();
  try {
    await page.goto(app.base);
    await page.locator('.openSettings').click();
    const bar = page.locator('#saveBar');
    assert.equal(await bar.isVisible(), false); // nothing changed yet
    await page.locator('#tabGuideBtn').click();
    const company = page.locator('#guideCompany');
    const before = await company.inputValue();
    await company.fill('Changed Co');
    await bar.waitFor({ state: 'visible' });
    assert.match(await bar.textContent(), /PDF guides/);
    assert.equal(await page.locator('#tabGuideBtn .dirty-dot').count(), 1);

    await page.locator('#discardP').click();
    await bar.waitFor({ state: 'hidden' }); // Discard reloads the saved settings from the server
    assert.equal(await company.inputValue(), before);

    await company.fill('Changed Co');
    const asked = page.waitForEvent('dialog', { timeout: 5000 }); // "Leave without saving?"
    await page.locator('#toProjects').click();
    const dlg = await asked;
    assert.match(dlg.message(), /unsaved changes in PDF guides/);
    await dlg.dismiss(); // stay
    assert.equal(await page.locator('#view-settings').isVisible(), true);

    await page.locator('#saveP').click();
    await bar.waitFor({ state: 'hidden' });
    const s = await page.evaluate(() => fetch('/settings').then(r => r.json()));
    assert.equal(s.guide.company, 'Changed Co');
  } finally {
    files.forEach((f, i) => writeFileSync(f, saved[i]));
    await page.close();
  }
});
