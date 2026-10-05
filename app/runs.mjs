// Parallel runs: a fixed number of slots, a FIFO line, and locks for what two runs must not share
// (a test database that is reset before each run). Pure logic; the server wires it to requests.

// Invariant: after every change no waiting run fits, so a new run may start whenever it fits itself.
// Up to `max` runs at once. roomForMore(): may one more run start next to the ones running (enough free memory)?
// The first run always may. While runs wait, the line is checked again every recheckMs: memory frees up
// without a slot coming back.
export function createLimiter(max, { roomForMore = () => true, recheckMs = 5000 } = {}) {
  let active = 0, timer = null;
  const held = new Set(), waiting = [];
  const blocked = keys => (active >= max || keys.some(k => held.has(k)) ? 'slot' : active > 0 && !roomForMore() ? 'memory' : null);
  const take = keys => {
    active++; for (const k of keys) held.add(k);
    let done = false;
    return () => { if (done) return; done = true; active--; for (const k of keys) held.delete(k); pump(); };
  };
  const watch = () => {
    if (waiting.length && !timer) { timer = setInterval(pump, recheckMs); timer.unref?.(); }
    if (!waiting.length && timer) { clearInterval(timer); timer = null; }
  };
  function pump() {
    for (let i = 0; i < waiting.length; i++) {
      if (blocked(waiting[i].keys)) continue; // a locked run does not block the ones behind it
      const [w] = waiting.splice(i--, 1);
      w.resolve(take(w.keys));
    }
    watch();
  }
  return {
    acquire(keys = [], onQueued = () => {}, signal) {
      const reason = blocked(keys);
      if (!reason) return Promise.resolve(take(keys));
      return new Promise((resolve, reject) => {
        const w = { keys, resolve };
        waiting.push(w);
        onQueued(waiting.length, reason);
        watch();
        signal?.addEventListener('abort', () => {
          const i = waiting.indexOf(w);
          if (i >= 0) { waiting.splice(i, 1); watch(); reject(new Error('left the queue')); }
        });
      });
    },
    // acquire, run fn, and always give the slot and locks back: a throw anywhere in fn cannot jam the line
    async run(keys, onQueued, signal, fn) {
      const release = await this.acquire(keys, onQueued, signal);
      try { return await fn(); } finally { release(); }
    },
    stats: () => ({ active, waiting: waiting.length }),
  };
}

// May one more run start next to the ones running? Short of memory: close finished runs' browsers (kept for "Save login
// session") and say no; the limiter's next re-check sees the freed memory. macOS reports only truly free pages (a few
// hundred MB on a healthy Mac), so there the gate stays open and MAX_RUNS alone decides.
export const memoryGate = ({ freeMB, minMB, freeIdle, platform = process.platform }) => () => {
  if (platform === 'darwin' || freeMB() >= minMB) return true;
  freeIdle();
  return false;
};

// Finished runs whose AI browser is still open (kept for "Save login session"): which to close so at most
// `max` stay, oldest finish first. Replays hold no browser worth keeping, so they never push an AI run out.
export function idleToClose(runs, max) {
  const idle = runs.filter(r => r.done && r.browser).sort((a, b) => a.doneAt - b.doneAt);
  return idle.slice(0, Math.max(0, idle.length - max)).map(r => r.id);
}

// Browser debugging ports for runs. A port is marked taken before the async check, so two runs never get the same one.
export function createPortPool(from, to, inUseElsewhere) {
  const taken = new Set();
  return {
    async take() {
      for (let p = from; p <= to; p++) {
        if (taken.has(p)) continue;
        taken.add(p);
        if (await inUseElsewhere(p)) { taken.delete(p); continue; } // another program's browser: never drive it
        return p;
      }
      throw new Error(`No free browser port between ${from} and ${to}`);
    },
    give(p) { taken.delete(p); },
  };
}

// The MCP server of one AI run: its own browser, output folder and test values. RUN_VARS holds names and
// environment values only; the proxy reads secret values from .env itself.
// codeLog: a file the proxy appends the code of every browser action to (one JSON string per line)
export const mcpServerFor = (port, outputDir, runVars, codeLog) => ({
  command: process.execPath, // the Node running the app (the portable build's own), not whatever is on PATH
  args: ['mcp-proxy.mjs', '--cdp-endpoint', `http://127.0.0.1:${port}`, '--output-dir', outputDir],
  env: { RUN_VARS: JSON.stringify(runVars), ...(codeLog && { CODE_LOG: codeLog }) },
});
