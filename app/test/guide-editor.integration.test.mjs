// The guide editor over HTTP: a replay makes a PDF guide and its document; the editor reads it, saves notes,
// warnings and sections (the PDF is made again) and refuses screenshots from outside the guide.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

let app;
const project = 'zz-guide-edit';
before(async () => {
  app = await startApp({ port: 4393 });
  const dir = join(app.root, 'tests', project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: 'Guide edit' }));
  writeFileSync(join(dir, 'save.spec.ts'), `import { test, expect } from '@playwright/test';
test('save', async ({ page }) => {
  await page.setContent('<label>Name <input></label><button onclick="this.textContent=\\'Saved\\'">Save</button>');
  await page.getByLabel('Name').fill('Ada');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
});`);
});
after(() => { app.stop(); rmSync(join(app.root, 'tests', project), { recursive: true, force: true }); });

test('a guide can be edited: notes, warnings and sections go into a new PDF', async () => {
  const stream = await (await app.req(`/replay?${new URLSearchParams({ project, tests: 'save', record: '0', guide: '1' })}`)).text();
  const pdf = stream.match(/event: guide\ndata: "\/guides\/([\w-]+\.pdf)"/)?.[1];
  assert.ok(pdf, stream.slice(-500));

  const doc = await (await app.req(`/guides/${pdf}/doc`)).json();
  const steps = doc.blocks.filter(b => b.type === 'step');
  assert.ok(steps.some(b => /\*\*“Save”\*\*/.test(b.text)), JSON.stringify(steps));
  const frame = steps.find(b => b.frame)?.frame;
  assert.equal((await app.req(`/guides/${pdf}/${frame}`)).headers.get('content-type'), 'image/jpeg');

  const before = statSync(join(app.root, 'app', 'guides', pdf)).mtimeMs;
  const edited = { ...doc, title: 'Saving a name', description: 'For **admins**', blocks: [{ type: 'section', text: 'Start', level: 1 }, ...doc.blocks, { type: 'tip', text: '- one\n- two' }, { type: 'alert', text: 'Careful' }] };
  const put = await app.req(`/guides/${pdf}/doc`, { method: 'PUT', body: JSON.stringify({ doc: edited }) });
  assert.equal(put.status, 200, await put.clone().text());
  const saved = await (await app.req(`/guides/${pdf}/doc`)).json();
  assert.equal(saved.title, 'Saving a name');
  assert.deepEqual(saved.blocks.at(-1), { type: 'alert', text: 'Careful' });
  assert.ok(statSync(join(app.root, 'app', 'guides', pdf)).mtimeMs > before, 'the PDF is made again');

  const bad = await app.req(`/guides/${pdf}/doc`, { method: 'PUT', body: JSON.stringify({ doc: { blocks: [{ type: 'step', text: 'x', frame: '../../../.env' }] } }) });
  assert.equal(bad.status, 400);
  assert.equal((await app.req(`/guides/${pdf}/../../.env`)).status, 404);
});

test('an image can be replaced (file or paste): the new one goes in the PDF, the old one is removed on save', async () => {
  const stream = await (await app.req(`/replay?${new URLSearchParams({ project, tests: 'save', record: '0', guide: '1' })}`)).text();
  const pdf = stream.match(/event: guide\ndata: "\/guides\/([\w-]+\.pdf)"/)[1];
  const folder = join(app.root, 'app', 'guides', pdf.replace(/\.pdf$/, ''));
  const doc = await (await app.req(`/guides/${pdf}/doc`)).json();
  const i = doc.blocks.findIndex(b => b.frame);
  const old = doc.blocks[i].frame;
  // a 1x1 PNG
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await app.req(`/guides/${pdf}/frame`, { method: 'POST', body: JSON.stringify({ dataUrl: png }) });
  assert.equal(up.status, 200, await up.clone().text());
  const { frame } = await up.json();
  assert.match(frame, /^\d{3}\.png$/);
  assert.equal((await app.req(`/guides/${pdf}/${frame}`)).headers.get('content-type'), 'image/png');

  doc.blocks[i].frame = frame;
  const put = await app.req(`/guides/${pdf}/doc`, { method: 'PUT', body: JSON.stringify({ doc }) });
  assert.equal(put.status, 200, await put.clone().text());
  assert.equal((await (await app.req(`/guides/${pdf}/doc`)).json()).blocks[i].frame, frame);
  assert.equal(existsSync(join(folder, old)), false, 'the replaced screenshot is gone');

  const notImage = await app.req(`/guides/${pdf}/frame`, { method: 'POST', body: JSON.stringify({ dataUrl: 'data:image/png;base64,' + Buffer.from('#!/bin/sh').toString('base64') }) });
  assert.equal(notImage.status, 400);
});
