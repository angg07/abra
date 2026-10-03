// app/test/files-api.integration.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-files-api';
let app;
after(() => { if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });
const raw = (path, data) => app.req(path, { method: 'POST', body: data, headers: { 'content-type': 'application/octet-stream' } });

test('test files: upload, list, replace, delete; 20 MB limit; Run AI uploads', async () => {
  app = await startApp({ port: 4408 });
  const dir = join(app.root, 'tests', P);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: P }));
  writeFileSync(join(dir, 'claim.spec.ts'), "import { test } from '@playwright/test';\ntest('t', async () => {});\n");
  const q = `project=${P}`;

  assert.deepEqual(await (await raw(`/tests/claim/files?${q}&name=${encodeURIComponent('Template Klaim.xlsx')}`, Buffer.from('one'))).json(), { name: 'Template-Klaim.xlsx' });
  await raw(`/tests/claim/files?${q}&name=Template-Klaim.xlsx`, Buffer.from('two!'));
  assert.deepEqual(await (await app.req(`/tests/claim/files?${q}`)).json(), [{ name: 'Template-Klaim.xlsx', size: 4 }]);

  const big = await raw(`/tests/claim/files?${q}&name=big.bin`, Buffer.alloc(20 * 1024 * 1024 + 1));
  assert.equal(big.status, 413);
  assert.equal(await big.text(), 'File too large: at most 20 MB');
  assert.equal(existsSync(join(dir, 'files', 'claim', 'big.bin')), false);

  assert.equal((await app.req(`/tests/claim/files/Template-Klaim.xlsx?${q}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(await (await app.req(`/tests/claim/files?${q}`)).json(), []);
  assert.equal((await app.req(`/tests/nope/files?${q}`)).status, 404);

  const up = await (await raw(`/uploads?name=${encodeURIComponent('polis 2026.pdf')}`, Buffer.from('%PDF'))).json();
  assert.match(up.id, /^[0-9a-f]{16}$/);
  assert.equal(up.name, 'polis-2026.pdf');
});
