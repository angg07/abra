// Settings over HTTP with a throwaway HOME: which Claude account a provider uses, and a bad config folder refused
// before anything is written.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp } from './helpers/app-server.mjs';

let app;
const home = mkdtempSync(join(tmpdir(), 'abr-home-'));
writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com', organizationName: 'Me' } }));
before(async () => { app = await startApp({ port: 4394, env: { HOME: home } }); });
after(() => app.stop());

test('Settings shows the Claude account a claude-code provider will use', async () => {
  const s = await (await app.req('/settings')).json();
  const cc = s.providers.find(p => p.engine === 'claude-code');
  assert.deepEqual(cc.account, { email: 'me@example.com', org: 'Me' });
});

test('a config folder that does not exist is refused, and providers.json stays as it was', async () => {
  const before = readFileSync(join(app.root, 'app', 'providers.json'), 'utf8');
  const s = await (await app.req('/settings')).json();
  const providers = s.providers.map(p => (p.engine === 'claude-code' ? { ...p, configDir: '~/no-such-folder' } : p));
  const r = await app.req('/settings', { method: 'POST', body: JSON.stringify({ ...s, providers }) });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /does not exist/);
  assert.equal(readFileSync(join(app.root, 'app', 'providers.json'), 'utf8'), before);
});
