import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAppBrowser, windowArgs } from '../window.mjs';

test('app window: an installed Chrome-family browser first, else the Chromium the app downloaded, else none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abr-win-'));
  try {
    const bundled = join(dir, 'pw-chrome'); writeFileSync(bundled, '');
    const bin = join(dir, 'bin'); mkdirSync(bin);
    assert.equal(findAppBrowser({ platform: 'linux', env: { PATH: bin }, bundled }), bundled);
    writeFileSync(join(bin, 'chromium'), ''); chmodSync(join(bin, 'chromium'), 0o755);
    assert.equal(findAppBrowser({ platform: 'linux', env: { PATH: bin }, bundled }), join(bin, 'chromium'));
    assert.equal(findAppBrowser({ platform: 'linux', env: { PATH: join(dir, 'none') }, bundled: join(dir, 'missing') }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('app window: app mode (no tabs or address bar) with its own profile', () => {
  const args = windowArgs('http://127.0.0.1:4321', '/data/window');
  assert.ok(args.includes('--app=http://127.0.0.1:4321'));
  assert.ok(args.includes('--user-data-dir=/data/window'));
});
