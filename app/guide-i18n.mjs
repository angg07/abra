// Language of the PDF guide. Steps are built in English (guide.mjs); for another language the finished
// sentences are translated by pattern, so no AI is needed and the same step always reads the same way.

const KIND_ID = {
  button: 'tombol', link: 'tautan', icon: 'ikon', 'menu item': 'menu', tab: 'tab', option: 'opsi',
  checkbox: 'kotak centang', dropdown: 'dropdown', field: 'kolom', textbox: 'kolom', combobox: 'pilihan',
  heading: 'judul', image: 'gambar', element: 'elemen', item: 'item', radio: 'opsi', searchbox: 'kolom pencarian',
};
const MATCHER_ID = {
  'is visible': 'terlihat', 'is hidden': 'tidak terlihat', 'has the expected text': 'berisi teks yang benar',
  'contains the expected text': 'memuat teks yang benar', 'has the expected value': 'berisi nilai yang benar',
  'is enabled': 'aktif', 'is disabled': 'nonaktif', 'is checked': 'tercentang', 'has the expected count': 'jumlahnya sesuai',
};

// "the “Login” button" -> "tombol “Login”"
function targetId(t) {
  let m;
  if ((m = t.match(/^the “(.+)” (.+)$/)) && KIND_ID[m[2]]) return `${KIND_ID[m[2]]} “${m[1]}”`;
  if ((m = t.match(/^the highlighted (.+)$/))) return `${KIND_ID[m[1]] ?? m[1]} yang ditandai`;
  if ((m = t.match(/^the element (.+)$/))) return `elemen ${m[1]}`;
  if ((m = t.match(/^the (.+)$/)) && KIND_ID[m[1]]) return KIND_ID[m[1]];
  return t; // “Products”, quoted text: keep
}

const RULES = [
  [/^Open the page$/, () => 'Buka halaman'],
  [/^Go back to the previous page$/, () => 'Kembali ke halaman sebelumnya'],
  [/^Fill in the form$/, () => 'Isi formulir'],
  [/^Confirm the dialog$/, () => 'Setujui dialog'],
  [/^Dismiss the dialog$/, () => 'Tutup dialog'],
  [/^Wait a moment$/, () => 'Tunggu sebentar'],
  [/^Wait until “(.+)” appears$/, m => `Tunggu sampai “${m[1]}” muncul`],
  [/^Wait until “(.+)” disappears$/, m => `Tunggu sampai “${m[1]}” hilang`],
  [/^Upload the file$/, () => 'Unggah file'],
  [/^Upload a file to (.+)$/, m => `Unggah file ke ${targetId(m[1])}`],
  [/^Check that the page address is correct$/, () => 'Pastikan alamat halaman sudah benar'],
  [/^Check that the page title is correct$/, () => 'Pastikan judul halaman sudah benar'],
  [/^Check that (.+?) (is visible|is hidden|has the expected text|contains the expected text|has the expected value|is enabled|is disabled|is checked|has the expected count)$/,
    m => `Pastikan ${targetId(m[1])} ${MATCHER_ID[m[2]]}`],
  [/^Check that (.+)$/, m => `Pastikan ${targetId(m[1])}`],
  [/^Choose an option in (.+)$/, m => `Pilih opsi di ${targetId(m[1])}`],
  [/^Fill in (.+)$/, m => `Isi ${targetId(m[1])}`],
  [/^Type into (.+)$/, m => `Ketik di ${targetId(m[1])}`],
  [/^Double click (.+)$/, m => `Klik dua kali ${targetId(m[1])}`],
  [/^Click (.+)$/, m => `Klik ${targetId(m[1])}`],
  [/^Hover over (.+)$/, m => `Arahkan kursor ke ${targetId(m[1])}`],
  [/^Uncheck (.+)$/, m => `Hapus centang ${targetId(m[1])}`],
  [/^Check (.+)$/, m => `Centang ${targetId(m[1])}`],
  [/^Drag (.+) to (.+)$/, m => `Seret ${targetId(m[1])} ke ${targetId(m[2])}`],
  [/^Press (.+)$/, m => `Tekan tombol ${m[1]}`],
  [/^Tap (.+)$/, m => `Ketuk ${targetId(m[1])}`],
  [/^Read (.+)$/, m => `Baca ${m[1]}`],
];

export function translateStep(text, lang) {
  if (lang !== 'id') return text;
  for (const [re, fn] of RULES) { const m = text.match(re); if (m) return fn(m); }
  return text; // unknown sentence: better in English than wrong
}

// Fixed wording on the PDF
const LABELS = {
  en: {
    kicker: 'Step-by-step guide', website: 'Website', date: 'Date', result: 'Result', steps: 'Steps', expected: 'Expected',
    resultTitle: 'Result', errorsTitle: 'Errors during the run', errorsIntro: 'The application reported these while the steps ran:',
    noSteps: 'No steps were recorded.', page: 'Page', of: 'of', met: 'met', notMet: 'NOT met', unconfirmed: 'not confirmed',
    status: { pass: 'Passed', fail: 'Failed', stopped: 'Stopped', error: 'Error' }, locale: 'en-US', testRun: 'Test run',
    suite: 'Test suite', alert: 'Attention!',
  },
  id: {
    kicker: 'Panduan langkah demi langkah', website: 'Situs', date: 'Tanggal', result: 'Hasil', steps: 'Langkah', expected: 'Harapan',
    resultTitle: 'Hasil', errorsTitle: 'Error selama proses', errorsIntro: 'Aplikasi melaporkan hal berikut selama langkah-langkah berjalan:',
    noSteps: 'Tidak ada langkah yang terekam.', page: 'Halaman', of: 'dari', met: 'terpenuhi', notMet: 'TIDAK terpenuhi', unconfirmed: 'belum dipastikan',
    status: { pass: 'Berhasil', fail: 'Gagal', stopped: 'Dihentikan', error: 'Error' }, locale: 'id-ID', testRun: 'Pengujian',
    suite: 'Rangkaian pengujian', alert: 'Perhatian!',
  },
};
export const guideLabels = lang => LABELS[lang] ?? LABELS.en;
export const GUIDE_LANGS = Object.keys(LABELS);
