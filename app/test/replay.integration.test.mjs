// Runs the real Playwright test runner twice at once (headless Chromium): a few seconds
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runTests } from '../replay.mjs';

const root = join(import.meta.dirname, '..', 'data', 'test-parallel'); // under the repo so @playwright/test resolves
const spec = name => `import { test, expect } from '@playwright/test';
test('${name}', async ({ page }) => {
  await page.setContent('<h1>${name}</h1>');
  await page.waitForTimeout(1500);
  await expect(page.getByRole('heading', { name: '${name}' })).toBeVisible();
});`;

test('two replays at once keep their own port, output and report', async () => {
  rmSync(root, { recursive: true, force: true });
  const names = ['a', 'b'];
  const dirs = names.map(n => { const d = join(root, `tests-${n}`); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${n}.spec.ts`), spec(n)); return d; });
  const run = (d, i) => runTests([join(d, `${names[i]}.spec.ts`)], {
    width: 640, height: 400, testDir: d, cdpPort: 9490 + i, outputDir: join(root, `out-${i}`), slowMo: 0,
  }, { onLine: () => {}, onStep: () => {} }, new AbortController().signal);
  try {
    const [ra, rb] = await Promise.all(dirs.map(run));
    assert.equal(ra.ok, true); assert.equal(rb.ok, true);
    assert.deepEqual([ra.tests[0].title, rb.tests[0].title], ['a', 'b']);
    assert.equal(existsSync(join(root, 'out-0')), true);
    assert.equal(existsSync(join(root, 'out-1')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Stop ends the runner and the browser it started', async () => {
  const { portAnswers } = await import('../stage.mjs');
  const d = join(root, 'tests-stop');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'long.spec.ts'), `import { test } from '@playwright/test';
test('long', async ({ page }) => { await page.setContent('<h1>long</h1>'); await page.waitForTimeout(30000); });`);
  const stop = new AbortController();
  const port = 9492;
  const run = runTests([join(d, 'long.spec.ts')], { width: 640, height: 400, testDir: d, cdpPort: port, outputDir: join(root, 'out-stop'), slowMo: 0 },
    { onLine: () => {}, onStep: () => {} }, stop.signal);
  try {
    const up = Date.now() + 15000;
    while (!(await portAnswers(port))) { if (Date.now() > up) throw new Error('the runner browser never came up'); await new Promise(r => setTimeout(r, 200)); }
    const t0 = Date.now();
    stop.abort();
    await assert.rejects(run);
    assert.ok(Date.now() - t0 < 10000, 'stopped in time');
    await new Promise(r => setTimeout(r, 1000));
    assert.equal(await portAnswers(port), false); // its browser is gone too
  } finally { rmSync(root, { recursive: true, force: true }); }
});
