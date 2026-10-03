// Saved prompts (prompts.mjs): Run AI forms kept to run later, with their files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testsDir } from '../library.mjs';
import { saveUpload } from '../test-files.mjs';
import { validPrompt, savePrompt, listPrompts, readPrompt, deletePrompt, usePromptFiles, promptExists } from '../prompts.mjs';

const P = 'zz-prompts-unit';
const uploads = mkdtempSync(join(tmpdir(), 'abr-uploads-'));
mkdirSync(join(testsDir, P), { recursive: true });
writeFileSync(join(testsDir, P, 'project.json'), '{"name":"zz"}');
after(() => { rmSync(join(testsDir, P), { recursive: true, force: true }); rmSync(uploads, { recursive: true, force: true }); });
const base = { url: 'http://jets.test/', task: 'Log in and create a policy', title: 'B1 Polis Marine Hull' };

test('a prompt is saved, listed, read, updated and deleted', () => {
  const id = savePrompt(P, undefined, base, uploads);
  assert.equal(id, 'b1-polis-marine-hull');
  assert.deepEqual(listPrompts(P).map(p => p.id), [id]);
  assert.equal(readPrompt(P, id).task, base.task);
  assert.equal(savePrompt(P, id, { ...base, task: 'Changed' }, uploads), id);
  assert.equal(readPrompt(P, id).task, 'Changed');
  assert.equal(listPrompts(P).length, 1);
  deletePrompt(P, id);
  assert.deepEqual(listPrompts(P), []);
  assert.throws(() => readPrompt(P, id), e => e.status === 404 && /Prompt not found/.test(e.message));
});

test('the same title twice gives two prompts; no title names it after the instructions', () => {
  const a = savePrompt(P, undefined, base, uploads), b = savePrompt(P, undefined, base, uploads);
  assert.equal(b, `${a}-2`);
  assert.equal(savePrompt(P, undefined, { task: 'Open Claims and check the list' }, uploads), 'open-claims-and-check-the-list');
  for (const id of [a, b, 'open-claims-and-check-the-list']) deletePrompt(P, id);
});

test('files: uploads are kept with the prompt, a file not named again is removed, use gives fresh uploads', () => {
  const up = saveUpload(uploads, 'Slip Polis.pdf', Buffer.from('%PDF-1'));
  const up2 = saveUpload(uploads, 'data.xlsx', Buffer.from('xlsx'));
  const id = savePrompt(P, undefined, { ...base, files: [up, up2] }, uploads);
  const dir = join(testsDir, P, 'prompt-files', id);
  assert.deepEqual(readPrompt(P, id).files, ['Slip-Polis.pdf', 'data.xlsx']);
  savePrompt(P, id, { ...base, files: [{ name: 'Slip-Polis.pdf' }] }, uploads);
  assert.deepEqual(readPrompt(P, id).files, ['Slip-Polis.pdf']);
  assert.equal(existsSync(join(dir, 'data.xlsx')), false);
  const used = usePromptFiles(P, id, uploads);
  assert.deepEqual(used.map(f => [f.name, f.size]), [['Slip-Polis.pdf', 6]]);
  assert.equal(readFileSync(join(uploads, used[0].id, used[0].name), 'utf8'), '%PDF-1');
  deletePrompt(P, id);
  assert.equal(existsSync(dir), false);
});

test('bad input is refused before anything is written; unknown fields are dropped', () => {
  assert.throws(() => validPrompt({ task: '  ' }), /The instructions are required/);
  assert.throws(() => validPrompt({ task: 'x'.repeat(10_001) }), /at most 10000/);
  assert.throws(() => validPrompt({ task: 'ok', title: 42 }), /title must be text/);
  assert.throws(() => validPrompt({ task: 'ok', url: 'ftp://x' }), /must start with http/);
  assert.equal('evil' in validPrompt({ task: 'ok', evil: 1 }), false);
  assert.equal(validPrompt({ task: 'ok', record: 'yes' }).record, false);
  assert.throws(() => readPrompt(P, '../x'), e => e.status === 404);
  assert.throws(() => savePrompt(P, 'no-such', base, uploads), e => e.status === 404);
  assert.throws(() => savePrompt(P, undefined, { ...base, files: [{ id: '0123456789abcdef', name: 'x.pdf' }] }, uploads), /Uploaded file "x.pdf" not found: add it again/);
  assert.throws(() => savePrompt(P, undefined, { ...base, files: Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.pdf` })) }, uploads), /At most 20 files/);
  assert.deepEqual(listPrompts(P), []); // nothing was written
  assert.equal(promptExists(P, '../x'), false);
  assert.equal(promptExists(P, ''), false);
});

test('a hand-made or imported prompt file cannot reach files outside its folder, fake its id, or hide the others', () => {
  mkdirSync(join(testsDir, P, 'prompts'), { recursive: true });
  mkdirSync(join(testsDir, P, 'prompt-files', 'evil'), { recursive: true });
  writeFileSync(join(testsDir, P, 'prompt-files', 'evil', 'ok.pdf'), '%PDF');
  writeFileSync(join(testsDir, P, 'prompts', 'evil.json'), JSON.stringify({ id: 'spoof', task: 42, files: ['../../../../package.json', 'ok.pdf', 7] }));
  writeFileSync(join(testsDir, P, 'prompts', 'broken.json'), '{ not json');
  try {
    assert.deepEqual(listPrompts(P).map(p => p.id), ['evil']); // the broken one is skipped, the others still list
    const evil = readPrompt(P, 'evil');
    assert.equal(evil.id, 'evil');
    assert.equal(evil.task, '');
    assert.deepEqual(evil.files, ['ok.pdf']);
    assert.deepEqual(usePromptFiles(P, 'evil', uploads).map(f => f.name), ['ok.pdf']);
    assert.throws(() => readPrompt(P, 'broken'), /cannot be read/);
  } finally {
    rmSync(join(testsDir, P, 'prompts'), { recursive: true, force: true });
    rmSync(join(testsDir, P, 'prompt-files'), { recursive: true, force: true });
  }
});
