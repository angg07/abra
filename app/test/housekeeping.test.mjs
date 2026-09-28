import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneDir } from '../housekeeping.mjs';

test('keeps the newest files of one kind, leaves other files alone', () => {
  const d = mkdtempSync(join(tmpdir(), 'prune-'));
  for (let i = 0; i < 5; i++) {
    const f = join(d, `v${i}.mp4`);
    writeFileSync(f, 'x');
    utimesSync(f, new Date(), new Date(Date.now() - i * 60_000)); // v0 newest
  }
  writeFileSync(join(d, 'guide.pdf'), 'x');
  assert.deepEqual(pruneDir(d, 2, '.mp4').sort(), ['v2.mp4', 'v3.mp4', 'v4.mp4']);
  assert.deepEqual(readdirSync(d).sort(), ['guide.pdf', 'v0.mp4', 'v1.mp4']);
  assert.deepEqual(pruneDir(join(d, 'missing'), 2, '.mp4'), []);
  rmSync(d, { recursive: true });
});
