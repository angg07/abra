// Starts the real app on a spare port with a throwaway database; the caller stops it.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dirname, '..', '..', '..');

export async function startApp({ port, env = {} }) {
  const tmp = mkdtempSync(join(tmpdir(), 'abr-test-'));
  const server = spawn(process.execPath, ['app/server.mjs'], {
    cwd: root, env: { ...process.env, PORT: String(port), APP_DB: join(tmp, 'app.db'), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  server.stderr.on('data', d => { err += d; });
  await new Promise((ok, fail) => {
    server.stdout.on('data', d => String(d).includes('ABRA') && ok());
    server.on('exit', c => fail(new Error(`server exited ${c}: ${err.slice(-500)}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  // like a browser: open the page first, it hands out the cookie every API call needs
  const cookie = (await fetch(base + '/')).headers.get('set-cookie').split(';')[0];
  const req = (path, opts = {}) => fetch(base + path, { ...opts, headers: { cookie, ...(opts.body && { 'content-type': 'application/json' }), ...opts.headers } });
  const stop = () => { server.kill('SIGTERM'); rmSync(tmp, { recursive: true, force: true }); };
  return { base, req, stop, root, cookie, dbFile: join(tmp, 'app.db') };
}
