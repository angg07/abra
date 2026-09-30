// npm run package -- linux|win: a portable build in dist/ — Node itself, the app, its node_modules and a
// launcher, packed as .tar.gz (Linux) or .zip (Windows). Unpack, run start.sh / start.cmd, the app opens in the
// browser; the first-run screen downloads Chromium and lists what else this computer needs.
// Only files git would keep go in, committed or new (never .env, run history, recordings or your projects' tests).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, createWriteStream, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOW, OS_NAMES } from './setup.mjs';

const root = join(import.meta.dirname, '..');
export const TARGETS = {
  linux: { os: 'linux', node: 'node', archive: 'tar.gz' },
  win: { os: 'win32', node: 'node.exe', archive: 'zip' },
};
// tracked files that are not needed to run the app
export const shipped = file => !/^(docs\/|desktop\/|\.github\/|app\/test\/|\.gitignore$|app\/package\.mjs$)/.test(file);

const line = f => [f.note, f.cmd].filter(Boolean).join(': ');
export function installText(os) {
  const name = OS_NAMES[os];
  const start = os === 'win32' ? 'Double-click start.cmd' : 'Run ./start.sh (or double-click it and choose "Run")';
  return `ABRA (portable, ${name})
====================================

Start
-----
1. Unpack this folder anywhere you can write to (e.g. your home folder). Keep it: your projects, run
   history and videos are saved inside it.
2. ${start}. The app opens in its own window (Edge, Chrome or Chromium without tabs or address bar;
   before Chromium is downloaded, in your browser). It only listens on this computer (127.0.0.1:4321).
3. The first time, the "Before you start" screen checks this computer. Click "Download Chromium"
   (about 650 MB on disk, once), then Continue.

Node.js is included (runtime/): you do not need to install it.

Needed before the first use
---------------------------
Required
- Chromium: downloaded by the app on the first start (needs internet once).${os === 'linux' ? `
  If it does not start afterwards, install the system libraries it needs:
    sudo ./runtime/node node_modules/@playwright/test/cli.js install-deps chromium` : ''}
- An AI engine: Claude Code signed in with your subscription, or an API key (Anthropic, OpenAI, Gemini, ...)
  added in Settings > AI.
${HOW.claude[os].map(f => `    ${line(f)}`).join('\n')}

Optional
- ffmpeg with libx264: for videos of runs. Without it everything else works.
${HOW.ffmpeg[os].map(f => `    ${line(f)}`).join('\n')}

The same list, with Copy buttons, is under Requirements in the app's sidebar.

Stop
----
Close the app window: that stops the app. (Only when it opened in your browser instead, the
${os === 'win32' ? 'start.cmd window' : 'terminal of start.sh'} stays open: close it to stop the app.)
`;
}

const LAUNCHERS = {
  linux: ['start.sh', `#!/bin/sh
# ABRA: starts the app with the Node in runtime/ and opens it in the browser
cd "$(dirname "$0")" || exit 1
export PATH="$PWD/runtime:$PATH"
[ -f .env ] || printf '# API keys and secrets, written by the app (Settings). Keep this file private.\\n' > .env
# starts the app in the background (no terminal needed) and returns; see app/launch.mjs
exec ./runtime/node app/launch.mjs
`],
  win: ['start.cmd', `@echo off
rem ABRA: starts the app with the Node in runtime\\ and opens it in the browser
cd /d "%~dp0"
set "PATH=%~dp0runtime;%PATH%"
if not exist .env echo # API keys and secrets, written by the app (Settings). Keep this file private.> .env
title ABRA
rem starts the app in the background (no console window) and returns; see app\\launch.mjs
runtime\\node.exe app\\launch.mjs
if errorlevel 1 pause
`],
};

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed (${r.status}): ${url}`);
  const out = createWriteStream(file);
  for await (const chunk of r.body) out.write(chunk);
  await new Promise((ok, fail) => out.end(e => (e ? fail(e) : ok())));
}

// Node for an OS (linux, win32, darwin) and CPU (x64, arm64): this Node when it already is one, else nodejs.org
export async function fetchNode(os, arch, version, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  if (os === process.platform && arch === process.arch) { cpSync(process.execPath, dest); chmodSync(dest, 0o755); return; }
  const tmp = `${dest}.download`;
  if (os === 'win32') { await download(`https://nodejs.org/dist/${version}/win-${arch}/node.exe`, tmp); renameSync(tmp, dest); return; }
  const base = `node-${version}-${os}-${arch}`, xz = os === 'linux';
  await download(`https://nodejs.org/dist/${version}/${base}.tar.${xz ? 'xz' : 'gz'}`, tmp);
  const dir = `${dest}.x`; mkdirSync(dir, { recursive: true });
  execFileSync('tar', [xz ? '-xJf' : '-xzf', tmp, '-C', dir, '--strip-components=2', `${base}/bin/node`]);
  renameSync(join(dir, 'node'), dest); chmodSync(dest, 0o755); rmSync(dir, { recursive: true }); rmSync(tmp);
}

// The app itself into a folder: files git keeps (committed or new, never ignored ones) and node_modules
export function stageApp(out) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).filter(shipped);
  for (const f of files) { mkdirSync(dirname(join(out, f)), { recursive: true }); cpSync(join(root, f), join(out, f)); }
  if (!existsSync(join(root, 'node_modules'))) throw new Error('Run npm install first');
  // ponytail: node_modules is copied as it is here; it is plain JavaScript (no native addons), so it runs on
  // any OS. Switch to a clean `npm ci` in the build folder if a native dependency is ever added.
  // verbatimSymlinks: node_modules/.bin links stay relative; resolved, they point at this computer and macOS refuses the app
  cpSync(join(root, 'node_modules'), join(out, 'node_modules'), { recursive: true, verbatimSymlinks: true, filter: src => !/[\\/]\.cache([\\/]|$)/.test(src) });
  return files.length;
}

async function main() {
  const which = process.argv[2];
  const target = TARGETS[which];
  if (!target) { console.error('Usage: npm run package -- linux|win'); process.exit(1); }
  const version = process.version;
  const name = `abra-${which}-x64`;
  const dist = join(root, 'dist'), out = join(dist, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  console.log(`app: ${stageApp(out)} files and node_modules`);
  await fetchNode(target.os, 'x64', version, join(out, 'runtime', target.node));
  console.log(`Node ${version} for ${OS_NAMES[target.os]}`);

  const [launcher, script] = LAUNCHERS[which];
  writeFileSync(join(out, launcher), which === 'win' ? script.replace(/\n/g, '\r\n') : script);
  if (which === 'linux') chmodSync(join(out, launcher), 0o755);
  const install = installText(target.os);
  writeFileSync(join(out, 'INSTALL.txt'), which === 'win' ? install.replace(/\n/g, '\r\n') : install);

  const archive = join(dist, `${name}.${target.archive}`);
  rmSync(archive, { force: true });
  if (target.archive === 'zip') execFileSync('zip', ['-qr', '-9', archive, name], { cwd: dist });
  else execFileSync('tar', ['-czf', archive, name], { cwd: dist });
  console.log(`\n${archive}`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(e => { console.error(e.message); process.exit(1); });
