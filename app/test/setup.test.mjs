import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeOk, hasLibx264 } from '../setup.mjs';

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
