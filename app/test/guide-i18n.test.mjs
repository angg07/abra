import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateStep, guideLabels } from '../guide-i18n.mjs';

test('step sentences in Indonesian', () => {
  const cases = {
    'Open the page': 'Buka halaman',
    'Click the “Login” button': 'Klik tombol “Login”',
    'Click the highlighted icon': 'Klik ikon yang ditandai',
    'Click “Claim MV”': 'Klik “Claim MV”',
    'Fill in the “Username” field': 'Isi kolom “Username”',
    'Fill in the form': 'Isi formulir',
    'Check that “Products” is visible': 'Pastikan “Products” terlihat',
    'Check that the “Cart” link has the expected text': 'Pastikan tautan “Cart” berisi teks yang benar',
    'Check that the page address is correct': 'Pastikan alamat halaman sudah benar',
    'Choose an option in the “Section *” combobox': 'Pilih opsi di pilihan “Section *”',
    'Check the “Complete” radio': 'Centang opsi “Complete”',
    'Wait until “Saved” appears': 'Tunggu sampai “Saved” muncul',
    'Press Enter': 'Tekan tombol Enter',
    'Click the element [data-test="cart"]': 'Klik elemen [data-test="cart"]',
  };
  for (const [en, id] of Object.entries(cases)) assert.equal(translateStep(en, 'id'), id, en);
});

test('English stays as is; unknown sentences are not guessed', () => {
  assert.equal(translateStep('Click the “Login” button', 'en'), 'Click the “Login” button');
  assert.equal(translateStep('Something new happened', 'id'), 'Something new happened');
  assert.equal(guideLabels('id').status.pass, 'Berhasil');
  assert.equal(guideLabels('xx').kicker, 'Step-by-step guide'); // unknown language falls back to English
});

test('tap and read steps are translated too', () => {
  assert.equal(translateStep('Tap the “Menu” button', 'id'), 'Ketuk tombol “Menu”');
  assert.equal(translateStep('Read total, status', 'id'), 'Baca total, status');
});
