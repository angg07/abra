// An AI run gets past its start: the History entry is written before anything else can fail
// (a later `const prompt` once shadowed the saved-prompt id and every Run AI failed at once)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-ai-start';
let app;
after(() => { if (app) rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); app?.stop(); });

test('Run AI from a saved prompt starts; stopping it right away ends it cleanly', async t => {
  app = await startApp({ port: 4431 });
  const dir = join(app.root, 'tests', P);
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: P }));
  const provider = (await (await app.req('/settings')).json()).providers.find(p => p.ready);
  if (!provider) return t.skip('no AI provider is ready on this computer');
  const { id: prompt } = await (await app.req(`/prompts?project=${P}`, { method: 'POST', body: JSON.stringify({ title: 'P', url: 'http://127.0.0.1:9/', task: 'Open the page' }) })).json();
  const up = await (await app.req('/uploads?name=plan.md', { method: 'POST', body: '# Plan\nOpen it', headers: { 'content-type': 'application/octet-stream' } })).json();
  const q = new URLSearchParams({ project: P, url: 'http://127.0.0.1:9/', task: 'Open the page', provider: provider.id, prompt, instr: JSON.stringify(up) });
  const res = await app.req(`/run?${q}`);
  let buf = '', events = [];
  for await (const c of res.body) {
    buf += Buffer.from(c);
    for (const m of buf.matchAll(/event: (\w+)\ndata: (.*)\n/g)) events.push([m[1], m[2]]);
    buf = buf.replace(/[\s\S]*event: \w+\ndata: .*\n/, '');
    const run = events.find(e => e[0] === 'run');
    if (run && !events.stopped) { events.stopped = true; await app.req(`/stop?run=${JSON.parse(run[1]).id}`, { method: 'POST' }); }
    if (events.some(e => e[0] === 'saved')) break;
  }
  assert.doesNotMatch(JSON.stringify(events), /before initialization/);
  const saved = JSON.parse(events.find(e => e[0] === 'saved')[1]);
  const entry = await (await app.req(`/history/${saved.id}`)).json();
  assert.equal(entry.prompt, prompt); // the saved prompt's id is kept on the run
  assert.deepEqual(entry.instructions, { name: 'plan.md', text: '# Plan\nOpen it' }); // attached instructions too (Run again, Edit in Run AI)
});
