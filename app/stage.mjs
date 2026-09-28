// A "stage" is one run's browser, streamed to the UI (CDP screencast) and optionally recorded. Each run has
// its own stage (createStage), so runs can go side by side. Two sources: our own browser for AI runs
// (Playwright MCP drives it over CDP), or the Playwright test runner's browser for replays (we attach over CDP).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { chromium, devices } from 'playwright-core';
import guard from './guard.cjs';


// Runs inside the tested page: draws a border-only box around what is being clicked or filled, so the
// live view, the video and the PDF guide show where the action happens. Works for any driver (AI or test),
// because it reacts to the real input events Playwright dispatches.
function highlighter() {
  if (window.__abrHighlight) return;
  window.__abrHighlight = true;
  const MARK = '__abr_highlight__';
  let box, timer, pinned, target, lastX, lastY, lastSignal = { el: null, at: 0 };
  const hideNow = () => { target = null; if (box) box.style.display = 'none'; };
  const hide = ms => { clearTimeout(timer); timer = setTimeout(hideNow, ms); };
  const place = r => Object.assign(box.style, { display: 'block', left: `${r.left - 5}px`, top: `${r.top - 5}px`, width: `${r.width + 10}px`, height: `${r.height + 10}px` });
  // keep the box on its element (scrolling, re-layout) and drop it when the element is gone (single-page apps
  // swap content without a page load, which would otherwise leave a box floating over the next screen)
  let lastRect;
  // a clicked element is often re-rendered in place (e.g. "Add to cart" becomes "Remove"): move the box to the
  // look-alike element at the same spot; anything else (a new screen) means the box should go
  const replacement = () => {
    if (!lastRect) return null;
    const hit = document.elementFromPoint(lastRect.left + lastRect.width / 2, lastRect.top + lastRect.height / 2);
    const el = hit && clickable(hit);
    if (!el || el === box) return null;
    const r = el.getBoundingClientRect();
    const similar = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.3;
    return similar(r.width, lastRect.width) && similar(r.height, lastRect.height) ? el : null;
  };
  const follow = () => {
    if (!target) return;
    if (!target.isConnected) { target = replacement(); if (!target) return hideNow(); }
    const r = target.getBoundingClientRect();
    if (!r.width && !r.height) return hideNow();
    place(r); lastRect = r;
    requestAnimationFrame(follow);
  };
  const draw = (el, field) => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('aria-hidden', 'true');
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:3px solid #FF3B30;border-radius:6px;box-shadow:0 0 0 2px rgba(255,255,255,.95),0 0 12px rgba(255,59,48,.45);';
    }
    if (!box.isConnected) (document.body || document.documentElement).appendChild(box);
    place(r); lastRect = r;
    const following = target;
    target = el;
    if (!following) requestAnimationFrame(follow);
    pinned = field ? el : null;
    clearTimeout(timer);
    if (!field) hide(1500);
  };
  // one signal per pointer action (move + down on the same element count once); field focus is not an action
  const signal = el => {
    if (lastSignal.el === el && performance.now() - lastSignal.at < 1500) return;
    lastSignal = { el, at: performance.now() };
    console.debug(MARK, JSON.stringify(describe(el)));
  };
  // What a person would call this element: its name as shown on screen, and what kind of thing it is
  const clean = t => (t ?? '').replace(/\s+/g, ' ').trim();
  const cut = t => (t.length > 60 ? `${t.slice(0, 57)}…` : t);
  const humanize = t => clean(String(t ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ')).toLowerCase();
  const describe = el => {
    const attr = n => clean(el.getAttribute?.(n));
    const labelled = attr('aria-labelledby').split(' ').map(id => clean(document.getElementById(id)?.innerText)).join(' ').trim();
    const forLabel = el.id ? clean(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) : '';
    const text = clean(el.innerText || el.value);
    const img = el.querySelector?.('img[alt]');
    const name = attr('aria-label') || labelled || forLabel || (text.length <= 80 ? text : text.split(/\n| {2,}/)[0])
      || attr('title') || clean(img?.alt) || attr('placeholder') || attr('alt')
      || humanize(attr('data-test') || attr('data-testid') || attr('data-cy') || attr('name') || attr('id'));
    const tag = el.tagName.toLowerCase(), type = attr('type'), role = attr('role');
    const r = el.getBoundingClientRect();
    const kind = role === 'menuitem' ? 'menu item' : role === 'tab' ? 'tab' : role === 'option' || tag === 'option' ? 'option'
      : role === 'checkbox' || type === 'checkbox' ? 'checkbox' : role === 'radio' || type === 'radio' ? 'option'
      : tag === 'select' || role === 'combobox' ? 'dropdown' : isField(el) ? 'field'
      : !text && r.width <= 64 && r.height <= 64 ? 'icon'
      : tag === 'a' || role === 'link' ? 'link' : tag === 'button' || role === 'button' || ['button', 'submit'].includes(type) ? 'button'
      : tag === 'li' ? 'item' : 'element';
    return { name: cut(name), kind };
  };
  const isField = el => el?.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,select,[contenteditable=""],[contenteditable="true"]');
  const clickable = el => el.closest?.('a,button,input,select,textarea,label,summary,[role],[onclick],[tabindex],li,td') || el;
  addEventListener('pointermove', e => {
    // Chrome sends synthetic moves after layout changes and on a freshly loaded page: not actions.
    // The first move a page sees is skipped for that reason; pointerdown still marks a real click.
    const first = lastX === undefined;
    if (!e.movementX && !e.movementY) return;
    if (e.clientX === lastX && e.clientY === lastY) return;
    lastX = e.clientX; lastY = e.clientY;
    if (first) return;
    const t = isField(e.target) ? e.target : clickable(e.target);
    draw(t, false); signal(t);
  }, true);
  addEventListener('pointerdown', e => { const t = isField(e.target) ? e.target : clickable(e.target); draw(t, false); signal(t); }, true);
  addEventListener('focusin', e => { if (isField(e.target)) draw(e.target, true); }, true);
  addEventListener('focusout', e => { if (pinned === e.target) { pinned = null; hide(700); } }, true);
}
const HIGHLIGHT_SOURCE = `(${highlighter})();`;
export { HIGHLIGHT_SOURCE }; // for tests

const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };

