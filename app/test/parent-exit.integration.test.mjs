// The desktop app's server exits when the window process is gone, however it went (killed, crashed, or ended by
// an AppArmor profile reload during a package install): its stdin pipe from the window closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('the server stops when its parent closes the stdin pipe', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'abr-test-'));
  const server = spawn(process.execPath, ['app/server.mjs'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: { ...process.env, PORT: '4399', APP_DB: join(tmp, 'app.db'), ABR_EXIT_WITH_STDIN: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', d => { out += d; });
  const exited = new Promise(resolve => server.on('exit', code => resolve(code)));
  try {
    await new Promise((ok, fail) => { server.stdout.on('data', () => out.includes('ABRA') && ok()); exited.then(c => fail(new Error(`exited ${c} while starting`))); });
    server.stdin.end(); // what the OS does when the window process dies
    const code = await Promise.race([exited, new Promise(r => setTimeout(r, 10_000, 'still running'))]);
    assert.equal(code, 0);
    assert.match(out, /Stopped \(window gone\)/);
  } finally {
    server.kill('SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
  }
});
