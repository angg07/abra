// A saved test's source: the Run AI form that made it (tests/<project>/sources/<test>.json)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, testsDir, saveTest, deleteTest } from '../library.mjs';
import { packProject } from '../bundle.mjs';
import { readSource, saveSource, deleteSource, sourceFromRun, sourceFromCode } from '../test-sources.mjs';

const P = 'zz-sources';
// projectDir() needs the project's project.json: create the folder first
const root = join(testsDir, P);
mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'project.json'), JSON.stringify({ name: P }));
const dir = () => projectDir(P);
after(() => rmSync(root, { recursive: true, force: true }));

test('save and read keep only the known fields; a missing or broken file is null', () => {
  assert.equal(readSource(P, 'none'), null);
  saveSource(P, 'a', { url: 'http://x.test/', task: 'do it', record: true, extra: 'dropped' });
  const s = readSource(P, 'a');
  assert.equal(s.url, 'http://x.test/'); assert.equal(s.task, 'do it'); assert.equal(s.record, true); assert.equal(s.guide, false);
  assert.equal('extra' in s, false);
  assert.match(s.saved, /^\d{4}-/);
  writeFileSync(join(dir(), 'sources', 'b.json'), '{not json');
  assert.equal(readSource(P, 'b'), null);
  writeFileSync(join(dir(), 'sources', 'c.json'), JSON.stringify({ task: 7, url: 'http://y.test/', evil: '../../x' }));
  assert.deepEqual([readSource(P, 'c').task, readSource(P, 'c').url, 'evil' in readSource(P, 'c')], ['', 'http://y.test/', false]);
  deleteSource(P, 'a');
  assert.equal(existsSync(join(dir(), 'sources', 'a.json')), false);
  assert.throws(() => saveSource(P, '../x', {}), /not found/);
});

test('from a run: the asked-for options, not the PDF file name in guide', () => {
  const s = sourceFromRun({ kind: 'ai', url: '{{baseUrl}}/nb', title: 'NB', task: 'make one', expected: 'saved', env: 'jets-testing', session: 'admin',
    providerId: 'claude-code', provider: 'Claude Code', model: 'opus', flow: 'f1', recordAsked: true, guideAsked: true, guide: '2026-x.pdf' });
  assert.deepEqual({ ...s, saved: '' }, { title: 'NB', url: '{{baseUrl}}/nb', task: 'make one', expected: 'saved', env: 'jets-testing', session: 'admin',
    provider: 'claude-code', model: 'opus', record: true, guide: true, flow: 'f1', saved: '' });
  const old = sourceFromRun({ kind: 'ai', url: 'http://a.test/', task: 't', provider: 'Claude Code', guide: 'x.pdf' }); // a run from before 1.6.0
  assert.equal(old.provider, ''); assert.equal(old.guide, false); assert.equal(old.record, false);
});

test('from code: the first goto() URL with its placeholders, the test name as title', () => {
  const code = "import { fill } from '../support/vars';\ntest('t', async ({ page }) => { await page.goto(fill('{{baseUrl}}/login')); await page.goto('http://b.test/'); });";
  assert.deepEqual([sourceFromCode(code, 'my-test').url, sourceFromCode(code, 'my-test').title, sourceFromCode(code, 'my-test').task], ['{{baseUrl}}/login', 'my-test', '']);
  assert.equal(sourceFromCode("test('t', async ({ page }) => { await page.goto(BASE + '/x'); });", 'n').url, ''); // not a plain string
});

test('deleting the test deletes its source; a project export carries it', () => {
  saveTest(P, 'gone', "test('t', async () => {});\n");
  saveSource(P, 'gone', { task: 'x' });
  saveTest(P, 'kept', "test('t', async () => {});\n");
  saveSource(P, 'kept', { task: 'y' });
  assert.ok(Object.keys(packProject(dir(), P, []).files).includes('sources/kept.json'));
  deleteTest(P, 'gone');
  assert.equal(existsSync(join(dir(), 'sources', 'gone.json')), false);
});
