// A replay announces how many tests it will run and times each step
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-steps';
let app;
after(() => { if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });
const spec = (name, ok) => `import { test, expect } from '@playwright/test';\ntest(${JSON.stringify(name)}, async ({ page }) => { await page.setContent('<h1>x</h1>'); await expect(page.locator('h1')).toHaveText(${JSON.stringify(ok ? 'x' : 'y')}, { timeout: 500 }); });\n`;

test('a replay plans its tests and times its steps', async () => {
  app = await startApp({ port: 4435 });
  const dir = join(app.root, 'tests', P);
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: P }));
  writeFileSync(join(dir, 'good.spec.ts'), spec('good', true) + spec('good2', true).replace(/^import.*\n/, '')); writeFileSync(join(dir, 'bad.spec.ts'), spec('bad', false)); // good: two test() in one file
  const r = await app.req(`/replay?${new URLSearchParams({ project: P, tests: 'good,bad', repeat: '3' })}`);
  let buf = '';
  for await (const c of r.body) { buf += Buffer.from(c); if (/event: saved\ndata: .*\n/.test(buf)) break; }
  const ev = [...buf.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map(m => [m[1], JSON.parse(m[2])]);
  assert.deepEqual(ev.find(e => e[0] === 'plan')?.[1], { tests: 9 }); // 3 tests × 3, counted by Playwright, not by file
  const steps = ev.filter(e => e[0] === 'step' && !e[1].section).map(e => e[1]);
  assert.ok(steps.length, 'some steps'); assert.ok(steps.every(s => typeof s.at === 'number' && s.at >= 0));
  const entry = await (await app.req(`/history/${ev.find(e => e[0] === 'saved')[1].id}`)).json();
  assert.ok(entry.replaySteps.filter(s => !s.section).every(s => typeof s.at === 'number'));
  // every test heading carries the result of that very run of it, in run order
  const heads = entry.replaySteps.filter(s => s.section && s.level === 1);
  assert.equal(heads.length, 9);
  assert.ok(heads.every(h => h.status === (h.section === 'bad' ? 'failed' : 'passed')), JSON.stringify(heads));
});
