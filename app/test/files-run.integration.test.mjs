// Save as test copies a Run AI's uploads into the test; an expired upload is reported, the test is still saved.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-files-run';
let app;
after(() => { if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });

test('Save as test copies the run files; a missing one is listed', async () => {
  app = await startApp({ port: 4409 });
  mkdirSync(join(app.root, 'tests', P), { recursive: true });
  writeFileSync(join(app.root, 'tests', P, 'project.json'), JSON.stringify({ name: P }));
  const up = await (await app.req('/uploads?name=a.xlsx', { method: 'POST', body: Buffer.from('A'), headers: { 'content-type': 'application/octet-stream' } })).json();
  // a finished AI run that used the upload, written the way history.mjs stores runs
  const run = { id: 'zz-run-files', kind: 'ai', project: P, started: Date.now(), status: 'pass', files: [up, { id: 'ffffffffffffffff', name: 'gone.pdf' }],
    script: "import { test } from '@playwright/test';\ntest('t', async ({ page }) => { await page.locator('#f').setInputFiles('{{file.a.xlsx}}'); });\n" };
  const db = new DatabaseSync(app.dbFile);
  db.prepare('INSERT INTO runs (id, project, started, user_id, video, guide, data) VALUES (?, ?, ?, NULL, NULL, NULL, ?)').run(run.id, P, run.started, JSON.stringify(run));
  db.close();
  const res = await (await app.req(`/tests?project=${P}`, { method: 'POST', body: JSON.stringify({ name: 'from-run', runId: run.id }) })).json();
  assert.deepEqual(res, { name: 'from-run', missingFiles: ['gone.pdf'] });
  assert.equal(readFileSync(join(app.root, 'tests', P, 'files', 'from-run', 'a.xlsx'), 'utf8'), 'A');
  assert.match(readFileSync(join(app.root, 'tests', P, 'from-run.spec.ts'), 'utf8'), /setInputFiles\(fill\('\{\{file\.a\.xlsx\}\}'\)\)/);
});
