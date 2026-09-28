// "Record flow": runs Playwright codegen (browser + Inspector) on the user's desktop. The user clicks through
// the flow and closes the window; the generated test script and the browser's login state are kept so the
// flow can be copied, saved as a test, or handed to the AI as a route map.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './history.mjs';
import { playwrightCli, stopChild } from './proc.mjs';

const root = join(import.meta.dirname, '..');
export const flowsDir = join(dataDir, 'flows');
const ID = /^flow-\d{8}-\d{6}$/;

let current = null; // one recording at a time: it is a window on the user's desktop

export const isRecording = () => Boolean(current);
export function stopRecording() { if (current) stopChild(current); } // on Windows also codegen's browser

// Values stored as secrets become {{NAME}}, so the script never carries them (saved tests read them from .env)
function withPlaceholders(script) {
  const secrets = Object.entries(process.env).filter(([k, v]) => k.startsWith('SECRET_') && v && v.length >= 4);
  return secrets.reduce((s, [k, v]) => s.split(v).join(`{{${k.slice(7)}}}`), script);
}

export function recordFlow(url, { sessionFile } = {}) {
  if (current) throw new Error('A recording is already open');
  mkdirSync(flowsDir, { recursive: true });
  const id = `flow-${new Date().toISOString().replace(/\D/g, '').slice(0, 14).replace(/^(\d{8})/, '$1-')}`;
  const script = join(flowsDir, `${id}.spec.ts`);
  const storage = join(flowsDir, `${id}.storage.json`);
  const args = ['codegen', url, '--target', 'playwright-test', '--output', script, '--save-storage', storage];
  if (sessionFile) args.push('--load-storage', sessionFile);
  const { command, args: cli } = playwrightCli(root);
  const child = current = spawn(command, [...cli, ...args], { cwd: root, stdio: 'ignore', env: process.env });
  const done = new Promise((resolve, reject) => {
    child.on('error', e => { current = null; reject(new Error(`Cannot start Playwright codegen: ${e.message}`)); });
    child.on('close', () => {
      current = null;
      const code = existsSync(script) ? withPlaceholders(readFileSync(script, 'utf8')) : '';
      if (!/\btest\(/.test(code) || !/await page\.(?!goto\()/.test(code)) return reject(new Error('Nothing was recorded. Click through the flow before closing the browser window.'));
      resolve({ id, script: code, hasSession: existsSync(storage) });
    });
  });
  return { id, done };
}

export function flowScript(id) {
  if (!ID.test(id ?? '')) throw new Error('Invalid flow id');
  const f = join(flowsDir, `${id}.spec.ts`);
  if (!existsSync(f)) throw new Error('Recorded flow not found');
  return withPlaceholders(readFileSync(f, 'utf8'));
}

export function flowStorage(id) {
  if (!ID.test(id ?? '')) throw new Error('Invalid flow id');
  const f = join(flowsDir, `${id}.storage.json`);
  if (!existsSync(f)) throw new Error('This recording has no saved login state');
  return readFileSync(f, 'utf8');
}
