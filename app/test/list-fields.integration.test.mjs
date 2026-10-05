// The list endpoints carry what the redesigned pages show: per project its workflows and this week's runs,
// per run its number of steps, per workflow its chain of block types.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-list-fields';
let app;
after(() => { if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });

test('projects, history and workflows carry the new fields', async () => {
  app = await startApp({ port: 4423 });
  const dir = join(app.root, 'tests', P);
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: P }));
  writeFileSync(join(dir, 'workflows', 'w.json'), JSON.stringify({ name: 'W', blocks: [{ type: 'ai' }, { type: 'loop', blocks: [{ type: 'test' }] }, { type: 'validate' }] }));
  const db = new DatabaseSync(app.dbFile), day = 86_400_000, now = Date.now();
  const add = (id, started, status, extra = {}) => db.prepare('INSERT INTO runs (id, project, started, data) VALUES (?, ?, ?, ?)')
    .run(id, P, started, JSON.stringify({ id, project: P, started, status, kind: 'replay', ...extra }));
  add('r1', now - day, 'pass', { steps: [{}, {}], replaySteps: [{ what: 'a' }, { section: 'S' }, { what: 'b' }] });
  add('r2', now - 2 * day, 'fail');
  add('r3', now - 10 * day, 'pass'); // older than a week
  db.close();
  const pr = (await (await app.req('/projects')).json()).find(x => x.id === P);
  assert.equal(pr.workflows, 1);
  assert.deepEqual(pr.week, { runs: 2, passed: 1 });
  const hist = await (await app.req(`/history?project=${P}`)).json();
  assert.equal(hist.find(r => r.id === 'r1').stepCount, 4); // 2 AI steps + 2 replay steps, sections not counted
  assert.equal(hist.find(r => r.id === 'r2').stepCount, 0);
  const wf = await (await app.req(`/workflows?project=${P}`)).json();
  assert.deepEqual(wf[0].types, ['ai', 'loop', 'validate']);
});
