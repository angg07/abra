// Report a problem, server side: POST /report writes a folder of attachments and a filled-in issue link,
// secrets removed; a missing video is reported, not fatal; GET /report/preview gives the cleaned log
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './helpers/app-server.mjs';

const P = 'zz-report';
let app, video;
after(() => { if (app) { rmSync(join(app.root, 'tests', P), { recursive: true, force: true }); if (video) rmSync(video, { force: true }); } app?.stop(); });

test('POST /report writes the folder, cleans secrets, reports a missing video; bad input is refused', async () => {
  app = await startApp({ port: 4433, env: { SECRET_ZZ_PASS: 'hunter22' } });
  mkdirSync(join(app.root, 'tests', P), { recursive: true }); writeFileSync(join(app.root, 'tests', P, 'project.json'), JSON.stringify({ name: P }));
  video = join(app.root, 'app', 'recordings', 'zz-report-video.mp4');
  mkdirSync(join(app.root, 'app', 'recordings'), { recursive: true }); writeFileSync(video, 'MP4');
  const db = new DatabaseSync(app.dbFile);
  for (const [id, v] of [['zz-rep-gone', 'gone.mp4'], ['zz-rep-vid', 'zz-report-video.mp4']])
    db.prepare('INSERT INTO runs (id, project, started, data) VALUES (?, ?, ?, ?)').run(id, P, Date.now(), JSON.stringify({ id, project: P, started: Date.now(), status: 'fail', kind: 'ai', title: id, video: v }));
  db.close();
  const post = body => app.req('/report', { method: 'POST', body: JSON.stringify(body) });
  const a = await (await post({ title: 'T', text: 'I typed hunter22 and it broke badly', runId: 'zz-rep-gone', log: true, video: true })).json();
  assert.match(a.url, /^https:\/\/github\.com\/angg07\/abra\/issues\/new\?/);
  assert.doesNotMatch(decodeURIComponent(a.url), /hunter22/);
  assert.ok(existsSync(join(a.folder, 'app-log.txt')));
  assert.deepEqual(a.missing, ['gone.mp4']);
  const b = await (await post({ title: 'T', text: 'something broke badly here', runId: 'zz-rep-vid', log: false, video: true, screenshot: 'data:image/png;base64,iVBORw0KGgo=' })).json();
  assert.deepEqual(b.files, ['run-zz-rep-vid.mp4', 'screenshot.png']);
  assert.equal(readFileSync(join(b.folder, 'run-zz-rep-vid.mp4'), 'utf8'), 'MP4');
  assert.equal((await post({ title: '', text: 'something broke badly here' })).status, 400);
  assert.equal((await post({ title: 'T', text: 'short' })).status, 400);
  assert.equal((await post({ title: 'T', text: 'something broke badly here', screenshot: 'data:text/html;base64,PGI+' })).status, 400);
  rmSync(a.folder, { recursive: true, force: true }); rmSync(b.folder, { recursive: true, force: true });
});

test('GET /report/preview gives the version and the cleaned log lines', async () => {
  const r = await (await app.req('/report/preview')).json();
  assert.ok(r.version); assert.ok(Array.isArray(r.log));
  assert.doesNotMatch(JSON.stringify(r), /hunter22/);
});

test('a real-size screenshot is accepted; the full text goes to report.txt; the preview cleans typed secrets', async () => {
  const big = 'data:image/png;base64,' + Buffer.alloc(900_000, 7).toString('base64');
  const r = await app.req('/report', { method: 'POST', body: JSON.stringify({ title: 'Shot', text: 'a long enough description of it', screenshot: big }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.files.includes('screenshot.png'));
  assert.match(readFileSync(join(j.folder, 'report.txt'), 'utf8'), /a long enough description/);
  rmSync(j.folder, { recursive: true, force: true });
  const p = await (await app.req('/report/preview', { method: 'POST', body: JSON.stringify({ title: 'pw hunter22', text: 'I typed hunter22' }) })).json();
  assert.equal(p.title, 'pw [secret removed]'); assert.equal(p.text, 'I typed [secret removed]');
});
