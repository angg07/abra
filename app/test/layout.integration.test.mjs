// The sticky page header: once a page is scrolled, boxes that stay in view (Run AI's run settings, the Settings
// section list) sit below it instead of sliding under it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-layout';
let app, browser;
after(async () => { await browser?.close(); if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });

test('sticky boxes stay below the sticky page header when the page is scrolled', async () => {
  app = await startApp({ port: 4415 });
  mkdirSync(join(app.root, 'tests', P), { recursive: true });
  writeFileSync(join(app.root, 'tests', P, 'project.json'), JSON.stringify({ name: P }));
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 480 } });
  await page.addInitScript(() => localStorage.setItem('last', JSON.stringify({ setupSeen: true })));
  await page.goto(`${app.base}/#/p/${P}`);
  await page.locator('#view-ai').waitFor();
  const gap = sel => page.evaluate(s => {
    const main = document.getElementById('scroll'); main.scrollTop = 60; // a little: far enough that the header sticks, within the boxes' own sticky range
    const head = [...document.querySelectorAll('.page-head')].find(h => h.offsetParent);
    return document.querySelector(s).getBoundingClientRect().top - head.getBoundingClientRect().bottom;
  }, sel);
  assert.ok(await gap('#view-ai .side-card') >= 0, 'Run AI settings card under the header');
  await page.locator('.openSettings').first().click();
  await page.locator('#view-settings').waitFor();
  assert.ok(await gap('#sf .tabs') >= 0, 'Settings section list under the header');
});
