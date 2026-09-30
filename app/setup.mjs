// What the app needs on this computer, per OS. Used by the first-run screen (GET /setup/status) and by
// `npm run setup` (which also installs the browsers). bad = the app cannot run; warn = one feature will not work.
// Importing the file (tests, server) runs nothing.
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const nodeOk = (version, floor = '22.13.0') => {
  const a = version.replace(/^v/, '').split('.').map(Number), b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
export const hasLibx264 = out => /^\s*V\S*\s+libx264\b/m.test(out);

export const OS_NAMES = { linux: 'Linux', win32: 'Windows', darwin: 'macOS' };
const osOf = platform => (OS_NAMES[platform] ? platform : 'linux');

// How to install each thing, per OS (the first-run screen and INSTALL.txt): { note?, cmd? } lines
export const HOW = {
  node: {
    linux: [{ note: 'From https://nodejs.org, or Ubuntu 24.10+:', cmd: 'sudo apt install nodejs' }],
    win32: [{ cmd: 'winget install OpenJS.NodeJS.LTS' }],
    darwin: [{ cmd: 'brew install node' }],
  },
  ffmpeg: {
    linux: [{ note: 'Ubuntu / Debian', cmd: 'sudo apt install ffmpeg' }, { note: 'Fedora (RPM Fusion)', cmd: 'sudo dnf install ffmpeg' }, { note: 'Arch', cmd: 'sudo pacman -S ffmpeg' }],
    win32: [{ note: 'In a terminal', cmd: 'winget install Gyan.FFmpeg' }, { note: 'Then close and reopen the app, so it sees the new PATH.' }],
    darwin: [{ cmd: 'brew install ffmpeg' }],
  },
  claude: {
    linux: [{ cmd: 'curl -fsSL https://claude.ai/install.sh | bash' }, { note: 'Then run it once to sign in', cmd: 'claude' }],
    win32: [{ note: 'In PowerShell', cmd: 'irm https://claude.ai/install.ps1 | iex' }, { note: 'Then run it once to sign in', cmd: 'claude' }],
    darwin: [{ cmd: 'curl -fsSL https://claude.ai/install.sh | bash' }, { note: 'Then run it once to sign in', cmd: 'claude' }],
  },
  // Chromium itself is downloaded by the app; Linux may also need the system libraries it uses
  chromiumDeps: { linux: [{ note: 'If Chromium still does not start, install the system libraries it needs', cmd: 'sudo "{node}" "{cli}" install-deps chromium' }], win32: [], darwin: [] },
};

// The two Playwright copies (the test runner's and Playwright MCP's) and their CLIs
export const playwrights = root => (root = resolve(root), [
  { id: 'chromium-tests', label: 'Chromium for replaying saved tests', pkg: join(root, 'node_modules/@playwright/test/package.json'), cli: join(root, 'node_modules/@playwright/test/cli.js') },
  { id: 'chromium-ai', label: 'Chromium for AI runs', pkg: join(root, 'node_modules/@playwright/mcp/node_modules/playwright/package.json'), cli: join(root, 'node_modules/@playwright/mcp/node_modules/playwright/cli.js') },
]);
const chromiumPath = pkg => { try { return createRequire(pkg)('playwright-core').chromium.executablePath(); } catch { return ''; } };

// [{ id, label, status: 'ok' | 'warn' | 'bad', detail, fix: [lines for this OS], action? }]
export async function checkRequirements({ root, platform = process.platform, run = defaultRun(root), nodeVersion = process.version, nodePath = process.execPath } = {}) {
  const os = osOf(platform);
  const out = [];
  out.push(nodeOk(nodeVersion)
    ? { id: 'node', label: 'Node.js', status: 'ok', detail: nodeVersion, fix: [] }
    : { id: 'node', label: 'Node.js', status: 'bad', detail: `${nodeVersion} is too old: 22.13 or newer is needed`, fix: HOW.node[os] });
  // Chromium: one download serves both Playwright copies (the test runner's and Playwright MCP's)
  const pws = playwrights(root);
  const deps = HOW.chromiumDeps[os].map(l => ({ ...l, cmd: l.cmd.replace('{node}', nodePath).replace('{cli}', pws[0].cli) }));
  const chromium = { id: 'chromium', label: 'Chromium (the browser for tests and AI runs)' };
  const exes = pws.map(pw => existsSync(pw.cli) && chromiumPath(pw.pkg));
  if (exes.some(e => e === false)) out.push({ ...chromium, status: 'bad', detail: 'The app\'s files are incomplete (node_modules is missing): run npm install, or unpack the app again', fix: [] });
  else if (exes.some(e => !e || !existsSync(e))) out.push({ ...chromium, status: 'bad', detail: 'Not downloaded yet: about 650 MB on disk, once', fix: [], action: 'browsers' });
  else {
    // Linux: downloaded, but the system may lack the libraries Chromium needs
    const lddOut = os === 'linux' ? await Promise.all(exes.map(e => run('ldd', [e]))) : [];
    const missing = [...new Set(lddOut.flatMap(r => [...(r.stdout ?? '').matchAll(/^\s*(\S+) => not found/gm)].map(m => m[1])))];
    out.push(missing.length
      ? { ...chromium, status: 'bad', detail: `Downloaded, but system libraries are missing: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}`, fix: deps }
      : { ...chromium, status: 'ok', detail: 'Downloaded', fix: [] });
  }
  const [ff, claude] = await Promise.all([run(process.env.FFMPEG ?? 'ffmpeg', ['-hide_banner', '-encoders']), run('claude', ['--version'])]);
  out.push(ff.status === 0 && hasLibx264(ff.stdout)
    ? { id: 'ffmpeg', label: 'ffmpeg (videos)', status: 'ok', detail: 'With libx264', fix: [] }
    : { id: 'ffmpeg', label: 'ffmpeg (videos)', status: 'warn', detail: ff.status === 0 ? 'Found, but without libx264: videos will not be recorded' : 'Not found: runs work, videos will not be recorded', fix: HOW.ffmpeg[os] });
  out.push(claude.status === 0
    ? { id: 'claude', label: 'Claude Code (AI engine)', status: 'ok', detail: claude.stdout.trim(), fix: [] }
    : { id: 'claude', label: 'Claude Code (AI engine)', status: 'warn', detail: 'Not found: install it and sign in, or add an API key in Settings › AI instead', fix: HOW.claude[os] });
  return out;
}
// { status, stdout } like spawnSync, without blocking the server while it waits
function defaultRun(root) {
  return (cmd, args) => new Promise(done => execFile(cmd, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', timeout: 15_000, maxBuffer: 4 << 20 },
    (err, stdout) => done({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '' })));
}

// Downloads Chromium for both Playwright copies; onLine gets the installer's output. Resolves true when both worked.
export async function installBrowsers(root, onLine = () => {}, { spawnFn } = {}) {
  const { spawn } = await import('node:child_process');
  let ok = true;
  for (const pw of playwrights(root)) {
    onLine(`${pw.label}…`);
    const code = await new Promise(resolve => {
      const p = (spawnFn ?? spawn)(process.execPath, [pw.cli, 'install', 'chromium'], { cwd: root });
      // no terminal colours; a progress bar becomes "↓ 40% of 114.3 MiB" (the screen keeps only the latest)
      const pipe = d => String(d).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n|\r/).map(l => l.trim()).filter(Boolean)
        .map(l => l.match(/^\|[^|]*\|\s*(\d+%.*)$/)?.[1] ? `↓ ${l.match(/(\d+%.*)$/)[1]}` : l).forEach(onLine);
      p.stdout?.on('data', pipe); p.stderr?.on('data', pipe);
      p.on('error', e => { onLine(e.message); resolve(1); });
      p.on('close', resolve);
    });
    if (code !== 0) { ok = false; onLine(`${pw.label}: the download failed (exit ${code})`); }
  }
  return ok;
}

async function main() {
  const root = join(import.meta.dirname, '..');
  console.log(`Checking this computer (${OS_NAMES[process.platform] ?? process.platform})\n`);
  let items = await checkRequirements({ root });
  if (items.some(i => i.action === 'browsers')) {
    await installBrowsers(root, line => console.log(`   ${line}`));
    items = await checkRequirements({ root });
  }
  const icon = { ok: '✅', warn: '⚠️ ', bad: '❌' };
  for (const i of items) {
    console.log(`${icon[i.status]} ${i.label}: ${i.detail}`);
    for (const f of i.fix) console.log(`      ${[f.note, f.cmd].filter(Boolean).join(': ')}`);
  }
  const env = join(root, '.env');
  if (!existsSync(env)) { writeFileSync(env, '# API keys and secrets, written by the app (Settings). Never commit this file.\n'); console.log('✅ .env created'); }
  const failed = items.some(i => i.status === 'bad');
  console.log(failed ? '\nFix the ❌ items, then run npm run setup again.' : '\nReady: npm run app');
  process.exit(failed ? 1 : 0);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
