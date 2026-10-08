// Finishing a recording: a 3-second title card (the project's logo, the run's title, the application's name)
// in front, then the run with a caption bar at the bottom (step number + what is done) that changes as the
// steps go, zoomed in on forms and modals, idle stretches sped up. Cuts only, no transitions.
import { spawn } from 'node:child_process';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { chromium } from 'playwright-core';
import { esc } from './shared.mjs';

const ffmpeg = (args, cwd) => new Promise(resolve => {
  const p = spawn(process.env.FFMPEG ?? 'ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], cwd });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  p.on('error', e => resolve(`cannot start ffmpeg: ${e.message}`));
  p.on('close', code => resolve(code === 0 ? null : err.trim() || `ffmpeg exited with ${code}`));
});

export const titleCardHtml = ({ title, app, logo, accent }) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: #fff; }
  body { display: grid; place-items: center; font-family: system-ui, 'Segoe UI', sans-serif; color: #555; text-align: center; }
  body::before { content: ''; position: fixed; inset: 0 0 auto; height: 1.2vh; background: ${accent}; }
  main { display: grid; justify-items: center; gap: 4vh; width: 80vw; }
  img { max-width: 33vw; max-height: 32vh; }
  h1 { margin: 0; font-size: 6vh; font-weight: 700; color: ${accent}; line-height: 1.2; overflow-wrap: anywhere; }
  p { margin: 0; font-size: 3vh; font-weight: 500; }
</style></head><body><main>
  ${logo ? `<img src="${logo}" alt="">` : ''}
  <h1>${esc(title)}</h1>
  ${app ? `<p>${esc(app)}</p>` : ''}
</main></body></html>`;

// The bar's height as a share of the video's height (bar, badge and text scale with it)
export const BAR = 0.084;
// Space under the bar (share of the video's height), so a player's controls do not cover it
export const BAR_LIFT = 0.12;
export const captionHtml = ({ n, text, accent }) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: transparent; }
  body { display: flex; align-items: center; gap: 22px; padding: 0 24px; background: rgba(0,0,0,.8); font-family: system-ui, 'Segoe UI', sans-serif; color: #fff; overflow: hidden; }
  .n { flex: none; width: 66vh; height: 66vh; display: grid; place-items: center; background: ${accent}; font-weight: 700; font-size: 36vh; }
  p { margin: 0; font-size: 40vh; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style></head><body><span class="n">${n}</span><p>${esc(text)}</p></body></html>`;

export const speedHtml = speed => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: transparent; }
  body { display: grid; place-items: center; background: rgba(0,0,0,.65); font: 700 55vh system-ui, 'Segoe UI', sans-serif; color: #fff; }
</style></head><body>${speed}x</body></html>`;

// Idle stretches (the AI thinking, a page loading, long typing) run faster: after a step, KEEP_S seconds play
// as they are; if the next step is still more than MIN_GAP_S away, the rest runs at SPEED with a "4x" badge.
// After the last step the video plays as recorded: it shows the end result.
export const KEEP_S = 2, MIN_GAP_S = 5, SPEED = 4;
// [{ start, end (undefined = to the end), fast }] covering the whole recording, from the step times
export function segments(captions) {
  const ats = captions.map(c => c.at);
  const out = [];
  let pos = 0;
  ats.forEach((at, i) => {
    const next = ats[i + 1];
    if (next === undefined || next - at <= MIN_GAP_S) return;
    if (at + KEEP_S > pos) out.push({ start: pos, end: at + KEEP_S, fast: false });
    out.push({ start: Math.max(pos, at + KEEP_S), end: next, fast: true });
    pos = next;
  });
  out.push({ start: pos, end: undefined, fast: false });
  return withHolds(out, captions);
}

// A second of the recording → the same moment in the finished video: after the title card, through the sped-up and held stretches
export const CARD_S = 3;
export function videoTime(segs, at, card = CARD_S) {
  let t = card;
  for (const g of segs) {
    if (g.freeze) { if (at > g.start) t += g.freeze; continue; }
    const rate = g.fast ? SPEED : 1, end = g.end ?? Infinity;
    if (at < end) return t + Math.max(0, at - g.start) / rate;
    t += (end - g.start) / rate;
  }
  return t;
}

// A value typed or picked shows in one frame (Playwright fills a field at once): after such a step the picture
// stands still for HOLD_S seconds, HOLD_AT seconds after the step (the value is in), so it can be read.
export const HOLD_S = 1.5, HOLD_AT = 0.3;
function withHolds(segs, captions) {
  const out = [...segs];
  captions.forEach((c, i) => {
    if (!c.hold) return;
    const next = captions[i + 1]?.at;
    const h = Math.min(c.at + HOLD_AT, next === undefined ? Infinity : next - 0.05);
    if (h <= c.at) return;
    const k = out.findIndex(g => !g.fast && !g.freeze && h > g.start && (g.end === undefined || h < g.end));
    if (k < 0) return;
    const g = out[k];
    out.splice(k, 1, { start: g.start, end: h, fast: false }, { start: h, end: h, fast: false, freeze: HOLD_S }, { start: h, end: g.end, fast: false });
  });
  return out;
}

// A step inside a form or modal zooms in on it while the step lasts (at most ZOOM_S seconds), as long as that
// makes it at least MIN_ZOOM times bigger; full pages (lists, dashboards) stay as they are.
export const ZOOM_S = 4, MIN_ZOOM = 1.25, MAX_ZOOM = 2;
// zooming in and out cross-fades over this long, so the picture never jumps
export const ZOOM_FADE_S = 0.4;
// r: the area in page pixels { x, y, w, h, vw, vh (the page's viewport) } -> the crop in video pixels, or null
export function zoomRect(r, width, height) {
  if (!r?.vw || !r?.vh) return null;
  const sx = width / r.vw, sy = height / r.vh;
  if (Math.abs(sx - sy) > 0.02 * sx) return null; // page not filling the frame (device emulation): leave it
  const pad = 24, rw = r.w * sx + pad * 2, rh = r.h * sy + pad * 2;
  const f = Math.min(MAX_ZOOM, width / rw, height / rh);
  if (f < MIN_ZOOM) return null;
  const w = Math.round(width / f / 2) * 2, h = Math.round(height / f / 2) * 2;
  const clamp = (v, max) => Math.round(Math.min(Math.max(v, 0), max));
  return { w, h, x: clamp(r.x * sx + r.w * sx / 2 - w / 2, width - w), y: clamp(r.y * sy + r.h * sy / 2 - h / 2, height - h) };
}

// The zoomed stretches [{ a, b, z }]: one per step in a form or modal, while it lasts (at most ZOOM_S). Steps
// right after each other in the same form make one stretch, so the picture stays zoomed instead of fading
// out and in again between fields.
export function zoomStretches(captions, width, height) {
  const out = [];
  captions.forEach((c, i) => {
    const z = zoomRect(c.zoom, width, height);
    if (!z) return;
    const a = c.at, b = Math.min(captions[i + 1]?.at ?? 1e9, c.at + ZOOM_S), prev = out.at(-1);
    if (prev && a - prev.b < 0.05 && ['x', 'y', 'w', 'h'].every(k => prev.z[k] === z[k])) prev.b = b;
    else out.push({ a, b, z });
  });
  return out;
}

// Caption text as the style guide wants it: an instruction of about 8 words, no full stop
export const CAPTION_WORDS = 10;
export function captionText(text) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '').split(' ');
  return words.length > CAPTION_WORDS ? `${words.slice(0, CAPTION_WORDS).join(' ')}…` : words.join(' ');
}

// Rewrites the video in place. Returns an error message (the video is left as recorded) or null.
// captions: [{ n, at (seconds into the recording), text, zoom?, hold? (a value was entered) }], each shown until the next one starts.
// ponytail: the whole run is re-encoded (a few seconds per recorded minute); encode only the card and
// concat with -c copy if long recordings make this wait noticeable.
export async function finishVideo(video, { width, height, fps = 10, seconds = CARD_S, captions = [], ...card }) {
  const tmp = i => `${video}.${i}.png`, out = `${video}.tmp.mp4`;
  const pngs = [tmp('card'), ...captions.map((_, i) => tmp(i)), tmp('speed'), tmp('blank')], list = `${video}.captions.txt`, cmds = `${video}.zoom.txt`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(titleCardHtml(card), { waitUntil: 'load' });
    await page.screenshot({ path: pngs[0] });
    const bh = Math.round(height * BAR / 2) * 2;
    await page.setViewportSize({ width, height: bh });
    for (const [i, c] of captions.entries()) {
      await page.setContent(captionHtml({ ...c, text: captionText(c.text), accent: card.accent }), { waitUntil: 'load' });
      await page.screenshot({ path: pngs[i + 1], omitBackground: true });
    }
    const badge = Math.round(bh * 0.6);
    await page.setViewportSize({ width: badge * 2, height: badge });
    await page.setContent(speedHtml(SPEED), { waitUntil: 'load' });
    await page.screenshot({ path: pngs.at(-2), omitBackground: true });
    // no caption yet: a clear bar (made by ffmpeg: Chromium sometimes refuses to screenshot an empty page)
    const blankErr = await ffmpeg(['-f', 'lavfi', '-i', `color=c=black:s=${width}x${bh}`, '-vf', 'format=rgba,colorchannelmixer=aa=0', '-frames:v', '1', pngs.at(-1)]);
    if (blankErr) return blankErr;
    // every caption bar as one input (ffmpeg's concat list: each picture lasts until the next step), not one input
    // per step: each input has its own decoder and buffers, ~25 MB each at 540p (60 steps took 2 GB)
    const q = f => `'${f.replaceAll("'", "'\\''")}'`;
    const bars = [{ file: pngs.at(-1), at: 0 }, ...captions.map((c, i) => ({ file: pngs[i + 1], at: c.at }))].filter((b, i, all) => i === all.length - 1 || all[i + 1].at > b.at);
    writeFileSync(list, `ffconcat version 1.0\n${bars.map((b, i) => `file ${q(b.file)}\n${i < bars.length - 1 ? `duration ${(bars[i + 1].at - b.at).toFixed(3)}\n` : ''}`).join('')}`);
    // [0] card, [1] recording, [2] the caption bars in time, [3] the speed badge.
    // Everything streams frame by frame. A split whose branches were read at different times (trim/concat, a trimmed
    // zoom copy) kept every frame in between in memory: a 3-minute 1080p recording took ~15 GB.
    let chain = '', last = '[1:v]';
    const stretches = zoomStretches(captions, width, height);
    // zoom: one copy of the picture, cropped to the current stretch's box and scaled back up, mixed over the recording
    // by blend (opacity 1 = the recording, 0 = the zoomed copy). sendcmd moves the box and fades the mix at each
    // stretch's times; both copies go frame by frame, however many stretches there are.
    if (stretches.length) {
      const t = v => v.toFixed(3), lines = [];
      for (const { a, b, z } of stretches) {
        const f = Math.min(ZOOM_FADE_S, (b - a) / 3), k = Math.max(1, Math.round(f * fps)), at = i => a + i * f / k;
        lines.push(`${t(a)}-${t(b)} [enter] crop@z w ${z.w}, [enter] crop@z h ${z.h}, [enter] crop@z x ${z.x}, [enter] crop@z y ${z.y};`);
        for (let i = 0; i < k; i++) lines.push(`${t(at(i))}-${t(i === k - 1 ? b - f : at(i + 1))} [enter] blend@z all_opacity ${t(1 - (i + 1) / k)};`); // in; the last step lasts
        for (let i = 0; i < k; i++) lines.push(`${t(b - f + i * f / k)}-${t(b - f + (i + 1) * f / k)} [enter] blend@z all_opacity ${t((i + 1) / k)};`); // out
        lines.push(`${t(b)}-${t(b + 1)} [enter] crop@z w ${width}, [enter] crop@z h ${height}, [enter] crop@z x 0, [enter] crop@z y 0;`); // the whole picture: scale passes it through
      }
      writeFileSync(cmds, lines.join('\n') + '\n');
      const on = stretches.map(({ a, b }) => `between(t,${t(a)},${t(b)})`).join('+');
      chain += `[1:v]sendcmd=f=${basename(cmds)},split=2[zm][zs];[zs]crop@z=${width}:${height}:0:0,scale=${width}:${height}[zz];`
        + `[zm][zz]blend@z=all_mode=normal:all_opacity=1:enable='${on}'[zb];`;
      last = '[zb]';
    }
    chain += `${last}[2:v]overlay=0:${height - bh - Math.round(height * BAR_LIFT)}[v];`; last = '[v]'; // the last bar stays to the end
    // then the stretches at their own speed, in one pass: each frame moves to its time in the finished video
    // (videoTime without the card); fps drops the extra frames of sped-up stretches and repeats the frame before a hold
    const segs = segments(captions), n = v => v.toFixed(3);
    const remap = segs.map(g => g.freeze ? `gt(T,${n(g.start)})*${g.freeze}`
      : g.end === undefined ? `(max(T,${n(g.start)})-${n(g.start)})` : `(clip(T,${n(g.start)},${n(g.end)})-${n(g.start)})${g.fast ? `/${SPEED}` : ''}`).join('+');
    const fast = segs.filter(g => g.fast).map(g => `between(t,${n(videoTime(segs, g.start, 0))},${n(videoTime(segs, g.end, 0))})`).join('+') || '0';
    chain += `${last}setpts='(${remap})/TB',fps=${fps}[t];[t][3:v]overlay=${width - badge * 2 - 24}:24:enable='${fast}',scale=out_range=tv,format=yuv420p[r];`;
    const err = await ffmpeg(['-loop', '1', '-framerate', String(fps), '-t', String(seconds), '-i', pngs[0], '-i', video, '-f', 'concat', '-safe', '0', '-i', list, '-i', pngs.at(-2),
      '-filter_complex', `[0:v]scale=out_range=tv,format=yuv420p[c];${chain}[c][r]concat=n=2:v=1:a=0[v]`, '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-bsf:v', 'h264_metadata=video_full_range_flag=0', '-movflags', '+faststart', out], dirname(video)); // limited range: see stage.mjs. In the recording's folder: sendcmd names its file
      // by base name (the app's own run names: letters, digits, dashes), nothing to escape in the filter
    if (err) return err;
    renameSync(out, video);
    return null;
  } catch (e) { return e.message; } finally {
    await browser.close();
    for (const f of [...pngs, list, cmds, out]) rmSync(f, { force: true });
  }
}
