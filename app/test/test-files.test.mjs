import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanFileName, saveTestFile, listTestFiles, deleteTestFile, filesIn, saveUpload, pickUploads, copyUploads, pruneUploads, MAX_FILE } from '../test-files.mjs';
import { testsDir, deleteTest } from '../library.mjs';

test('runs of dots collapse to one', () => { assert.equal(cleanFileName('report..v2.pdf'), 'report.v2.pdf'); });

test('file names keep letters, digits, dot, dash and underscore', () => {
  assert.equal(cleanFileName('Template Klaim (v2).xlsx'), 'Template-Klaim-v2.xlsx');
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('C:\\x\\y.pdf'), 'y.pdf');
  assert.equal(cleanFileName('.env'), 'env');
  assert.equal(cleanFileName('polis_2026.pdf'), 'polis_2026.pdf');
  const longWithExt = cleanFileName('a'.repeat(150) + '.pdf');
  assert.equal(longWithExt.length, 100);
  assert.equal(longWithExt.endsWith('.pdf'), true);
  const longNoExt = cleanFileName('b'.repeat(150));
  assert.equal(longNoExt.length, 100);
  assert.throws(() => cleanFileName('(((.)))'), /needs letters or digits/);
});

test('a test keeps its files; the same name again replaces the content', () => {
  const P = 'zz-files-unit';
  mkdirSync(join(testsDir, P), { recursive: true });
  writeFileSync(join(testsDir, P, 'project.json'), '{"name":"zz"}');
  writeFileSync(join(testsDir, P, 'claim.spec.ts'), "import { test } from '@playwright/test';\ntest('t', async () => {});\n");
  try {
    assert.equal(saveTestFile(P, 'claim', 'Template Klaim.xlsx', Buffer.from('one')), 'Template-Klaim.xlsx');
    saveTestFile(P, 'claim', 'Template Klaim.xlsx', Buffer.from('two!'));
    saveTestFile(P, 'claim', 'polis.pdf', Buffer.from('%PDF'));
    assert.deepEqual(listTestFiles(P, 'claim'), [{ name: 'Template-Klaim.xlsx', size: 4 }, { name: 'polis.pdf', size: 4 }]);
    assert.equal(filesIn(join(testsDir, P, 'files', 'claim'))['polis.pdf'], join(testsDir, P, 'files', 'claim', 'polis.pdf'));
    assert.throws(() => saveTestFile(P, 'claim', 'big.bin', Buffer.alloc(MAX_FILE + 1)), e => e.status === 413);
    deleteTestFile(P, 'claim', 'polis.pdf');
    assert.deepEqual(listTestFiles(P, 'claim').map(f => f.name), ['Template-Klaim.xlsx']);
    deleteTest(P, 'claim'); // the test's files go with it
    assert.equal(existsSync(join(testsDir, P, 'files', 'claim')), false);
  } finally { rmSync(join(testsDir, P), { recursive: true, force: true }); }
});

test('uploads for a Run AI: saved, picked, copied; old ones pruned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abr-up-'));
  const a = saveUpload(dir, 'Template Klaim.xlsx', Buffer.from('x'));
  assert.match(a.id, /^[0-9a-f]{16}$/);
  assert.equal(a.name, 'Template-Klaim.xlsx');
  assert.deepEqual(pickUploads(dir, JSON.stringify([a])), [a]);
  assert.deepEqual(pickUploads(dir, ''), []);
  assert.throws(() => pickUploads(dir, JSON.stringify([{ id: '../x', name: 'a' }])), /not found/);
  assert.throws(() => pickUploads(dir, JSON.stringify([{ id: a.id, name: 'other.xlsx' }])), /not found/);
  const dest = join(dir, 'dest');
  assert.deepEqual(copyUploads(dir, [a, { id: 'ffffffffffffffff', name: 'gone.pdf' }], dest), ['gone.pdf']);
  assert.equal(readFileSync(join(dest, 'Template-Klaim.xlsx'), 'utf8'), 'x');
  const old = new Date(Date.now() - 2 * 86_400_000);
  utimesSync(join(dir, a.id), old, old);
  pruneUploads(dir);
  assert.equal(existsSync(join(dir, a.id)), false);
  assert.equal(existsSync(dest), true); // only upload folders (16 hex) are pruned
});
