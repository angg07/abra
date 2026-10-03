import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteGuide, guideDoc } from '../guide.mjs';

const input = { title: 'Buat klaim', steps: ['Buka halaman', 'Klik “Simpan”'], lang: 'id', instructions: 'Pakai kata Pengajuan, sapa dengan Anda' };

test('the AI rewrites the title, description and every step, following the project instructions', async () => {
  let seen;
  const ask = async (prompt, system) => {
    seen = { prompt, system };
    return 'Here you go:\n```json\n{"title":"Membuat pengajuan","description":"Panduan untuk Anda","steps":["Buka halaman pengajuan","Klik tombol “Simpan”"]}\n```';
  };
  const out = await rewriteGuide(input, ask);
  assert.deepEqual(out, { title: 'Membuat pengajuan', description: 'Panduan untuk Anda', steps: ['Buka halaman pengajuan', 'Klik tombol “Simpan”'] });
  assert.match(seen.prompt, /Pakai kata Pengajuan/);
  assert.match(seen.prompt, /1\. Buka halaman/);
  assert.match(seen.prompt, /2\. Klik “Simpan”/);
  assert.match(seen.system, /JSON/);
});

test('an answer that is not JSON is refused', async () => {
  await assert.rejects(rewriteGuide(input, async () => 'Sorry, I cannot help'), /JSON/);
});

test('an answer with a different number of steps is refused', async () => {
  await assert.rejects(rewriteGuide(input, async () => '{"title":"x","description":"","steps":["only one"]}'), /2 steps/);
});

test('empty or non-text steps are refused', async () => {
  await assert.rejects(rewriteGuide(input, async () => '{"title":"x","steps":["a",""]}'), /step 2/);
  await assert.rejects(rewriteGuide(input, async () => '{"title":"x","steps":["a",3]}'), /step 2/);
});

test('the guide document uses the rewritten texts', () => {
  const run = { kind: 'ai', title: 'Buat klaim', status: 'pass' };
  const steps = [{ section: 'Login', level: 1 }, { what: 'Click “Save”', text: 'Klik tombol “Simpan”' }, { what: 'Open the page' }];
  const doc = guideDoc(run, steps, 'id', { title: 'Membuat pengajuan', description: 'Panduan untuk Anda' });
  assert.equal(doc.title, 'Membuat pengajuan');
  assert.equal(doc.description, 'Panduan untuk Anda');
  assert.equal(doc.blocks[1].text, 'Klik tombol **“Simpan”**');
  assert.equal(doc.blocks[2].text, 'Buka halaman'); // no rewrite: the template text, translated
});
