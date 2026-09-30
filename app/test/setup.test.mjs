import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeOk, hasLibx264, checkRequirements } from '../setup.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('nodeOk: 22.13.0 is the floor', () => {
  assert.equal(nodeOk('v22.12.0'), false);
  assert.equal(nodeOk('v22.13.0'), true);
  assert.equal(nodeOk('v24.3.0'), true);
  assert.equal(nodeOk('v20.19.1'), false);
});

test('hasLibx264: reads ffmpeg -encoders output', () => {
  assert.equal(hasLibx264(' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)\n V....D mjpeg'), true);
  assert.equal(hasLibx264(' V....D mpeg4                MPEG-4 part 2\n'), false);
});

const fakeRun = found => cmd => (found[cmd] ? { status: 0, stdout: found[cmd] } : { status: 1, stdout: '' });
const byId = items => Object.fromEntries(items.map(i => [i.id, i]));

test('requirements: each missing thing says how to install it on this OS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abr-setup-')); // no node_modules
  try {
    const win = byId(await checkRequirements({ root, platform: 'win32', nodeVersion: 'v20.1.0', run: fakeRun({}) }));
    assert.equal(win.node.status, 'bad');
    assert.equal(win.node.fix[0].cmd, 'winget install OpenJS.NodeJS.LTS');
    assert.equal(win.chromium.status, 'bad'); // the app's files are incomplete
    assert.equal(win.ffmpeg.status, 'warn');
    assert.equal(win.ffmpeg.fix[0].cmd, 'winget install Gyan.FFmpeg');
    assert.match(win.claude.fix[0].cmd, /install\.ps1/);

    const mac = byId(await checkRequirements({ root, platform: 'darwin', run: fakeRun({ claude: '2.1.0 (Claude Code)' }) }));
    assert.equal(mac.ffmpeg.fix[0].cmd, 'brew install ffmpeg');
    assert.equal(mac.claude.status, 'ok');

    const linux = byId(await checkRequirements({ root, platform: 'linux', run: fakeRun({ [process.env.FFMPEG ?? 'ffmpeg']: ' V....D mpeg4  MPEG-4 part 2\n' }) }));
    assert.match(linux.ffmpeg.detail, /without libx264/);
    assert.deepEqual(linux.ffmpeg.fix.map(f => f.cmd), ['sudo apt install ffmpeg', 'sudo dnf install ffmpeg', 'sudo pacman -S ffmpeg']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('requirements: an unknown OS gets the Linux instructions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abr-setup-'));
  try { assert.equal(byId(await checkRequirements({ root, platform: 'freebsd', run: fakeRun({}) })).ffmpeg.fix[0].cmd, 'sudo apt install ffmpeg'); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
