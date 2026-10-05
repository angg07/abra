// Pure parts of the stage: the ffmpeg command line, and when the screencast should run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ffmpegArgs, wantsScreencast } from '../stage.mjs';

test('ffmpeg records with 2 threads and a short lookahead, at the size and rate from Settings', () => {
  const a = ffmpegArgs('/tmp/x.mp4', { width: 1920, height: 1080, fps: 30 });
  const after = flag => a[a.indexOf(flag) + 1];
  assert.equal(after('-threads'), '2');
  assert.equal(after('-rc-lookahead'), '10');
  assert.equal(after('-framerate'), '30');
  assert.match(after('-vf'), /^scale=1920:1080:out_range=tv,format=yuv420p$/);
  assert.equal(after('-preset'), 'veryfast');
  assert.ok(a.indexOf('-threads') > a.indexOf('-preset'));
  assert.equal(a.at(-1), '/tmp/x.mp4');
});

test('the screencast runs while someone watches, or the run needs frames (video, PDF guide, workflow)', () => {
  assert.equal(wantsScreencast({ viewers: 0, needsFrames: false }), false);
  assert.equal(wantsScreencast({ viewers: 1, needsFrames: false }), true);
  assert.equal(wantsScreencast({ viewers: 0, needsFrames: true }), true);
  assert.equal(wantsScreencast({ viewers: 2, needsFrames: true }), true);
});
