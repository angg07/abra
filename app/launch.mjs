// start.sh / start.cmd run this: the app starts in the background with no terminal or console window left open;
// its window is the app, and closing it stops the app. Output goes to app/data/app.log.
// Before an app window is possible (Chromium not downloaded yet, no Chrome/Edge installed) the app opens in the
// browser instead, and this terminal stays open: it is then the way to stop the app.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { findAppBrowser } from './window.mjs';

const root = join(import.meta.dirname, '..');
const serverFile = join(import.meta.dirname, 'server.mjs');
const env = { ...process.env, ABR_PORTABLE: '1', ABR_OPEN: '1' };
const port = Number(process.env.PORT ?? 4321);

if (!findAppBrowser({ bundled: chromium.executablePath() })) {
  console.log('The app opens in your browser. Keep this window open while you use it; close it (or press Ctrl+C) to stop the app.\n');
  spawn(process.execPath, [serverFile], { stdio: 'inherit', env }).on('exit', code => process.exit(code ?? 0));
} else {
  const logDir = join(root, 'app', 'data');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'app.log');
  const from = existsSync(logFile) ? statSync(logFile).size : 0;
  const out = openSync(logFile, 'a');
  const server = spawn(process.execPath, [serverFile], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env });

  // this copy of the app answers on the port (just started, or already running): done
  const ours = async () => {
    const folder = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }).then(r => r.headers.get('x-abr-folder'), () => null);
    return folder && decodeURIComponent(folder) === root;
  };
  const result = await new Promise(resolve => {
    server.on('exit', code => resolve(code === 0 ? 'ok' : 'failed')); // 0: it found itself already running
    const t0 = Date.now();
    (async function poll() {
      if (await ours()) return resolve('ok');
      if (Date.now() - t0 > 30_000) return resolve('slow');
      setTimeout(poll, 300);
    })();
  });
  if (result === 'failed') {
    console.error(readFileSync(logFile, 'utf8').slice(from).split('\n').filter(l => l && !/ExperimentalWarning|trace-warnings/.test(l)).join('\n'));
    process.exit(1);
  }
  if (result === 'slow') console.log(`The app is still starting; its log: ${logFile}`);
  server.unref();
  process.exit(0);
}
