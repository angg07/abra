// Edit in Run AI, server side: Save as test keeps the source; source is found saved, in History, or from the code;
// use-files hands the test's files to the form; from-run overwrites script, source and files, never the data set.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './helpers/app-server.mjs';
import { prepareScript } from '../library.mjs';

const P = 'zz-source-api';
let app;
after(() => { if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });
const script = body => `import { test } from '@playwright/test';\ntest('t', async ({ page }) => { ${body} });\n`;
const addRun = run => {
  const db = new DatabaseSync(app.dbFile);
  db.prepare('INSERT INTO runs (id, project, started, user_id, video, guide, data) VALUES (?, ?, ?, NULL, NULL, NULL, ?)').run(run.id, P, run.started, JSON.stringify(run));
  db.close();
};
const req = (path, opts) => app.req(`${path}${path.includes('?') ? '&' : '?'}project=${P}`, opts);

test('Save as test from an AI run writes its source; a replay run writes none', async () => {
  app = await startApp({ port: 4425 });
  const dir = join(app.root, 'tests', P);
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: P }));
  addRun({ id: 'zz-src-ai', kind: 'ai', project: P, started: Date.now() - 5000, status: 'pass', url: 'http://a.test/', title: 'A', task: 'do a', env: 'e2e',
    providerId: 'claude-code', model: 'opus', recordAsked: true, guideAsked: false, script: script("await page.goto('http://a.test/');") });
  addRun({ id: 'zz-src-replay', kind: 'replay', project: P, started: Date.now() - 4000, status: 'pass', task: 'Replay: x', script: script('') });
  assert.equal((await req('/tests', { method: 'POST', body: JSON.stringify({ name: 'from-ai', runId: 'zz-src-ai' }) })).status, 200);
  assert.equal((await req('/tests', { method: 'POST', body: JSON.stringify({ name: 'from-replay', runId: 'zz-src-replay' }) })).status, 200);
  const src = JSON.parse(readFileSync(join(dir, 'sources', 'from-ai.json'), 'utf8'));
  assert.deepEqual([src.task, src.url, src.env, src.provider, src.record], ['do a', 'http://a.test/', 'e2e', 'claude-code', true]);
  assert.equal(existsSync(join(dir, 'sources', 'from-replay.json')), false);
  assert.equal((await (await req('/tests/from-ai/source')).json()).from, 'saved');
});

test('an older test finds its source in History by its script, else from its code', async () => {
  const dir = join(app.root, 'tests', P);
  const code = script("await page.goto('http://old.test/start');");
  addRun({ id: 'zz-src-old', kind: 'ai', project: P, started: Date.now() - 3000, status: 'pass', url: 'http://old.test/start', task: 'the old one', script: code });
  writeFileSync(join(dir, 'old.spec.ts'), prepareScript(code)); // saved before sources existed
  writeFileSync(join(dir, 'hand.spec.ts'), script("await page.goto('http://hand.test/x');")); // written by hand
  const old = await (await req('/tests/old/source')).json();
  assert.deepEqual([old.from, old.source.task], ['history', 'the old one']);
  assert.equal(existsSync(join(dir, 'sources', 'old.json')), false); // found, not written
  const hand = await (await req('/tests/hand/source')).json();
  assert.deepEqual([hand.from, hand.source.url, hand.source.title, hand.source.task], ['code', 'http://hand.test/x', 'hand', '']);
  assert.equal((await req('/tests/nope/source')).status, 404);
});

test('use-files hands the test files over as uploads; from-run overwrites script, source and files but not the data set', async () => {
  const dir = join(app.root, 'tests', P);
  mkdirSync(join(dir, 'files', 'from-ai'), { recursive: true });
  writeFileSync(join(dir, 'files', 'from-ai', 'old.pdf'), 'OLD');
  writeFileSync(join(dir, 'files', 'from-ai', 'kept.xlsx'), 'KEPT');
  mkdirSync(join(dir, 'data'), { recursive: true }); writeFileSync(join(dir, 'data', 'from-ai.csv'), 'a\n1\n');
  const ups = await (await req('/tests/from-ai/use-files', { method: 'POST' })).json();
  assert.deepEqual(ups.map(u => u.name).sort(), ['kept.xlsx', 'old.pdf']);
  const fresh = await (await app.req('/uploads?name=new.pdf', { method: 'POST', body: Buffer.from('NEW'), headers: { 'content-type': 'application/octet-stream' } })).json();
  const kept = ups.find(u => u.name === 'kept.xlsx');
  // the run used the kept file and a new one; the kept upload has expired (pruned) by the time of Update
  rmSync(join(app.root, 'app', 'data', 'uploads', kept.id), { recursive: true, force: true });
  addRun({ id: 'zz-src-edit', kind: 'ai', project: P, started: Date.now(), status: 'pass', editOf: 'from-ai', url: 'http://a.test/v2', task: 'do a, version 2',
    files: [fresh, { id: kept.id, name: 'kept.xlsx' }], script: script("await page.goto('http://a.test/v2');") });
  const res = await (await req('/tests/from-ai/from-run', { method: 'PUT', body: JSON.stringify({ runId: 'zz-src-edit' }) })).json();
  assert.equal(res.name, 'from-ai'); assert.equal(res.missingFiles, undefined); // the test still had its own kept.xlsx
  assert.match(readFileSync(join(dir, 'from-ai.spec.ts'), 'utf8'), /a\.test\/v2/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'sources', 'from-ai.json'), 'utf8')).task, 'do a, version 2');
  assert.equal(readFileSync(join(dir, 'files', 'from-ai', 'new.pdf'), 'utf8'), 'NEW');
  assert.equal(readFileSync(join(dir, 'files', 'from-ai', 'kept.xlsx'), 'utf8'), 'KEPT');
  assert.equal(existsSync(join(dir, 'files', 'from-ai', 'old.pdf')), false); // not used by the run any more
  assert.equal(readFileSync(join(dir, 'data', 'from-ai.csv'), 'utf8'), 'a\n1\n');
  assert.equal((await req('/tests/gone/from-run', { method: 'PUT', body: JSON.stringify({ runId: 'zz-src-edit' }) })).status, 404);
});

test('from-run takes only an AI run of the same project; a deleted test says so', async () => {
  const dir = join(app.root, 'tests', P);
  writeFileSync(join(dir, 'files', 'from-ai', 'mine.pdf'), 'MINE');
  addRun({ id: 'zz-src-replay2', kind: 'replay', project: P, started: Date.now(), status: 'pass', task: 'Replay: from-ai', script: script('') });
  addRun({ id: 'zz-src-other', kind: 'ai', project: 'zz-elsewhere', started: Date.now(), status: 'pass', task: 'other', script: script('') });
  for (const runId of ['zz-src-replay2', 'zz-src-other']) {
    const r = await req('/tests/from-ai/from-run', { method: 'PUT', body: JSON.stringify({ runId }) });
    assert.equal(r.status, 400, runId);
  }
  assert.equal(readFileSync(join(dir, 'files', 'from-ai', 'mine.pdf'), 'utf8'), 'MINE'); // nothing was touched
  assert.match(await (await req('/tests/gone/from-run', { method: 'PUT', body: JSON.stringify({ runId: 'zz-src-edit' }) })).text(), /no longer exists/);
});
