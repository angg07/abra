// Saved prompts over HTTP: upload → save → list → use gives the file back; bad uploads, empty instructions and odd ids refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-prompts-api';
let app;
before(async () => {
  app = await startApp({ port: 4417 });
  mkdirSync(join(app.root, 'tests', P), { recursive: true });
  writeFileSync(join(app.root, 'tests', P, 'project.json'), JSON.stringify({ name: P }));
});
after(() => { if (app) { rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app.stop(); } });
const q = path => `${path}${path.includes('?') ? '&' : '?'}project=${P}`;

test('upload → save → list → use → delete', async () => {
  const up = await (await app.req('/uploads?name=Slip.pdf', { method: 'POST', body: '%PDF-slip' })).json();
  let r = await app.req(q('/prompts'), { method: 'POST', body: JSON.stringify({ title: 'B2 Polis P&I', url: 'http://jets.test/', task: 'Create a P&I policy', files: [up] }) });
  assert.equal(r.status, 200);
  const { id } = await r.json();
  assert.equal(id, 'b2-polis-p-i');
  assert.deepEqual((await (await app.req(q('/prompts'))).json()).map(p => [p.id, p.files]), [[id, ['Slip.pdf']]]);
  assert.equal((await (await app.req(q(`/prompts/${id}`))).json()).task, 'Create a P&I policy');
  const used = await (await app.req(q(`/prompts/${id}/use`), { method: 'POST' })).json();
  assert.deepEqual(used.map(f => [f.name, f.size]), [['Slip.pdf', 9]]);
  assert.match(used[0].id, /^[0-9a-f]{16}$/);
  r = await app.req(q(`/prompts/${id}`), { method: 'PUT', body: JSON.stringify({ title: 'B2 Polis P&I', task: 'Changed', files: [used[0]] }) });
  assert.deepEqual(await r.json(), { id });
  r = await app.req(q(`/prompts/${id}`), { method: 'DELETE' });
  assert.equal(r.status, 204);
  assert.equal(existsSync(join(app.root, 'tests', P, 'prompt-files', id)), false);
  assert.equal((await app.req(q(`/prompts/${id}`))).status, 404);
});

test('an expired upload, empty instructions and odd ids are refused', async () => {
  let r = await app.req(q('/prompts'), { method: 'POST', body: JSON.stringify({ task: 'x', files: [{ id: '0123456789abcdef', name: 'gone.pdf' }] }) });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /Uploaded file "gone.pdf" not found: add it again/);
  r = await app.req(q('/prompts'), { method: 'POST', body: JSON.stringify({ task: ' ' }) });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /The instructions are required/);
  for (const path of ['/prompts/..%2Fproject', '/prompts/NOPE', '/prompts/missing']) assert.notEqual((await app.req(q(path))).status, 200, path);
  assert.deepEqual(await (await app.req(q('/prompts'))).json(), []);
});
