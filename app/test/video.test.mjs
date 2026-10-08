// Renders a real card and runs ffmpeg: a few seconds
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishVideo, titleCardHtml, captionHtml, segments, zoomRect, captionText, zoomStretches, videoTime } from '../video.mjs';

const seconds = f => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

test('the title card is 3 seconds in front of the recording, same size; captions are laid over the steps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abr-video-'));
  const video = join(dir, 'run.mp4');
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x200:r=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    const captions = [{ n: 1, at: 0.5, text: 'Click “Login”' }, { n: 2, at: 1.2, text: 'Fill in the “Email” field' }];
    const err = await finishVideo(video, { width: 320, height: 200, fps: 10, title: 'Login <works>', app: 'Web Shop', logo: '', accent: '#2B59C3', captions });
    assert.equal(err, null);
    assert.ok(Math.abs(seconds(video) - 5) < 0.3, `duration ${seconds(video)}`);
    assert.equal(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video]).toString().trim(), '320,200');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('idle stretches: 2 s after a step stay, the rest to the next step runs 4x; short gaps are left alone', () => {
  assert.deepEqual(segments([]), [{ start: 0, end: undefined, fast: false }]);
  assert.deepEqual(segments([{ at: 0 }, { at: 3 }, { at: 4 }]), [{ start: 0, end: undefined, fast: false }]);
  assert.deepEqual(segments([{ at: 1 }, { at: 11 }, { at: 12 }]), [
    { start: 0, end: 3, fast: false }, { start: 3, end: 11, fast: true }, { start: 11, end: undefined, fast: false },
  ]);
  assert.deepEqual(segments([{ at: 0 }, { at: 20 }]), [ // after the last step: as recorded (the end result)
    { start: 0, end: 2, fast: false }, { start: 2, end: 20, fast: true }, { start: 20, end: undefined, fast: false },
  ]);
});

