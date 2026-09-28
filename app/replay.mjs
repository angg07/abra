// Replays saved tests with the regular Playwright test runner (no AI). One file = a replay, several = a suite.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { REPLAY_CDP_PORT } from './stage.mjs';
import { dataDir } from './history.mjs';

const root = join(import.meta.dirname, '..');
const bin = join(root, 'node_modules', '.bin', 'playwright');

// Flatten Playwright's nested JSON report into one row per test
function results(report, dataRows = 0) {
  const rows = [];
  const walk = s => {
    for (const spec of s.specs ?? []) for (const t of spec.tests ?? []) {
      const r = t.results?.at(-1) ?? {};
      rows.push({
        file: basename(spec.file), // the project is known; the file name is what the app matches on
        title: spec.title, status: r.status ?? 'skipped', ms: r.duration ?? 0,
        error: r.error?.message?.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000),
        // toHaveScreenshot mismatch: Playwright attaches the baseline, the new screen and the difference
        images: (r.attachments ?? []).filter(a => a.path && /-(expected|actual|diff)\.png$/.test(a.name)).map(a => ({ kind: a.name.match(/-(expected|actual|diff)\.png$/)[1], name: a.name, path: a.path })),
      });
    }
    (s.suites ?? []).forEach(walk);
  };
  (report.suites ?? []).forEach(walk);
  // A test that appears several times was repeated: repeat i used data row i % dataRows (see tests/support/vars.ts)
  const seen = new Map(), total = new Map();
  for (const r of rows) total.set(`${r.file}|${r.title}`, (total.get(`${r.file}|${r.title}`) ?? 0) + 1);
  for (const r of rows) {
    const k = `${r.file}|${r.title}`;
    if (total.get(k) < 2) continue;
    const i = seen.get(k) ?? 0; seen.set(k, i + 1);
    if (dataRows > 1) r.row = (i % dataRows) + 1;
    if (total.get(k) > Math.max(1, dataRows)) r.attempt = Math.floor(i / Math.max(1, dataRows)) + 1;
  }
  return rows;
}

// Test code runs here, so it gets only what its project may use: that project's secrets, no other secrets,
// database passwords or AI keys. ponytail: this stops casual reads, not a test that opens .env by path;
// separating users for real means running the runner as another OS user or in a container.
function runnerEnv(secrets, apiKeyEnvs) {
  const allowed = new Set(secrets.map(n => `SECRET_${n}`));
  return Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    allowed.has(k) || !(/^(SECRET_|DBPASS_)/.test(k) || /(_API_KEY|_TOKEN|_PASSWORD)$/.test(k) || apiKeyEnvs.includes(k))));
}

// onStep gets each action from steps-reporter.cjs; onLine gets the rest of the runner output
export function runTests(files, { width, height, device, sessionFile, testDir, vars = {}, envName = '', repeatEach = 1, dataRows = 0, updateSnapshots = false, slowMo = 250, testDataDir, dbUrl, secrets = [], apiKeyEnvs = [] }, { onLine, onStep }, signal) {
  const reportFile = join(dataDir, `replay-${Date.now()}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['test', ...files.map(f => relative(root, f)), '--config', 'app/replay.config.ts', ...(repeatEach > 1 ? ['--repeat-each', String(repeatEach)] : []), ...(updateSnapshots ? ['--update-snapshots'] : [])], {
      cwd: root,
      detached: true, // own process group, so Stop can kill the runner and its browser together
      env: {
        ...runnerEnv(secrets, apiKeyEnvs), FORCE_COLOR: '0', E2E_APP: '1', // E2E_APP: playwright.config.ts does not load .env
        REPLAY_W: String(width), REPLAY_H: String(height), REPLAY_DEVICE: device ?? '', REPLAY_CDP_PORT: String(REPLAY_CDP_PORT),
        REPLAY_REPORT: reportFile, REPLAY_SLOWMO: String(slowMo), REPLAY_STORAGE: sessionFile ?? '', REPLAY_TESTDIR: testDir ?? '',
        E2E_VARS: JSON.stringify(vars), E2E_ENV: envName, E2E_DATA_DIR: testDataDir ?? '', // tests/support/vars.ts; empty = the data/ folder next to the test
        E2E_DB_URL: dbUrl ?? '', // tests/support/db.ts: the project's database in this environment
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    signal.addEventListener('abort', () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} });
    let buf = '';
    const onData = d => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        if (l.startsWith('@@STEP ')) { try { onStep(JSON.parse(l.slice(7))); } catch {} }
        else if (l.trim()) onLine(l.replace(/\x1b\[[0-9;]*m/g, ''));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', () => {
      try {
        const tests = results(JSON.parse(readFileSync(reportFile, 'utf8')), dataRows);
        rmSync(reportFile, { force: true });
        resolve({ tests, ok: tests.length > 0 && tests.every(t => t.status === 'passed') });
      } catch {
        reject(new Error(signal.aborted ? 'Stopped' : 'Playwright produced no report. Check the log above.'));
      }
    });
  });
}
