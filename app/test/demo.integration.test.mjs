// "Try the demo": the practice project is imported once, with its saved tests and no secrets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

let app, dir;
before(async () => {
  app = await startApp({ port: 4392 });
  dir = join(app.root, 'tests', 'saucedemo');
  if (existsSync(dir)) throw new Error('tests/saucedemo already exists: this test would remove it');
});
after(() => { app.stop(); rmSync(dir, { recursive: true, force: true }); });

test('the demo project is added once, with its tests and nothing to fill in', async () => {
  const r = await app.req('/projects/demo', { method: 'POST' });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.id, 'saucedemo');
  assert.deepEqual([s.missingSecrets, s.missingVars], [[], []]);
  const p = (await (await app.req('/projects')).json()).find(x => x.id === 'saucedemo');
  assert.equal(p.name, 'Demo shop (Swag Labs)');
  assert.equal(p.tests.length, 2);
  // a second click opens the same project, no "saucedemo-2"
  assert.equal((await (await app.req('/projects/demo', { method: 'POST' })).json()).id, 'saucedemo');
  assert.equal(existsSync(join(app.root, 'tests', 'saucedemo-2')), false);
});
