// Parallel runs: a fixed number of slots, a FIFO line, and locks for what two runs must not share
// (a test database that is reset before each run). Pure logic; the server wires it to requests.

// Invariant: after every change no waiting run fits, so a new run may start whenever it fits itself.
export function createLimiter(max) {
  let active = 0;
  const held = new Set(), waiting = [];
  const fits = keys => active < max && keys.every(k => !held.has(k));
  const take = keys => {
    active++; for (const k of keys) held.add(k);
    let done = false;
    return () => { if (done) return; done = true; active--; for (const k of keys) held.delete(k); pump(); };
  };
  function pump() {
    for (let i = 0; i < waiting.length; i++) {
      if (!fits(waiting[i].keys)) continue; // a locked run does not block the ones behind it
      const [w] = waiting.splice(i--, 1);
      w.resolve(take(w.keys));
    }
  }
  return {
    acquire(keys = [], onQueued = () => {}, signal) {
      if (fits(keys)) return Promise.resolve(take(keys));
      return new Promise((resolve, reject) => {
        const w = { keys, resolve };
        waiting.push(w);
        onQueued(waiting.length);
        signal?.addEventListener('abort', () => {
          const i = waiting.indexOf(w);
          if (i >= 0) { waiting.splice(i, 1); reject(new Error('left the queue')); }
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
export const mcpServerFor = (port, outputDir, runVars) => ({
  command: 'node',
  args: ['mcp-proxy.mjs', '--cdp-endpoint', `http://127.0.0.1:${port}`, '--output-dir', outputDir],
  env: { RUN_VARS: JSON.stringify(runVars) },
});
