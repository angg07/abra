// Export a project over HTTP, import it back (conflict, as new, overwrite), and replay the imported test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

let app;
const ids = ['zz-share', 'zz-share-2', 'zz-notproj', 'zz-secret', 'zz-all-a', 'zz-all-b', 'zz-all-a-2', 'zz-all-b-2', 'zz-all-bad'];
before(async () => {
  app = await startApp({ port: 4395, env: { SECRET_ZZ_TEST: 'not-a-real-secret' } });
  const dir = join(app.root, 'tests', 'zz-share');
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: 'Share', codebase: app.root, db: { nowhere: { type: 'postgres', host: 'localhost', port: 5432, database: 'x_e2e', user: 'u' } } }));
  writeFileSync(join(dir, 'hello.spec.ts'), `import { test, expect } from '@playwright/test';
test('hello', async ({ page }) => { await page.setContent('<h1>{{unknownUrl}}</h1>'.replace('{{unknownUrl}}', 'hi')); await expect(page.getByRole('heading', { name: 'hi' })).toBeVisible(); });`);
  writeFileSync(join(dir, 'data', 'hello.csv'), 'a\n1\n');
});
after(() => { app.stop(); for (const id of ids) rmSync(join(app.root, 'tests', id), { recursive: true, force: true }); });

const post = body => app.req('/projects/import', { method: 'POST', body: JSON.stringify(body) });

test('export, then import: conflict, as new, overwrite; a bad file writes nothing', async () => {
  const r = await app.req('/projects/zz-share/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="zz-share\.abr\.json"/);
  const bundle = await r.json();
  assert.deepEqual(Object.keys(bundle.files).sort(), ['data/hello.csv', 'hello.spec.ts']);
  assert.equal(bundle.project.codebase, undefined); // a folder on this computer: not shared

  const conflict = await post({ bundle });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { conflict: 'zz-share', suggestion: 'zz-share-2' });

  const asNew = await post({ bundle: { ...bundle, project: { ...bundle.project, codebase: '/etc' } }, mode: 'new' }); // never taken from a file
  assert.equal(asNew.status, 200);
  const sum = await asNew.json();
  assert.equal(sum.id, 'zz-share-2'); assert.equal(sum.files, 2);
  assert.deepEqual(sum.missingVars, ['unknownUrl']);
  assert.deepEqual(sum.skippedDb, ['nowhere']); // no such environment on this laptop
  const list = await (await app.req('/projects')).json();
  assert.equal(list.find(p => p.id === 'zz-share-2').name, 'Share (2)');
  assert.equal(list.find(p => p.id === 'zz-share-2').codebase, undefined);
  // this computer's folder, set on the imported project, survives an overwrite
  const put = await app.req('/projects/zz-share-2', { method: 'PUT', body: JSON.stringify({ name: 'Share (2)', codebase: `${app.root}\n\n${join(app.root, 'tests')}\n${app.root}` }) }); // one per line
  assert.equal(put.status, 200);
  const badPut = await app.req('/projects/zz-share-2', { method: 'PUT', body: JSON.stringify({ name: 'Share (2)', codebase: 'relative/path' }) });
  assert.equal(badPut.status, 400);

  // overwrite replaces the files and keeps the project's history (Review Focus 3)
  delete bundle.files['data/hello.csv'];
  const over = await post({ bundle: { ...bundle, project: { ...bundle.project, id: 'zz-share-2' } }, mode: 'overwrite' });
  assert.equal(over.status, 200);
  assert.equal(existsSync(join(app.root, 'tests', 'zz-share-2', 'data', 'hello.csv')), false);
  assert.deepEqual((await (await app.req('/projects')).json()).find(p => p.id === 'zz-share-2').codebase, [app.root, join(app.root, 'tests')]);

  // a rejected file writes nothing (Review Focus 2)
  const before = readdirSync(join(app.root, 'tests')).sort();
  const evil = await post({ bundle: { ...bundle, project: { ...bundle.project, id: 'zz-evil' }, files: { ...bundle.files, '../../x.spec.ts': { text: 'x' } } }, mode: 'new' });
  assert.equal(evil.status, 400);
  assert.deepEqual(readdirSync(join(app.root, 'tests')).sort(), before);
});