// Accessibility check (opt-in): axe-core, WCAG 2 A/AA, serious and critical violations, once per page address
let axeSource;
const loadAxe = () => (axeSource ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'));
const AXE_RUN = `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] })
  .then(r => JSON.stringify(r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
    .map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length }))))`;

// The AI browser stays open after a run so its login can be saved, but not forever: it holds a few hundred MB
const IDLE_CLOSE_MS = 5 * 60_000;

// Our browsers are found through debugging ports. Anything answering on a port we did not open belongs to
// someone else (another run, a second copy of this app): never drive it.
export const portAnswers = port => fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700) }).then(() => true, () => false);

export function createStage(ports) {
  const viewers = new Set();
  const last = {}; // replayed to viewers who connect mid-run
  const highlightListeners = new Set(); // guide collectors: the frame that shows a freshly drawn box
  const issueListeners = new Set();     // console errors, exceptions, HTTP >= 400, failed requests
  const held = new Set();               // debugging ports this stage took from the pool
  let context;  // our own browser (AI runs); kept open after a run so its login session can be saved
  let attached; // CDP connection to the test runner's browser (replays)
  let idleTimer;

  const send = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (type, data) => { last[type] = data; for (const res of viewers) send(res, type, data); };
  const onHighlight = fn => { highlightListeners.add(fn); return () => highlightListeners.delete(fn); };

  async function reservePort() { const p = await ports.take(); held.add(p); return p; }
  async function closeAll() {
    clearTimeout(idleTimer);
    await attached?.close().catch(() => {}); attached = null;
    await context?.close().catch(() => {}); context = null;
    for (const p of held) ports.give(p);
    held.clear();
    delete last.frame; // don't record/show the previous browser's last frame
  }

  function castPages(ctx, { width, height, highlight, a11y }) {
    const scanned = new Set(); // page addresses already checked in this browser
    let cast;
    async function watch(page) {
      // ponytail: screencast only the newest tab; runs rarely use more than one
      await cast?.detach().catch(() => {});
      const s = cast = await ctx.newCDPSession(page);
      let boxPending = null; // set when the page drew a box; the next frame is the one that shows it
      let boxInfo = null; // name + kind of the boxed element, from the page
      const boxFrame = data => { clearTimeout(boxPending); boxPending = null; for (const fn of highlightListeners) fn(data, boxInfo); };
      s.on('Page.screencastFrame', ({ data, sessionId }) => {
        broadcast('frame', data);
        if (boxPending) boxFrame(data);
        s.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      });
      page.on('framenavigated', f => f === page.mainFrame() && broadcast('url', page.url()));

      const report = issue => {
        const host = hostOf(issue.url), pageHost = hostOf(page.url());
        for (const fn of issueListeners) fn({ ...issue, page: page.url(), thirdParty: Boolean(host && pageHost && host !== pageHost) });
      };
      const requests = new Map(); // requestId -> method + url, to describe failures
      s.on('Runtime.consoleAPICalled', e => {
        if (e.type !== 'error' && e.type !== 'assert') return;
        const text = e.args.map(a => a.value ?? a.description ?? '').join(' ');
        if (text.startsWith('__abr_')) return;
        report({ kind: 'console', text: text.slice(0, 500), url: e.stackTrace?.callFrames?.[0]?.url });
      });
      s.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) =>
        report({ kind: 'exception', text: (d.exception?.description ?? d.text ?? '').split('\n').slice(0, 3).join('\n').slice(0, 500), url: d.url }));
      s.on('Network.requestWillBeSent', ({ requestId, request }) => {
        if (requests.size > 2000) requests.clear();
        requests.set(requestId, { url: request.url, method: request.method });
      });
      s.on('Network.responseReceived', ({ requestId, response, type }) => {
        const r = requests.get(requestId); requests.delete(requestId);
        if (response.status < 400 || /favicon\.ico/.test(response.url)) return;
        const method = r?.method ?? 'GET';
        report({ kind: 'http', status: response.status, method, url: response.url, type, text: `${method} ${response.status} ${response.statusText ?? ''}`.trim() });
      });
      s.on('Network.loadingFinished', ({ requestId }) => requests.delete(requestId));
      s.on('Network.loadingFailed', ({ requestId, errorText, canceled, blockedReason }) => {
        const r = requests.get(requestId); requests.delete(requestId);
        if (canceled || !r) return;
        report({ kind: 'failed', method: r.method, url: r.url, text: `${r.method} failed: ${blockedReason ?? errorText}` });
      });
      await s.send('Runtime.enable');
      await s.send('Network.enable');

      if (a11y) {
        let timer;
        const scan = async () => {
          const url = page.url().split('#')[0];
          if (!/^https?:/.test(url) || scanned.has(url)) return;
          scanned.add(url);
          try {
            await s.send('Runtime.evaluate', { expression: loadAxe() });
            const r = await s.send('Runtime.evaluate', { expression: AXE_RUN, awaitPromise: true, returnByValue: true });
            for (const v of JSON.parse(r.result?.value ?? '[]'))
              report({ kind: 'a11y', impact: v.impact, url, text: `${v.help} (${v.id}, ${v.nodes} element${v.nodes > 1 ? 's' : ''})` });
          } catch {} // page navigated away mid-check: the next page gets its own
        };
        // after each navigation (also single-page-app route changes), once the page has settled a moment
        page.on('framenavigated', f => { if (f === page.mainFrame()) { clearTimeout(timer); timer = setTimeout(scan, 1500); } });
        timer = setTimeout(scan, 1500);
      }

      if (highlight) {
        s.on('Runtime.consoleAPICalled', e => {
          if (e.args?.[0]?.value !== '__abr_highlight__') return;
          try { boxInfo = JSON.parse(e.args[1]?.value ?? 'null'); } catch { boxInfo = null; }
          clearTimeout(boxPending);
          boxPending = setTimeout(() => boxFrame(last.frame), 300); // no repaint came: use what is on screen
        });
        await s.send('Runtime.enable');
        await s.send('Page.enable'); // required for scripts on new documents (full page loads)
        await s.send('Page.addScriptToEvaluateOnNewDocument', { source: HIGHLIGHT_SOURCE });
        await s.send('Runtime.evaluate', { expression: HIGHLIGHT_SOURCE }).catch(() => {}); // page already loaded
      }
      page.on('close', () => { const rest = ctx.pages().filter(p => !p.isClosed()); if (rest.length) watch(rest.at(-1)).catch(() => {}); });
      await s.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: width, maxHeight: height });
      broadcast('url', page.url());
    }
    ctx.on('page', p => watch(p).catch(() => {}));
    return watch;
  }

  return {
    addViewer(res) { viewers.add(res); for (const [type, data] of Object.entries(last)) send(res, type, data); res.on('close', () => viewers.delete(res)); },
    currentFrame: () => last.frame,
    onHighlight,
    onIssue(fn) { issueListeners.add(fn); return () => issueListeners.delete(fn); },
    reservePort,
    releasePort(p) { if (held.delete(p)) ports.give(p); }, // a test runner's browser has exited: its port is free now
    hasOwnBrowser: () => Boolean(context),

    // Fresh browser for an AI run so state never leaks between runs, optionally seeded with a saved login session
    async ownBrowser({ width, height, highlight, device, a11y }, session) {
      await closeAll();
      const port = await reservePort();
      const ctx = context = await chromium.launchPersistentContext('', {
        headless: true,
        // same user agent as replays: the default "HeadlessChrome" one is blocked by anti-bot middleware (403 "Access Denied")
        userAgent: devices['Desktop Chrome'].userAgent,
        // a device profile brings its user agent, pixel ratio, touch and mobile mode; the browser stays Chromium
        ...(device && devices[device] ? (({ defaultBrowserType, ...d }) => d)(devices[device]) : {}),
        viewport: { width, height },
        args: [`--remote-debugging-port=${port}`, ...guard.blockArgs(guard.productionHostsFromSettings())], // production never resolves
      });
      if (session) {
        // persistent contexts can't take storageState directly: restore cookies, then localStorage per origin once per tab
        await ctx.addCookies(session.cookies ?? []);
        await ctx.addInitScript(origins => {
          const o = origins.find(x => x.origin === location.origin);
          if (o && !sessionStorage.getItem('__sessionRestored')) {
            for (const { name, value } of o.localStorage) localStorage.setItem(name, value);
            sessionStorage.setItem('__sessionRestored', '1');
          }
        }, session.origins ?? []);
      }
      const watch = castPages(ctx, { width, height, highlight, a11y });
      await watch(ctx.pages()[0] ?? await ctx.newPage());
      return port;
    },

    // Replays: the test runner launches its own browser on `port` (from reservePort); attach as soon as it is up
    async watchReplayBrowser(port, { width, height, highlight, a11y }, signal) {
      await attached?.close().catch(() => {}); attached = null;
      await context?.close().catch(() => {}); context = null; // a workflow hands over from our browser to the runner's
      while (!signal.aborted) {
        try {
          const b = attached = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
          const ctx = b.contexts()[0];
          const watch = castPages(ctx, { width, height, highlight, a11y });
          const open = ctx.pages();
          if (open.length) await watch(open.at(-1));
          return;
        } catch { await new Promise(r => setTimeout(r, 150)); } // not up yet
      }
    },

    async saveSession() {
      if (!context) throw new Error('This run\'s browser is closed (it closes 5 minutes after the run). Run the AI again, then save its session.');
      return context.storageState();
    },

    // Records the stage to MP4: resamples the latest frame at a fixed fps so the video runs in real time
    // (screencast only emits frames when the page changes). Needs ffmpeg with libx264 on PATH (or FFMPEG=/path).
    startRecording(file, { width, height, fps }) {
      mkdirSync(dirname(file), { recursive: true });
      const ff = spawn(process.env.FFMPEG ?? 'ffmpeg', [
        '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-',
        '-vf', `scale=${width}:${height}`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', file,
      ], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '', frames = 0;
      ff.stderr.on('data', d => { err += d; });
      ff.stdin.on('error', () => {}); // ffmpeg died; reported on stop
      const write = data => { ff.stdin.write(Buffer.from(data, 'base64')); frames++; };
      const timer = setInterval(() => { if (last.frame) write(last.frame); }, 1000 / fps);
      // A click's box is often on screen for only a few ms (the page changes right after), so the video
      // holds the frame that shows it for HOLD_S. Frames are added, not replaced: nothing of the run is cut.
      const HOLD_S = 0.7;
      const stopHolding = onHighlight(frame => { if (frame) for (let i = 0; i < Math.round(fps * HOLD_S); i++) write(frame); });
      return () => new Promise(resolve => {
        clearInterval(timer);
        stopHolding();
        ff.on('close', code => resolve(code === 0 && frames ? null : (err.trim() || 'no frames captured')));
        ff.on('error', e => resolve(`cannot start ffmpeg: ${e.message}`));
        ff.stdin.end();
      });
    },

    // The AI browser stays open after a run so its login can be saved, but not forever: it holds a few hundred MB
    closeWhenIdle(after = () => {}) { clearTimeout(idleTimer); idleTimer = setTimeout(() => closeAll().catch(() => {}).then(after), IDLE_CLOSE_MS); },
    async close() { await closeAll(); },
  };
}
