// "Report a problem": the issue link carries version, OS and log, never a secret or the home folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueUrl, reportUrl, cleaner, ISSUES } from '../issue.mjs';

const env = { SECRET_ADMIN_PASS: 'hunter2-xyz', DBPASS_SHOP_E2E: 'pg-pass-123', OPENAI_API_KEY: 'sk-abcdef', SECRET_SHORT: 'ab', PATH: '/usr/bin' };
const clean = cleaner(env, '/home/someone');
const bodyOf = url => new URL(url).searchParams.get('body');

test('secret values and the home folder are taken out of the log', () => {
  const log = 'login with hunter2-xyz\ndb pg-pass-123 at /home/someone/abra\nkey sk-abcdef\nPATH /usr/bin ab';
  const body = bodyOf(issueUrl({ version: '1.1.2', os: 'Linux 6.0 x64', mode: 'desktop app', log }, clean));
  for (const secret of ['hunter2-xyz', 'pg-pass-123', 'sk-abcdef', '/home/someone']) assert.ok(!body.includes(secret), secret);
  assert.match(body, /db \*\*\* at ~\/abra/);
  assert.match(body, /PATH \/usr\/bin ab/); // not a secret, and too short to mask
  assert.match(body, /ABRA 1\.1\.2 · Linux 6\.0 x64 · desktop app/);
});

test('a long log keeps its newest lines and the link stays short enough for GitHub', () => {
  const log = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(250)}`).join('\n');
  const url = issueUrl({ version: '1', os: 'x', mode: 'y', log }, clean);
  assert.ok(url.startsWith(`${ISSUES}?`));
  assert.ok(url.length <= 7500, String(url.length));
  assert.match(bodyOf(url), /line 499 /);
  assert.ok(!bodyOf(url).includes('line 459 '));
});

test('reportUrl: the title, the sections, secrets removed, short enough for GitHub', () => {
  const clean = cleaner({ SECRET_ADMIN_PASS: 'hunter22' }, '/home/me');
  const url = reportUrl({ title: 'Video missing', text: 'I typed hunter22 and it broke', run: { id: 'r1', title: 'Login', status: 'fail', when: 'Today, 09:42' }, env: 'staging', project: 'Shop',
    version: '1.7.0', os: 'Linux', mode: 'desktop', log: Array.from({ length: 5000 }, (_, i) => `line ${i} /home/me/x hunter22`).join('\n'), files: ['run-r1.mp4'] }, clean);
  const q = new URL(url).searchParams;
  assert.equal(q.get('title'), 'Video missing');
  assert.match(q.get('body'), /## What happened[\s\S]*## Run[\s\S]*Login \(r1\)[\s\S]*## Environment[\s\S]*## App log[\s\S]*## Attachments[\s\S]*run-r1\.mp4/);
  assert.doesNotMatch(url, /hunter22/);
  assert.doesNotMatch(q.get('body'), /\/home\/me/);
  assert.ok(url.length <= 7500);
});
test('cleaner can mark removed secrets for the preview', () => {
  assert.equal(cleaner({ API_TOKEN: 'abcdef' }, '/h', '[secret removed]')('x abcdef y'), 'x [secret removed] y');
});
test('reportUrl: a long description is cut so the link still works', () => {
  const url = reportUrl({ title: 'T', text: 'é'.repeat(9000), version: '1', os: 'L', mode: 'm', log: '' }, cleaner({}, '/h'));
  assert.ok(url.length <= 7500, String(url.length));
  assert.match(new URL(url).searchParams.get('body'), /truncated, the full text is in report\.txt/);
});