test('the imported test replays and passes', async () => {
  const r = await app.req(`/replay?${new URLSearchParams({ project: 'zz-share-2', tests: 'hello', record: '0', guide: '0' })}`);
  const text = await r.text();
  assert.match(text, /event: saved/);
  assert.match(text, /"status":"passed"/);
});

test('overwrite only replaces a real project, never a plain folder', async () => {
  const dir = join(app.root, 'tests', 'zz-notproj');
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'keep.txt'), 'mine');
  const bundle = await (await app.req('/projects/zz-share/export')).json();
  const r = await post({ bundle: { ...bundle, project: { ...bundle.project, id: 'zz-notproj' } }, mode: 'overwrite' });
  assert.notEqual(r.status, 200);
  assert.equal(existsSync(join(dir, 'keep.txt')), true);
});

test('import never gives the project a secret by itself; it lists them to bind', async () => {
  const bundle = await (await app.req('/projects/zz-share/export')).json();
  const r = await post({ bundle: { ...bundle, project: { ...bundle.project, id: 'zz-secret', name: 'Secret' }, secrets: ['ZZ_TEST', 'ZZ_MISSING'] }, mode: 'new' });
  assert.equal(r.status, 200);
  const sum = await r.json();
  assert.deepEqual(sum.unboundSecrets, ['ZZ_TEST']);
  assert.deepEqual(sum.missingSecrets, ['ZZ_MISSING']);
  const settings = await (await app.req('/settings')).json();
  assert.equal((settings.secretProjects.ZZ_TEST ?? []).includes('zz-secret'), false);
});

test('export all: every project in one file, without this computer\'s codebase folders', async () => {
  const r = await app.req('/projects/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="abra-projects-\d{4}-\d{2}-\d{2}\.abr\.json"/);
  const all = await r.json();
  assert.equal(all.format, 'ai-browser-runner-projects');
  const share = all.projects.find(b => b.project.id === 'zz-share');
  assert.ok(share, 'the project is in the file');
  assert.deepEqual(Object.keys(share.files).sort(), ['data/hello.csv', 'hello.spec.ts']);
  assert.ok(all.projects.every(b => b.project.codebase === undefined));
});

test('import all: checked first, then conflicts are asked once (skip, new copies, overwrite)', async () => {
  const one = (id, name) => ({ format: 'ai-browser-runner-project', version: 1, project: { id, name }, secrets: [],
    files: { 'a.spec.ts': { text: "import { test } from '@playwright/test';\ntest('a', async () => {});" } } });
  const file = { format: 'ai-browser-runner-projects', version: 1, projects: [one('zz-all-a', 'All A'), one('zz-all-b', 'All B')] };

  const first = await post({ bundle: file });
  assert.equal(first.status, 200, await first.clone().text());
  assert.deepEqual((await first.json()).results.map(x => x.id), ['zz-all-a', 'zz-all-b']);

  const again = await post({ bundle: file });
  assert.equal(again.status, 409);
  assert.deepEqual((await again.json()).conflicts, ['zz-all-a', 'zz-all-b']);

  const skip = await (await post({ bundle: file, mode: 'skip' })).json();
  assert.deepEqual(skip.results, [{ skipped: 'zz-all-a' }, { skipped: 'zz-all-b' }]);
  const copies = await (await post({ bundle: file, mode: 'new' })).json();
  assert.deepEqual(copies.results.map(x => x.id), ['zz-all-a-2', 'zz-all-b-2']);

  // one bad project in the file, or the same id twice: nothing is written
  const before = readdirSync(join(app.root, 'tests')).sort();
  const bad = await post({ bundle: { ...file, projects: [one('zz-all-bad', 'Bad'), { ...one('zz-all-b', 'B'), files: { '../x.spec.ts': { text: 'x' } } }] }, mode: 'new' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Project 2 \(B\)/);
  const twice = await post({ bundle: { ...file, projects: [one('zz-all-bad', 'Bad'), one('zz-all-bad', 'Bad')] } });
  assert.equal(twice.status, 400);
  assert.deepEqual(readdirSync(join(app.root, 'tests')).sort(), before);
});
