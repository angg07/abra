// Finishing a recording: a 3-second title card (the project's logo, the run's title, the application's name)
// in front, then the run with a caption bar at the bottom (step number + what is done) that changes as the
// steps go, zoomed in on forms and modals, idle stretches sped up. Cuts only, no transitions.
import { spawn } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { esc } from './shared.mjs';

const ffmpeg = args => new Promise(resolve => {
  const p = spawn(process.env.FFMPEG ?? 'ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
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
export async function finishVideo(video, { width, height, fps = 10, seconds = 3, captions = [], ...card }) {
  const tmp = i => `${video}.${i}.png`, out = `${video}.tmp.mp4`;
  const pngs = [tmp('card'), ...captions.map((_, i) => tmp(i)), tmp('speed')];
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
    await page.screenshot({ path: pngs.at(-1), omitBackground: true });
    // [0] card, [1] recording, [2..] caption bars laid over the recording while their step lasts, [last] the speed badge
    let chain = '', last = '[1:v]';
    // zoomed copies go under the captions; each copy only takes the frames of its own stretch and fades in and out
    zoomStretches(captions, width, height).forEach(({ a, b, z }, i) => {
      const f = Math.min(ZOOM_FADE_S, (b - a) / 3), [A, B] = [a.toFixed(2), b.toFixed(2)];
      chain += `${last}split[zb${i}][zs${i}];[zs${i}]trim=start=${A}:end=${B},crop=${z.w}:${z.h}:${z.x}:${z.y},scale=${width}:${height},format=yuva420p,`
        + `fade=t=in:st=${A}:d=${f.toFixed(2)}:alpha=1,fade=t=out:st=${(b - f).toFixed(2)}:d=${f.toFixed(2)}:alpha=1[zz${i}];`;
      chain += `[zb${i}][zz${i}]overlay=0:0:eof_action=pass:enable='between(t,${A},${B})'[z${i}];`;
      last = `[z${i}]`;
    });
    captions.forEach((c, i) => {
      const until = captions[i + 1]?.at ?? 1e9;
      chain += `${last}[${i + 2}:v]overlay=0:${height - bh - Math.round(height * BAR_LIFT)}:enable='between(t,${c.at.toFixed(2)},${until.toFixed(2)})'[v${i}];`;
      last = `[v${i}]`;
    });
    // then cut into stretches at their own speed and put them back together
    const segs = segments(captions), speedIn = `[${captions.length + 2}:v]`;
    chain += `${last}split=${segs.length}${segs.map((_, i) => `[s${i}]`).join('')};`;
    segs.forEach((g, i) => {
      // one frame, shown for g.freeze seconds
      if (g.freeze) { chain += `[s${i}]trim=start=${g.start.toFixed(2)},setpts=PTS-STARTPTS,trim=end_frame=1,tpad=stop_mode=clone:stop_duration=${g.freeze}[p${i}];`; return; }
      chain += `[s${i}]trim=start=${g.start.toFixed(2)}${g.end === undefined ? '' : `:end=${g.end.toFixed(2)}`},setpts=(PTS-STARTPTS)${g.fast ? `/${SPEED}` : ''}`;
      chain += g.fast ? `[t${i}];[t${i}]${speedIn}overlay=${width - badge * 2 - 24}:24[p${i}];` : `[p${i}];`;
    });
    chain += `${segs.map((_, i) => `[p${i}]`).join('')}concat=n=${segs.length}:v=1:a=0,fps=${fps},scale=out_range=tv,format=yuv420p[r];`;
    const err = await ffmpeg(['-loop', '1', '-framerate', String(fps), '-t', String(seconds), '-i', pngs[0], '-i', video, ...pngs.slice(1).flatMap(f => ['-i', f]),
      '-filter_complex', `[0:v]scale=out_range=tv,format=yuv420p[c];${chain}[c][r]concat=n=2:v=1:a=0[v]`, '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-bsf:v', 'h264_metadata=video_full_range_flag=0', '-movflags', '+faststart', out]); // limited range: see stage.mjs
    if (err) return err;
    renameSync(out, video);
    return null;
  } catch (e) { return e.message; } finally {
    await browser.close();
    for (const f of [...pngs, out]) rmSync(f, { force: true });
  }
}
