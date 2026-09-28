import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConfigDir, claudeAccount } from '../claude-config.mjs';

const home = mkdtempSync(join(tmpdir(), 'abr-home-'));
mkdirSync(join(home, '.claude-2'));
writeFileSync(join(home, '.claude-2', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com', organizationName: 'Example Co' } }));
writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }));
mkdirSync(join(home, 'empty-config'));

test('resolveConfigDir: empty means the default; ~ is expanded; the folder must exist', () => {
  assert.equal(resolveConfigDir('', home), '');
  assert.equal(resolveConfigDir('  ', home), '');
  assert.equal(resolveConfigDir('~/.claude-2', home), join(home, '.claude-2'));
  assert.equal(resolveConfigDir(join(home, '.claude-2'), home), join(home, '.claude-2'));
  assert.throws(() => resolveConfigDir('.claude-2', home), /full path/);
  assert.throws(() => resolveConfigDir('~/nope', home), /does not exist/);
  assert.throws(() => resolveConfigDir(join(home, '.claude.json'), home), /not a folder/);
});

test('claudeAccount: who is signed in, from .claude.json of that folder (or ~/.claude.json by default)', () => {
  assert.deepEqual(claudeAccount(join(home, '.claude-2'), home), { email: 'work@example.com', org: 'Example Co' });
  assert.deepEqual(claudeAccount('', home), { email: 'me@example.com', org: '' });
  assert.equal(claudeAccount(join(home, 'empty-config'), home), null); // not signed in there yet
});
