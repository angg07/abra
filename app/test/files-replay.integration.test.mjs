// A saved test uploads its own file through {{file.X}}; without the file it fails with the message from the spec.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-files-replay';
let app;
after(() => { if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });

async function replay(name) {
  const r = await app.req(`/replay?${new URLSearchParams({ project: P, tests: name })}`);
  let buf = '';
  for await (const c of r.body) { buf += Buffer.from(c); const m = buf.match(/event: saved\ndata: (.*)/); if (m) return app.req(`/history/${JSON.parse(m[1]).id}`).then(x => x.json()); }
}

test('a saved test uploads its file with {{file.X}}; a missing file is named in the error', async () => {
  app = await startApp({ port: 4407 });
  const dir = join(app.root, 'tests', P);
  mkdirSync(join(dir, 'files', 'upload'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: P }));
  writeFileSync(join(dir, 'files', 'upload', 'template-klaim.xlsx'), 'xlsx bytes');
  const body = file => `import { test, expect } from '@playwright/test';
import { fill } from '../support/vars';
test('upload', async ({ page }) => {
  await page.setContent('<input type="file" id="f">');
  await page.locator('#f').setInputFiles(fill('{{file.${file}}}'));
  await expect(page.locator('#f')).toHaveValue(/template-klaim\\.xlsx$/);
});
`;
  writeFileSync(join(dir, 'upload.spec.ts'), body('template-klaim.xlsx'));
  writeFileSync(join(dir, 'missing.spec.ts'), body('nope.pdf'));

  const ok = await replay('upload');
  assert.equal(ok.status, 'pass', JSON.stringify(ok.tests));
  const bad = await replay('missing');
  assert.equal(bad.status, 'fail');
  assert.match(JSON.stringify(bad), /File \{\{file\.nope\.pdf\}\} not found: add it in Edit test › Files/);
});
