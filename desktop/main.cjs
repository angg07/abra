// ABRA as a desktop app. Electron only draws the window: the app itself is the same server as the
// portable build, run by the Node shipped in resources/runtime. Its code is copied into the user's data folder
// (the install folder may be read-only), where the user's projects, history, videos, settings and .env live too;
// an update replaces the code and never those.
const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

// AppImage on Ubuntu 23.10+ has no sandbox rights (AppArmor) and would not start; the window only shows this app
if (process.platform === 'linux' && process.env.APPIMAGE) app.commandLine.appendSwitch('no-sandbox');
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

const osDir = { win32: 'win', darwin: 'mac' }[process.platform] ?? 'linux';
const packaged = app.isPackaged;
// packaged: resources/bundle/app-root and resources/runtime. From source (npm start in desktop/): the repository itself.
const payload = packaged ? path.join(process.resourcesPath, 'bundle', 'app-root') : null;
const home = packaged ? path.join(app.getPath('userData'), 'app') : path.join(__dirname, '..');
// ponytail: up to 1.0.x the app was called "AI Browser Runner"; its data folder moves once to the new name
if (packaged) {
  const before = path.join(app.getPath('appData'), 'AI Browser Runner', 'app');
  if (fs.existsSync(before) && !fs.existsSync(home)) { fs.mkdirSync(path.dirname(home), { recursive: true }); fs.renameSync(before, home); }
}
const nodeBin = packaged ? path.join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : 'node';

// the user's own files: kept when a new version's code is copied in
const KEEP = [/^app[\\/](data|recordings|guides)([\\/]|$)/, /^app[\\/](settings|providers)\.json$/, /^tests[\\/](?!support([\\/]|$))/, /^\.env/];
function installCode() {
  const want = fs.readFileSync(path.join(payload, '.build-id'), 'utf8');
  const stamp = path.join(home, '.build-id');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) return;
  fs.mkdirSync(home, { recursive: true });
  fs.cpSync(payload, home, {
    recursive: true, force: true, verbatimSymlinks: true, // keep node_modules/.bin links relative: absolute ones point into the installer (and macOS refuses them)
    filter: src => { const rel = path.relative(payload, src); return !rel || !KEEP.some(re => re.test(rel)) || !fs.existsSync(path.join(home, rel)); },
  });
}

// Started from the dock or a desktop menu, the app gets a bare PATH (macOS: /usr/bin:/bin...): claude and ffmpeg
// installed with Homebrew or in ~/.local/bin would not be found. The login shell knows the real one.
function loginShellPath() {
  if (process.platform === 'win32') return;
  const sh = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const r = spawnSync(sh, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: 'utf8', timeout: 5000 });
  const found = r.stdout?.match(/__PATH__(.*)__PATH__/)?.[1];
  if (found) process.env.PATH = [...new Set([...found.split(':'), ...(process.env.PATH ?? '').split(':')])].filter(Boolean).join(':');
}

const freePort = () => new Promise((ok, fail) => {
  const s = net.createServer();
  s.on('error', fail);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

let win, server, origin;
const logFile = () => path.join(home, 'app', 'data', 'app.log');
const tail = () => { try { return fs.readFileSync(logFile(), 'utf8').split('\n').filter(l => l && !/ExperimentalWarning|trace-warnings/.test(l)).slice(-12).join('\n'); } catch { return ''; } };
const showError = (title, detail) => win?.loadFile(path.join(__dirname, 'loading.html'), { hash: `error=${encodeURIComponent(`${title}\n\n${detail}`)}` });

async function startServer() {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  fs.mkdirSync(path.dirname(logFile()), { recursive: true });
  const log = fs.openSync(logFile(), 'a');
  if (!fs.existsSync(path.join(home, '.env'))) fs.writeFileSync(path.join(home, '.env'), '# API keys and secrets, written by the app (Settings). Keep this file private.\n');
  server = spawn(nodeBin, [path.join(home, 'app', 'server.mjs')], {
    // stdin: a pipe nobody writes to; the server stops when it closes, i.e. when this process is gone however it went
    cwd: home, windowsHide: true, stdio: ['pipe', log, log],
    env: { ...process.env, PORT: String(port), ABR_PORTABLE: '1', ABR_DESKTOP: '1', ABR_EXIT_WITH_STDIN: '1', ABR_VERSION: app.getVersion() },
  });
  const exited = new Promise(resolve => server.on('exit', code => resolve(code ?? 1)));
  server.on('error', e => showError('The app could not start', e.message));
  for (let t0 = Date.now(); Date.now() - t0 < 60_000;) {
    const up = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false);
    if (up) return true;
    const code = await Promise.race([exited, new Promise(r => setTimeout(r, 300, null))]);
    if (code !== null) { showError('The app stopped while starting', tail()); return false; }
  }
  showError('The app is taking too long to start', tail());
  return false;
}

function stopServer() {
  if (!server || server.exitCode !== null) return;
  // Windows: the runs it started (Playwright, claude, browsers) go with it
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true });
  else server.kill();
}

