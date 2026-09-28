import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playwrightCli, killTree, spawnOptions, shellArgs, stopChild } from '../proc.mjs';

test('playwrightCli runs the test runner through node, on every OS', () => {
  const c = playwrightCli('/app');
  assert.equal(c.command, process.execPath);
  assert.match(c.args[0].replaceAll('\\', '/'), /\/app\/node_modules\/@playwright\/test\/cli\.js$/);
});

test('killTree: taskkill /T /F on Windows, the process group elsewhere', () => {
  const calls = [];
  killTree(42, { platform: 'win32', run: (cmd, args) => calls.push([cmd, ...args]), kill: () => calls.push(['kill']) });
  assert.deepEqual(calls, [['taskkill', '/pid', '42', '/T', '/F']]);
  calls.length = 0;
  killTree(42, { platform: 'linux', run: () => calls.push(['run']), kill: (pid, sig) => calls.push(['kill', pid, sig]) });
  assert.deepEqual(calls, [['kill', -42, 'SIGTERM']]);
  assert.doesNotThrow(() => killTree(42, { platform: 'linux', kill: () => { throw new Error('ESRCH'); } }));
});

test('spawnOptions: a shell only on Windows (claude is claude.cmd there)', () => {
  assert.deepEqual(spawnOptions('win32'), { shell: true });
  assert.deepEqual(spawnOptions('darwin'), {});
});

test('shellArgs: on Windows every argument is quoted, so empty values and paths with spaces survive cmd.exe', () => {
  assert.deepEqual(shellArgs(['--tools', '', '--mcp-config', 'C:\\Users\\First Last\\mcp.json', 'a"b'], 'win32'),
    ['"--tools"', '""', '"--mcp-config"', '"C:\\Users\\First Last\\mcp.json"', '"a""b"']);
  assert.deepEqual(shellArgs(['--tools', ''], 'linux'), ['--tools', '']); // no shell elsewhere: passed as is
});

test('stopChild: the whole tree on Windows (the shell is only the parent), a plain kill elsewhere', () => {
  const calls = [];
  const child = { pid: 7, kill: () => calls.push('kill') };
  stopChild(child, { platform: 'win32', run: (cmd, args) => calls.push([cmd, ...args].join(' ')) });
  assert.deepEqual(calls, ['taskkill /pid 7 /T /F']);
  calls.length = 0;
  stopChild(child, { platform: 'linux', run: () => calls.push('run') });
  assert.deepEqual(calls, ['kill']);
});
