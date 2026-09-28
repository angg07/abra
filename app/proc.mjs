// What differs between Windows and macOS/Linux when the app starts or stops other programs.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// node_modules/.bin/playwright is a shell script (a .cmd on Windows): run the CLI file with node instead
export const playwrightCli = root => ({ command: process.execPath, args: [join(root, 'node_modules', '@playwright', 'test', 'cli.js')] });

// Stop a runner and the browser it started. Windows has no process groups: taskkill /T ends the whole tree.
export function killTree(pid, { platform = process.platform, run = spawnSync, kill = process.kill } = {}) {
  try {
    if (platform === 'win32') run('taskkill', ['/pid', String(pid), '/T', '/F']);
    else kill(-pid, 'SIGTERM');
  } catch {} // already gone
}

// npm-installed commands (claude) are .cmd shims on Windows, which spawn only finds through a shell
export const spawnOptions = (platform = process.platform) => (platform === 'win32' ? { shell: true } : {});

// With a shell, Node joins the arguments with spaces and escapes nothing: quote each one for cmd.exe so an empty
// value ('') stays an argument and a path with spaces stays one. Only fixed flags and paths go through here;
// free text (the prompt) goes on stdin. ponytail: "%VAR%" would still expand; no such argument is passed.
export const shellArgs = (args, platform = process.platform) => (platform === 'win32' ? args.map(a => `"${String(a).replace(/"/g, '""')}"`) : args);

// Stop a child started with spawnOptions(): on Windows that child is cmd.exe, so end the tree under it
export function stopChild(child, { platform = process.platform, run = spawnSync } = {}) {
  if (platform === 'win32') killTree(child.pid, { platform, run });
  else child.kill();
}