// Report a problem (preload.cjs): a screenshot of the window, and opening a report's folder; only folders under
// the app's reports folder, so the page cannot ask Electron to open anything else
const reportsDir = path.join(home, 'app', 'data', 'reports');
ipcMain.handle('abra:capture', async e => (await e.sender.capturePage()).toDataURL());
ipcMain.handle('abra:show-folder', async (e, folder) => {
  const p = path.resolve(String(folder ?? ''));
  if (!p.startsWith(reportsDir + path.sep)) return 'not a report folder';
  return shell.openPath(p);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, show: false, title: 'ABRA',
    backgroundColor: '#0B0D10', autoHideMenuBar: true,
    ...(process.platform === 'linux' && { icon: path.join(__dirname, 'build', 'icon.png') }),
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.once('ready-to-show', () => win.show());
  // PDF guides, reports: a window of the app (it has the page's cookie); anything else: the user's browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (origin && url.startsWith(`${origin}/`)) return { action: 'allow', overrideBrowserWindowOptions: { width: 1000, height: 900, autoHideMenuBar: true, webPreferences: { plugins: true } } };
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:') || (origin && url.startsWith(`${origin}/`))) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  // the page asks before closing during a run (beforeunload); Electron needs the question asked here
  win.webContents.on('will-prevent-unload', e => {
    const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Stop the run and close', 'Keep the app open'], defaultId: 1, cancelId: 1, message: 'A run is still going.', detail: 'Closing the app stops it.' });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, 'loading.html'));
}

// Updates come from the releases of github.com/angg07/abra. Windows and Linux: downloaded in the background and
// installed when the app closes, or right away if the user says so. macOS: installing an update needs an app
// signed by an Apple developer (this one is signed ad hoc), so it only says a new version is out.
const RELEASES = 'https://github.com/angg07/abra/releases/latest';
const newer = (a, b) => { const [x, y] = [a, b].map(v => v.replace(/^v/, '').split('.').map(Number)); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] || 0) > (y[i] || 0); return false; };
const logUpdate = msg => { try { fs.appendFileSync(logFile(), `${new Date().toISOString()} update: ${msg}\n`); } catch {} };
// deb: dpkg runs as root through pkexec. Started by the app, it sits in the app's systemd scope; the package
// reloads the app's AppArmor profile, the app ends, systemd kills the rest of the scope and dpkg stops halfway,
// leaving a package that will not start (seen on 1.1.2 -> 1.1.3). So it runs in a scope of its own.
// Without systemd, electron-updater installs it as before.
const debInstall = process.platform === 'linux' && !process.env.APPIMAGE && spawnSync('systemd-run', ['--version'], { timeout: 3000 }).status === 0;
let pendingDeb = null;
function installDeb(file, reopen) {
  const cmd = `pkexec dpkg -i "$1"${reopen ? ' && exec /usr/bin/abra' : ''}`;
  spawn('systemd-run', ['--user', '--scope', '--collect', '--quiet', '/bin/sh', '-c', cmd, 'sh', file], { detached: true, stdio: 'ignore' }).unref();
  logUpdate(`installing ${path.basename(file)} in its own scope`);
}
async function checkUpdates() {
  try {
    if (process.platform === 'darwin') {
      const r = await fetch('https://api.github.com/repos/angg07/abra/releases/latest', { headers: { accept: 'application/vnd.github+json' } });
      const tag = r.ok ? (await r.json()).tag_name : null;
      if (!tag || !newer(tag, app.getVersion())) return;
      const choice = await dialog.showMessageBox(win, { type: 'info', buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1, message: `ABRA ${tag.replace(/^v/, '')} is out`, detail: `You have ${app.getVersion()}. Download the new dmg and drag it to Applications: your projects and history stay.` });
      if (choice.response === 0) shell.openExternal(RELEASES);
      return;
    }
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = { info: logUpdate, warn: logUpdate, error: logUpdate, debug: () => {} };
    if (debInstall) autoUpdater.autoInstallOnAppQuit = false; // installDeb does it, at quit (will-quit below)
    if (!autoUpdater.listenerCount('update-downloaded')) autoUpdater.on('update-downloaded', async info => {
      if (debInstall) pendingDeb = info.downloadedFile;
      const choice = await dialog.showMessageBox(win, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1, message: `ABRA ${info.version} is ready`, detail: 'Restart to use it, or keep working: it installs when you close the app. Your projects and history stay.' });
      if (choice.response !== 0) return;
      if (!debInstall) return autoUpdater.quitAndInstall();
      installDeb(info.downloadedFile, true); pendingDeb = null; app.quit();
    });
    await autoUpdater.checkForUpdates();
  } catch (e) { logUpdate(e.message); } // offline or GitHub down: try again later
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit()); // on macOS too: the app is its window
app.on('will-quit', () => { stopServer(); if (pendingDeb) installDeb(pendingDeb, false); });

app.whenReady().then(async () => {
  createWindow();
  loginShellPath();
  try { if (packaged) installCode(); }
  catch (e) { showError('The app could not be prepared', e.message); return; }
  if (await startServer()) win?.loadURL(`${origin}/`);
  if (packaged) { checkUpdates(); setInterval(checkUpdates, 6 * 3600_000); }
});
