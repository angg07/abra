// npm run dist -- linux|win|mac (in desktop/): the desktop app for one OS. It puts the app's code and
// node_modules in payload/bundle/app-root (electron-builder would drop a node_modules at the root of a
// resource) and a Node for each CPU in payload/runtime-<os>-<arch>, then electron-builder
// packs them next to Electron (see "build" in package.json). macOS builds only on a Mac (.github/workflows).
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stageApp, fetchNode } from '../app/package.mjs';

const TARGETS = { linux: { os: 'linux', arches: ['x64'] }, win: { os: 'win32', arches: ['x64'] }, mac: { os: 'darwin', arches: ['x64', 'arm64'] } };
const which = process.argv[2];
const target = TARGETS[which];
if (!target) { console.error('Usage: npm run dist -- linux|win|mac'); process.exit(1); }

const here = import.meta.dirname, payload = join(here, 'payload');
rmSync(payload, { recursive: true, force: true });
const appRoot = join(payload, 'bundle', 'app-root');
mkdirSync(appRoot, { recursive: true });
console.log(`app: ${stageApp(appRoot)} files and node_modules`);
// a new build id makes an installed app copy its code into the user's folder again (main.cjs)
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
writeFileSync(join(appRoot, '.build-id'), `${commit}-${Date.now()}`);
for (const arch of target.arches) {
  await fetchNode(target.os, arch, process.version, join(payload, `runtime-${which}-${arch}`, target.os === 'win32' ? 'node.exe' : 'node'));
  console.log(`Node ${process.version} for ${which} ${arch}`);
}
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', `--${which}`, ...target.arches.map(a => `--${a}`), '--publish', 'never'], { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' });
