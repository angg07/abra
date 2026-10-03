// Fonts ship with the app: the page loads nothing from the internet, and /fonts/ serves only woff2 files from app/fonts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

let app;
before(async () => { app = await startApp({ port: 4412 }); });
after(() => app.stop());

test('every font the CSS names is served as woff2', async () => {
  const css = readFileSync(join(app.root, 'app', 'app.css'), 'utf8');
  const urls = [...css.matchAll(/url\('(\/fonts\/[^']+)'\)/g)].map(m => m[1]);
  assert.equal(urls.length, 5);
  for (const u of urls) {
    const r = await fetch(app.base + u);
    assert.equal(r.status, 200, u);
    assert.equal(r.headers.get('content-type'), 'font/woff2', u);
    assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString('latin1'), 'wOF2', u);
  }
});

test('a missing font or a path out of the folder is not served', async () => {
  assert.equal((await fetch(app.base + '/fonts/nope.woff2')).status, 404);
  for (const p of ['/fonts/..%2Fserver.mjs', '/fonts/../server.mjs', '/fonts/inter-400.woff2.js']) {
    const r = await fetch(app.base + p);
    assert.notEqual(r.status, 200, p);
  }
});

test('the page loads no stylesheet, font or script from the internet', async () => {
  const html = await (await fetch(app.base + '/')).text();
  assert.doesNotMatch(html, /<(link|script)[^>]+(href|src)="https?:/i);
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
});
