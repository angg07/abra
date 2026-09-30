// The app in its own window: a Chromium-family browser in app mode (no tabs, no address bar) with a profile of
// its own, so it looks and behaves like a desktop app and never touches the user's browser. Closing the window
// quits the app. Without any such browser (first start, before Chromium is downloaded) the default browser opens.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const LINUX_NAMES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'microsoft-edge', 'brave-browser'];
const which = (name, env) => (env.PATH ?? '').split(delimiter).filter(Boolean).map(d => join(d, name)).find(existsSync);

// Installed Chrome / Edge / Chromium first (kept up to date by the system), then the Chromium the app downloaded
export function findAppBrowser({ platform = process.platform, env = process.env, bundled = '' } = {}) {
  const candidates = {
    win32: [
      join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
      join(env.ProgramFiles ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  }[platform];
  const system = candidates ? candidates.find(existsSync) : LINUX_NAMES.map(n => which(n, env)).find(Boolean);
  return system ?? (bundled && existsSync(bundled) ? bundled : null);
}

export const windowArgs = (url, profile) => [
  `--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1440,900',
  '--no-first-run', '--no-default-browser-check', '--class=abra', // Linux: its own taskbar entry
];

// the default browser, on each OS
export function openInBrowser(url) {
  const [cmd, args] = { win32: ['cmd', ['/c', 'start', '""', url]], darwin: ['open', [url]] }[process.platform] ?? ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' }).on('error', () => {}).unref(); } catch {}
}

// Opens the app window; onClose runs when the window is closed. Returns false when it fell back to the browser.
export function openAppWindow(url, { profile, bundled, onClose = () => {} }) {
  const exe = findAppBrowser({ bundled });
  if (!exe) { openInBrowser(url); return false; }
  // The downloaded Chromium has no sandbox rights on Ubuntu 23.10+ (AppArmor) and would not start; Playwright runs
  // it the same way. Fine here: the window only ever shows this app on 127.0.0.1. --test-type drops the warning bar.
  const extra = exe === bundled && process.platform === 'linux' ? ['--no-sandbox', '--test-type'] : [];
  const child = spawn(exe, [...windowArgs(url, profile), ...extra], { stdio: 'ignore' });
  const started = Date.now();
  child.on('error', () => openInBrowser(url));
  // gone within seconds: it did not start (or handed off): use the browser and keep the app running
  child.on('exit', () => (Date.now() - started < 3000 ? openInBrowser(url) : onClose()));
  return true;
}
