// npm run setup: checks what the app needs on this computer and installs the browsers. ❌ stops (exit 1),
// ⚠️ is a feature that will not work until fixed. Importing the file (tests) runs nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const nodeOk = (version, floor = '22.13.0') => {
  const a = version.replace(/^v/, '').split('.').map(Number), b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
export const hasLibx264 = out => /^\s*V\S*\s+libx264\b/m.test(out);

const HOW = {
  node: { win32: 'winget install OpenJS.NodeJS.LTS', darwin: 'brew install node', linux: 'https://nodejs.org (or your package manager)' },
  ffmpeg: { win32: 'winget install ffmpeg', darwin: 'brew install ffmpeg', linux: 'sudo apt install ffmpeg' },
};
const how = what => HOW[what][process.platform] ?? HOW[what].linux;

function main() {
  const root = join(import.meta.dirname, '..');
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  let failed = false;
  const ok = m => console.log(`✅ ${m}`), warn = m => console.log(`⚠️  ${m}`), bad = m => { console.log(`❌ ${m}`); failed = true; };

  if (nodeOk(process.version)) ok(`Node ${process.version}`); else bad(`Node ${process.version} is too old: 22.13 or newer is needed. Install: ${how('node')}`);

  // Two Playwright copies need their own Chromium: the test runner's and Playwright MCP's
  for (const [label, cli] of [['test runner', 'node_modules/@playwright/test/cli.js'], ['AI browser (Playwright MCP)', 'node_modules/@playwright/mcp/node_modules/playwright/cli.js']]) {
    if (!existsSync(join(root, cli))) { bad(`${label}: ${cli} is missing. Run npm install first.`); continue; }
    const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { cwd: root, stdio: 'inherit' });
    if (r.status === 0) ok(`Chromium for the ${label}`);
    else bad(`Chromium for the ${label} did not install.${process.platform === 'linux' ? ' Missing system libraries? Run: sudo npx playwright install-deps chromium' : ''}`);
  }

  const ff = run(process.env.FFMPEG ?? 'ffmpeg', ['-hide_banner', '-encoders']);
  if (ff.status === 0 && hasLibx264(ff.stdout)) ok('ffmpeg with libx264 (videos)');
  else warn(`ffmpeg with libx264 not found: runs work, videos will not. Install: ${how('ffmpeg')}`);

  const claude = run('claude', ['--version']);
  if (claude.status === 0) ok(`Claude Code ${claude.stdout.trim()}`);
  else warn('Claude Code not found: install it (https://claude.com/claude-code) and sign in, or add an API key in Settings → AI.');

  const env = join(root, '.env');
  if (!existsSync(env)) { writeFileSync(env, '# API keys and secrets, written by the app (Settings). Never commit this file.\n'); ok('.env created'); }

  console.log(failed ? '\nFix the ❌ items, then run npm run setup again.' : '\nReady: npm run app');
  process.exit(failed ? 1 : 0);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