test('a sped-up recording gets shorter by the idle time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abr-video-'));
  const video = join(dir, 'run.mp4');
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x200:r=10', '-t', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    const err = await finishVideo(video, { width: 320, height: 200, fps: 10, title: 't', captions: [{ n: 1, at: 0, text: 'a' }, { n: 2, at: 10, text: 'b' }] });
    assert.equal(err, null);
    // card 3 + [0,2] + [2,10]/4 + [10,20] = 3 + 2 + 2 + 10
    assert.ok(Math.abs(seconds(video) - 17) < 0.4, `duration ${seconds(video)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing recording leaves an error, not an exception', async () => {
  assert.match(await finishVideo('/nonexistent/run.mp4', { width: 320, height: 200, title: 'x' }), /./);
});

test('the card escapes text and drops empty parts', () => {
  const html = titleCardHtml({ title: 'A <b>', app: '', logo: '', accent: '#000' });
  assert.ok(html.includes('A &lt;b&gt;') && !html.includes('<img') && !html.includes('<p>'));
  assert.ok(captionHtml({ n: 3, text: 'Fill <x>', accent: '#000' }).includes('Fill &lt;x&gt;'));
});

test('zoom: a small form fills the frame (at most 2x, kept inside it); a full page or an odd viewport is left alone', () => {
  const z = zoomRect({ x: 440, y: 250, w: 400, h: 300, vw: 1280, vh: 800 }, 1280, 800);
  assert.deepEqual(z, { w: 640, h: 400, x: 320, y: 200 });
  assert.equal(zoomRect({ x: 0, y: 0, w: 1200, h: 700, vw: 1280, vh: 800 }, 1280, 800), null);
  assert.equal(zoomRect({ x: 0, y: 0, w: 100, h: 100, vw: 390, vh: 844 }, 1280, 800), null);
  assert.equal(zoomRect(undefined, 1280, 800), null);
  const edge = zoomRect({ x: 1100, y: 700, w: 150, h: 80, vw: 640, vh: 400 }, 1280, 800); // page at half size, near the corner
  assert.ok(edge.x + edge.w <= 1280 && edge.y + edge.h <= 800 && edge.w / edge.h === 1.6, JSON.stringify(edge));
});

test('caption text: no full stop, long sentences cut to 10 words', () => {
  assert.equal(captionText('Klik tombol “Simpan”.'), 'Klik tombol “Simpan”');
  assert.equal(captionText('Check that  the order list shows one new order with the right total and the date of today'),
    'Check that the order list shows one new order with…');
});

test('a zoomed step renders; the video keeps its length and size', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abr-video-'));
  const video = join(dir, 'run.mp4');
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x200:r=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    const zoom = { x: 100, y: 60, w: 100, h: 60, vw: 320, vh: 200 };
    const err = await finishVideo(video, { width: 320, height: 200, fps: 10, title: 't', captions: [{ n: 1, at: 0.5, text: 'a', zoom }, { n: 2, at: 2, text: 'b' }] });
    assert.equal(err, null);
    assert.ok(Math.abs(seconds(video) - 7) < 0.3, `duration ${seconds(video)}`);
    const size = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video]).toString().trim();
    assert.equal(size, '320,200');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a full-range recording (the screencast JPEGs) comes out limited range, so browsers keep light greys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abr-video-'));
  const video = join(dir, 'run.mp4');
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xF2F2F2:s=320x200:r=10', '-t', '2', '-vf', 'format=yuvj420p', '-c:v', 'libx264', '-pix_fmt', 'yuvj420p', video]);
    assert.equal(await finishVideo(video, { width: 320, height: 200, fps: 10, title: 't', captions: [] }), null);
    const range = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=color_range', '-of', 'csv=p=0', video]).toString().trim();
    assert.equal(range, 'tv');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('after a step that enters a value the picture holds 1.5 s, just after the value is in', () => {
  assert.deepEqual(segments([{ at: 1, hold: true }, { at: 3 }]), [
    { start: 0, end: 1.3, fast: false }, { start: 1.3, end: 1.3, fast: false, freeze: 1.5 }, { start: 1.3, end: undefined, fast: false },
  ]);
  // the next step comes sooner: the hold moves before it
  assert.equal(segments([{ at: 1, hold: true }, { at: 1.2 }])[1].start, 1.15);
  // inside an idle stretch that is sped up, the hold stays in the part that plays at normal speed
  const s = segments([{ at: 0, hold: true }, { at: 20 }]);
  assert.deepEqual(s.map(g => [g.start, g.end, g.fast, g.freeze ?? 0]), [[0, 0.3, false, 0], [0.3, 0.3, false, 1.5], [0.3, 2, false, 0], [2, 20, true, 0], [20, undefined, false, 0]]);
});

test('a held step makes the video longer by the hold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abr-video-'));
  const video = join(dir, 'run.mp4');
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x200:r=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    const err = await finishVideo(video, { width: 320, height: 200, fps: 10, title: 't', captions: [{ n: 1, at: 1, text: 'Isi kolom “Email”', hold: true }, { n: 2, at: 2.5, text: 'b', hold: true }] });
    assert.equal(err, null);
    assert.ok(Math.abs(seconds(video) - (3 + 4 + 1.5 * 2)) < 0.4, `duration ${seconds(video)}`); // card + recording + 2 holds
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('zoom: fields filled one after another in the same form stay zoomed (one stretch); another form is its own', () => {
  const form = { x: 440, y: 250, w: 400, h: 300, vw: 1280, vh: 800 }, other = { x: 40, y: 40, w: 300, h: 200, vw: 1280, vh: 800 };
  const s = zoomStretches([{ at: 1, zoom: form }, { at: 2, zoom: form }, { at: 3, zoom: form }, { at: 4 }, { at: 10, zoom: other }], 1280, 800);
  assert.deepEqual(s.map(x => [x.a, x.b]), [[1, 4], [10, 14]]);
  // a gap between two steps in the same form: two stretches, each fading in and out
  assert.equal(zoomStretches([{ at: 1, zoom: form }, { at: 9 }, { at: 10, zoom: form }], 1280, 800).length, 2);
});

test('a step\'s second in the finished video: after the 3 s card, sped-up gaps shortened, holds added', () => {
  // steps at 1 s and 20 s: 0–3 kept, 3–20 at 4x (4.25 s), then normal
  const segs = segments([{ at: 1 }, { at: 20 }]);
  assert.equal(videoTime(segs, 1), 4);
  assert.equal(videoTime(segs, 20), 3 + 3 + 17 / 4);
  // a typed value at 1 s holds 1.5 s at 1.3 s: a step after it comes 1.5 s later
  const held = segments([{ at: 1, hold: true }, { at: 3 }]);
  assert.equal(videoTime(held, 1), 4);
  assert.equal(videoTime(held, 3), 3 + 3 + 1.5);
});

test('two holds: the finished video is as long as videoTime says (run page jumps land on their step)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abr-video-'));
  const video = join(dir, 'run.mp4');
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x200:r=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    const captions = [{ n: 1, at: 0.5, text: 'a', hold: true }, { n: 2, at: 1.5, text: 'b', hold: true }, { n: 3, at: 3, text: 'c' }];
    assert.equal(await finishVideo(video, { width: 320, height: 200, fps: 10, title: 't', captions }), null);
    // the recording's end (4 s) → card 3 + 4 + two holds of 1.5
    assert.equal(videoTime(segments(captions), 4), 10);
    assert.ok(Math.abs(seconds(video) - 10) < 0.15, `duration ${seconds(video)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ponytail: Linux only (/usr/bin/time); the graph must stream, so a longer recording must not need more memory
test('finishing a recording takes the same memory for 20 s and 60 s (zooms, holds and sped-up stretches stream)', { skip: !existsSync('/usr/bin/time') && 'needs /usr/bin/time' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abr-video-'));
  const peak = async secs => {
    const video = join(dir, `run${secs}.mp4`), log = join(dir, `rss${secs}`), wrap = join(dir, 'ffmpeg');
    writeFileSync(wrap, `#!/bin/sh\nexec /usr/bin/time -f %M -a -o ${log} ffmpeg "$@"\n`); chmodSync(wrap, 0o755);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-t', String(secs), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);
    const captions = [];
    for (let at = 1, n = 1; at < secs; at += 4, n++) captions.push({ n, at, text: `Step ${n}`, hold: n % 2 === 0, zoom: n % 3 === 0 ? { x: 40, y: 40, w: 160, h: 40, vw: 640, vh: 360 } : undefined });
    process.env.FFMPEG = wrap;
    try { assert.equal(await finishVideo(video, { width: 640, height: 360, fps: 30, title: 't', captions }), null); } finally { delete process.env.FFMPEG; }
    return Math.max(...readFileSync(log, 'utf8').trim().split('\n').map(Number));
  };
  try {
    const [short, long] = [await peak(20), await peak(60)];
    assert.ok(long < short * 1.5, `peak ${short} KB for 20 s, ${long} KB for 60 s`); // buffering grew ~3x
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('before the first step the caption bar is clear: the recording shows through', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abr-video-'));
  const video = join(dir, 'run.mp4');
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x200:r=10', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    assert.equal(await finishVideo(video, { width: 320, height: 200, fps: 10, title: 't', captions: [{ n: 1, at: 1.5, text: 'Click' }] }), null);
    // 0.5 s into the recording (after the 3 s card), in the middle of the bar's place
    const px = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', '3.5', '-i', video, '-frames:v', '1', '-vf', 'format=rgb24,crop=2:2:160:170', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    assert.ok(px[2] > 150 && px[0] < 80, `bar place is rgb(${[...px]})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
