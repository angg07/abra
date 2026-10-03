// The theme: dark by default, Settings › Appearance switches it at once and it survives a reload,
// "system" follows the computer, and a bad saved value or blocked storage still gives a working dark page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startApp } from './helpers/app-server.mjs';

let app, browser;
before(async () => { app = await startApp({ port: 4411 }); browser = await chromium.launch(); });
after(async () => { await browser?.close(); app?.stop(); });

// a fresh browser profile; `theme` is written once, before the first load only
async function open({ scheme = 'light', theme, broken = false } = {}) {
  const ctx = await browser.newContext({ colorScheme: scheme });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(([t, b]) => {
    try {
      localStorage.setItem('last', JSON.stringify({ setupSeen: true }));
      if (t !== undefined && !sessionStorage.getItem('seeded')) { localStorage.setItem('theme', t); sessionStorage.setItem('seeded', '1'); }
    } catch {}
    if (b) Storage.prototype.getItem = () => { throw new Error('storage blocked'); };
  }, [theme, broken]);
  await page.goto(app.base + '/');
  await page.waitForFunction(() => window.__appStarted);
  return { page, errors, theme: () => page.evaluate(() => document.documentElement.dataset.theme) };
}

test('dark by default, even when the computer is set to light', async () => {
  const { theme, errors } = await open({ scheme: 'light' });
  assert.equal(await theme(), 'dark');
  assert.deepEqual(errors, []);
});

test('Settings › Appearance › Light applies at once, leaves nothing unsaved, and survives a reload', async () => {
  const { page, theme, errors } = await open();
  await page.locator('.openSettings').first().click();
  await page.locator('#tabLookBtn').click();
  await page.locator('[data-theme-pick=light]').click();
  assert.equal(await theme(), 'light');
  assert.equal(await page.locator('[data-theme-pick=light]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-theme-pick=dark]').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#saveBar').isHidden(), true);
  await page.reload();
  await page.waitForFunction(() => window.__appStarted);
  assert.equal(await theme(), 'light');
  assert.deepEqual(errors, []);
});

test('the choice survives a new port (the desktop app starts its server on a free port each time)', async () => {
  const other = await startApp({ port: 4414 });
  try {
    const { page, theme } = await open();
    await page.locator('.openSettings').first().click();
    await page.locator('#tabLookBtn').click();
    await page.locator('[data-theme-pick=light]').click();
    assert.equal(await theme(), 'light');
    await page.goto(other.base + '/');
    await page.waitForFunction(() => window.__appStarted);
    assert.equal(await theme(), 'light');
  } finally { other.stop(); }
});

test('every rule of app.css reaches the page (a stray brace drops the rule after it)', async () => {
  const { page } = await open();
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#url')).boxSizing), 'border-box');
});

test('System follows the computer, also when it changes while the page is open', async () => {
  const { page, theme } = await open({ scheme: 'light', theme: 'system' });
  assert.equal(await theme(), 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
});

test('an unknown saved value, or storage that throws, gives a working dark page', async () => {
  for (const opts of [{ theme: 'purple' }, { theme: '' }, { broken: true }]) {
    const { theme, errors } = await open({ scheme: 'light', ...opts });
    assert.equal(await theme(), 'dark', JSON.stringify(opts));
    assert.deepEqual(errors, [], JSON.stringify(opts));
  }
});
