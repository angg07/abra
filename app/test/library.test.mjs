import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareScript, withPlaceholders, listFolders } from '../library.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const src = `import { test, expect } from '@playwright/test';

test('t', async ({ page }) => {
  await page.goto('http://myapp.test/claims');
  await page.getByLabel('Password').fill('{{APP_PASS}}');
  await page.getByLabel('Submit').fill('{{today}}');
  await page.getByLabel('Name').fill('Budi');
});`;

const urlVars = [{ name: 'appUrl', url: 'http://myapp.test/' }, { name: 'adminUrl', url: 'http://admin-app.test' }];

test('saving wraps {{...}} strings in fill() and templates known addresses', () => {
  const out = prepareScript(src, { urlVars });
  assert.match(out, /import \{ fill \} from '\.\.\/support\/vars';/); // tests live in tests/<project>/
  assert.match(out, /goto\(fill\('\{\{appUrl\}\}\/claims'\)\)/);
  assert.match(out, /\.fill\(fill\('\{\{APP_PASS\}\}'\)\)/);
  assert.match(out, /\.fill\(fill\('\{\{today\}\}'\)\)/);
  assert.match(out, /\.fill\('Budi'\)/); // plain values untouched
});

test('saving twice changes nothing', () => {
  const once = prepareScript(src, { urlVars });
  assert.equal(prepareScript(once, { urlVars }), once);
});

test('the AI sees plain placeholders, including legacy process.env secrets', () => {
  const shown = withPlaceholders(prepareScript(src) + "\nawait x.fill(process.env.SECRET_ADMIN_PASS!);");
  assert.match(shown, /\.fill\('\{\{today\}\}'\)/);
  assert.match(shown, /\.fill\('\{\{ADMIN_PASS\}\}'\)/);
  assert.doesNotMatch(shown, /fill\(fill/);
});

test('an address that only starts like a known one is left alone', () => {
  const out = prepareScript("await page.goto('http://myapp.test.evil.com/x');", { urlVars });
  assert.doesNotMatch(out, /appUrl/);
});

test('a script without the Playwright import gets one', () => {
  assert.match(prepareScript("test('x', async () => {});"), /^import \{ test, expect \} from '@playwright\/test';/);
});

test('folder picker: subfolders only (hidden ones last) with full paths; home by default; a file is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abr-folders-'));
  try {
    for (const d of ['web', '.git', 'api']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'README.md'), 'x');
    const r = listFolders(dir);
    assert.deepEqual(r.dirs.map(d => d.name), ['api', 'web', '.git']);
    assert.equal(r.dirs[0].path, join(dir, 'api'));
    assert.equal(r.parent, tmpdir());
    assert.equal(listFolders('').path, homedir());
    assert.throws(() => listFolders(join(dir, 'README.md')), /Not a folder/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a multi-file setInputFiles list fills each {{file.X}} and adds the fill import', () => {
  const out = prepareScript("test('x', async ({ page }) => { await page.locator('input').setInputFiles(['{{file.A.pdf}}', '{{file.B.xlsx}}']); });");
  assert.match(out, /setInputFiles\(\[fill\('\{\{file\.A\.pdf\}\}'\), fill\('\{\{file\.B\.xlsx\}\}'\)\]\)/);
  assert.match(out, /import \{[^}]*\bfill\b[^}]*\} from/);
});
