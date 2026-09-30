import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, createReadStream, readdirSync, unlinkSync, rmSync, copyFileSync, appendFileSync, renameSync } from 'node:fs';
import { format } from 'node:util';
import { join, relative } from 'node:path';
import { engines } from './agents.mjs';
import { createStage, portAnswers } from './stage.mjs';
import { createPortPool, createLimiter, mcpServerFor, idleToClose } from './runs.mjs';
import { packProject, unpackBundle, missingVars, packAll, unpackAll, isAll } from './bundle.mjs';
import { resolveConfigDir, claudeAccount } from './claude-config.mjs';
import { devices as playwrightDevices, chromium as bundledChromium } from 'playwright-core';
import { openAppWindow } from './window.mjs';
import { listTests, readTest, saveTest, deleteTest, testPath, slug, prepareScript, withPlaceholders, readData, saveData, testsDir, projectDir, listProjects, readProject, projectLogoDataUrl, saveProjectLogo, deleteProjectLogo, saveProject, deleteProject, listFolders, listWorkflows, readWorkflow, saveWorkflow, deleteWorkflow } from './library.mjs';
import varsCore from './vars-core.cjs';
import guard from './guard.cjs';
const { makeResolver, parseCsv, secretsFromEnv } = varsCore;
import { runTests } from './replay.mjs';
import { addRun, getRun, listRuns, patchRun, removeRuns, runOfFile, dataDir } from './history.mjs';
import { buildReport } from './report.mjs';
import { pruneDir, pruneFolders } from './housekeeping.mjs';
import { dueSchedules, validSchedules, scheduleState, DAYS } from './scheduler.mjs';
import { notify, summary } from './notify.mjs';
import { ciWorkflow } from './ci.mjs';
import { recordFlow, stopRecording, isRecording, flowScript, flowStorage } from './recorder.mjs';
import { splitAnswer, flakyOf, expectedVerdict, isAppError } from './shared.mjs';
import { checkRequirements, installBrowsers, OS_NAMES } from './setup.mjs';
import { spawn } from 'node:child_process';
import { aiStep, replayStep, guideCollector, buildGuidePdf, secretMasker, runTitle, entersValue, guideFolder, readGuideDoc, cleanGuideDoc, renderGuidePdf, FRAME_FILE, frameType, guideFrames, addGuideFrame, pruneGuideFrames } from './guide.mjs';
import { finishVideo } from './video.mjs';
import { GUIDE_LANGS, guideLabels, translateStep } from './guide-i18n.mjs';
import { validWorkflow, fillRefs, loopItems, blockPrompt, readAnswer, SYSTEM as WF_SYSTEM } from './workflow.mjs';

const dir = import.meta.dirname;
const ports = createPortPool(9400, 9499, portAnswers); // browser debugging ports for runs
const envPath = join(dir, '..', '.env');
const providersPath = join(dir, 'providers.json');
const recordingsDir = join(dir, 'recordings');
const guidesDir = join(dir, 'guides');
const sessionsDir = join(dataDir, 'sessions');
const visualDir = join(dataDir, 'visual');
const logoFile = join(dataDir, 'branding', 'logo');

// Everything the server prints also lands in app/data/server.log: after the terminal is gone you can still tell a crash from a stop
const logPath = join(dataDir, 'server.log');
if (existsSync(logPath) && statSync(logPath).size > 5e6) renameSync(logPath, `${logPath}.1`); // ponytail: one old file kept, logrotate if more history is needed
const toLog = line => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`); } catch {} };
for (const k of ['log', 'warn', 'error']) { const out = console[k]; console[k] = (...a) => { out(...a); toLog(format(...a)); }; }
process.on('uncaughtExceptionMonitor', (e, origin) => toLog(`CRASH (${origin}): ${e?.stack ?? e}`)); // monitor only: Node still prints it and exits
// PDF guide branding: language, company, accent color (settings) and a logo (file, as a data: URL)
const loadGuide = () => ({ lang: 'id', company: '', accent: '#2B59C3', ...(loadSettingsFile().guide ?? {}) });
const logoDataUrl = () => { try { const [type, b64] = readFileSync(logoFile, 'utf8').split('\n'); return `data:${type};base64,${b64}`; } catch { return ''; } };
function validGuide({ lang = 'id', company = '', accent = '#2B59C3' } = {}) {
  if (!GUIDE_LANGS.includes(lang)) throw new Error(`Guide language must be one of ${GUIDE_LANGS.join(', ')}`);
  if (String(company).length > 80) throw new Error('Company name: at most 80 characters');
  if (!/^#[0-9a-f]{6}$/i.test(accent)) throw new Error('Accent color must look like #2B59C3');
  return { lang, company: String(company).trim(), accent };
}
const settingsPath = join(dir, 'settings.json');
const PORT = Number(process.env.PORT ?? 4321);
let browsersInstalling = false; // one Chromium download at a time
try { process.loadEnvFile(envPath); } catch {} // API keys and secrets live in the project .env

/* ---------- settings: recording, providers, secrets ---------- */
const DEFAULT_RECORDING = { width: 1280, height: 800, fps: 10, highlight: true, keep: 50 };
// Mobile emulation (Chromium with the device's size, pixel ratio, touch and user agent). The recording size
// follows the device, rounded to even numbers for H.264.
const DEVICES = ['iPhone 15', 'iPhone SE', 'Pixel 7', 'Galaxy S9+', 'iPad Mini'];
const even = n => n + (n % 2);
const loadRecording = () => {
  let rec;
  try { rec = { ...DEFAULT_RECORDING, ...JSON.parse(readFileSync(settingsPath, 'utf8')).recording }; } catch { rec = { ...DEFAULT_RECORDING }; }
  if (rec.device && playwrightDevices[rec.device]) {
    const { width, height } = playwrightDevices[rec.device].viewport;
    Object.assign(rec, { width: even(width), height: even(height) });
  }
  return rec;
};
function validRecording({ width, height, fps, highlight = true, keep = 50, device = '', a11y = false }) {
  if (device && !DEVICES.includes(device)) throw new Error(`Unknown device: ${device}`);
  [width, height, fps] = [width, height, fps].map(Number);
  // libx264 + yuv420p needs even dimensions
  for (const [n, v] of [['Width', width], ['Height', height]])
    if (!Number.isInteger(v) || v < 320 || v > 3840 || v % 2) throw new Error(`${n} must be an even number between 320 and 3840`);
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw new Error('FPS must be between 1 and 30');
  keep = Number(keep);
  if (!Number.isInteger(keep) || keep < 5 || keep > 1000) throw new Error('Keep between 5 and 1000 videos and PDFs');
  return { width, height, fps, highlight: Boolean(highlight), keep, a11y: Boolean(a11y), ...(device && { device }) };
}

// Environments: named sets of test values ({{baseUrl}}, {{policyNo}}, ...), one of them the default
const loadSettingsFile = () => { try { return JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { return {}; } };
const loadEnvironments = () => loadSettingsFile().environments ?? [];
const defaultEnv = () => loadSettingsFile().activeEnv ?? '';
const pickEnv = name => {
  const n = name || defaultEnv();
  if (!n) return { name: '', vars: {} };
  const env = loadEnvironments().find(e => e.name === n);
  if (!env) throw new Error(`Environment "${n}" not found`);
  if (env.production) throw new Error(`Environment "${n}" is production: the app never runs tests there`);
  return env;
};
// environment values that are web addresses: saved tests get {{thatName}} instead, so they run on any stage
const urlVars = () => loadEnvironments().flatMap(e => Object.entries(e.vars ?? {}).filter(([, v]) => /^https?:\/\//.test(v)).map(([name, url]) => ({ name, url })));
function validEnvironments(list = [], active = '') {
  const names = new Set();
  const envs = list.map(e => {
    const name = slug(e.name ?? '');
    if (!name || names.has(name)) throw new Error(`Environment name empty or duplicated: "${e.name}"`);
    names.add(name);
    const vars = {};
    for (const [k, v] of Object.entries(e.vars ?? {})) {
      if (!/^[a-z][A-Za-z0-9_]{0,49}$/.test(k)) throw new Error(`Invalid variable name "${k}" in ${name}: start with a lowercase letter (uppercase names are secrets)`);
      if (['today', 'now', 'random', 'runId'].includes(k)) throw new Error(`"${k}" is a built-in value and cannot be redefined`);
      vars[k] = String(v);
    }
    return { name, vars, ...(e.production && { production: true }) };
  });
  if (active && !names.has(slug(active))) throw new Error(`Default environment "${active}" does not exist`);
  if (envs.find(e => e.name === slug(active))?.production) throw new Error('The default environment cannot be a production one');
  // a production address in a test environment would be blocked mid-run: say so now
  const prod = guard.productionHosts(envs);
  for (const e of envs.filter(x => !x.production))
    for (const [k, v] of Object.entries(e.vars))
      if (prod.includes(guard.hostOf(v))) throw new Error(`${e.name}: ${k} is ${guard.hostOf(v)}, a production address. Use a test address, or unmark production.`);
  return { environments: envs, activeEnv: active ? slug(active) : '' };
}
// One MCP server per AI run: its own browser port, output folder and environment values.
// Claude Code reads the config from a file; the OpenAI-compatible engine takes the object.
function mcpFor(runDir, port, env, project) {
  const mcpServer = mcpServerFor(port, join(runDir, 'mcp'), { vars: env.vars, env: env.name, secrets: projectSecrets(project) });
  const mcpConfigPath = join(runDir, 'mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { playwright: mcpServer } }));
  return { mcpConfigPath, mcpServer };
}

/* ---------- the application's database, per project and environment ---------- */
// project.json: db.<env> = { type, host, port, database, user, reset, template }; the password is in .env
const dbPassKey = (project, envName) => `DBPASS_${project}_${envName}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const NAME_RE = /^[\w-]{1,63}$/;
function validDbConfig(c, envName) {
  const where = `Database for "${envName}"`;
  if (!['postgres', 'mysql'].includes(c.type)) throw new Error(`${where}: choose PostgreSQL or MySQL`);
  const host = String(c.host ?? '').trim(), port = Number(c.port), user = String(c.user ?? '').trim();
  if (!/^[\w.-]{1,253}$/.test(host)) throw new Error(`${where}: invalid host`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${where}: port must be 1 to 65535`);
  if (!NAME_RE.test(c.database ?? '')) throw new Error(`${where}: invalid database name`);
  if (!user || /\s/.test(user)) throw new Error(`${where}: invalid user`);
  const cfg = { type: c.type, host, port, database: c.database, user, reset: Boolean(c.reset) };
  if (cfg.reset) {
    // a typo must never wipe a real database: only test copies are reset, from a clean template
    if (cfg.type !== 'postgres') throw new Error(`${where}: resetting before every run needs PostgreSQL`);
    if (!NAME_RE.test(c.template ?? '') || c.template === cfg.database) throw new Error(`${where}: name the clean template database to copy from`);
    if (!/e2e|test/i.test(cfg.database)) throw new Error(`${where}: only databases named with e2e or test can be reset (this is "${cfg.database}")`);
    cfg.template = c.template;
  }
  return cfg;
}
// { env: config|null } -> { env: config } for test environments only
function validDb(db = {}) {
  const envs = new Map(loadEnvironments().map(e => [e.name, e]));
  const out = {};
  for (const [envName, c] of Object.entries(db)) {
    if (!c) continue;
    if (!envs.has(envName)) throw new Error(`Environment "${envName}" does not exist`);
    if (envs.get(envName).production) throw new Error(`"${envName}" is production: tests never touch its database`);
    out[envName] = validDbConfig(c, envName);
  }
  return out;
}
const dbUrlOf = (cfg, password) => `${cfg.type === 'mysql' ? 'mysql' : 'postgres'}://${encodeURIComponent(cfg.user)}:${encodeURIComponent(password ?? '')}@${cfg.host}:${cfg.port}/${encodeURIComponent(cfg.database)}`;
const projectDb = (project, envName) => {
  const cfg = project && envName ? readProject(project).db?.[envName] : null;
  return cfg ? { cfg, url: dbUrlOf(cfg, process.env[dbPassKey(project, envName)]) } : null;
};

// Reset before every run: <database> is recreated from its template, so each run starts from the same data
async function resetDatabase(project, env, log) {
  const db = projectDb(project, env.name);
  if (!db?.cfg.reset) return;
  const cfg = validDbConfig(db.cfg, env.name); // again: project.json may have been edited by hand
  log(`Resetting test database ${cfg.database} from ${cfg.template}…`);
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: dbUrlOf({ ...cfg, database: 'postgres' }, process.env[dbPassKey(project, env.name)]) });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${cfg.database}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${cfg.database}" TEMPLATE "${cfg.template}"`);
  } finally { await client.end(); }
}

// "Test connection" in the project dialog: connect, read one value, and check the template exists
async function testDb(cfg, password) {
  const url = dbUrlOf(cfg, password);
  if (cfg.type === 'postgres') {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      const { rows } = await client.query('select version() as v');
      if (cfg.template && !(await client.query('select 1 from pg_database where datname = $1', [cfg.template])).rowCount)
        throw new Error(`Connected, but the template database "${cfg.template}" does not exist`);
      return rows[0].v.split(' ').slice(0, 2).join(' ');
    } finally { await client.end(); }
  }
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({ uri: url, connectTimeout: 5000 });
  try { const [rows] = await conn.query('select version() as v'); return `MySQL ${rows[0].v}`; } finally { await conn.end(); }
}

const loadProviders = () => JSON.parse(readFileSync(providersPath, 'utf8')); // re-read so Settings changes apply without restart
// the Claude account a claude-code provider runs as (null: that config folder is not signed in, or is gone)
const accountOf = p => { try { return claudeAccount(resolveConfigDir(p.configDir)); } catch { return null; } };
const ready = p => (p.engine === 'claude-code' ? Boolean(accountOf(p)) : !p.apiKeyEnv || Boolean(process.env[p.apiKeyEnv]));

// Upsert (or remove, with value === null) KEY=value in .env and apply it to this process
function saveEnv(key, value) {
  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n') : [];
  const i = lines.findIndex(l => l.replace(/^#\s*/, '').startsWith(`${key}=`));
  if (value === null) { if (i >= 0) lines.splice(i, 1); delete process.env[key]; }
  else { if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`); process.env[key] = value; }
  writeFileSync(envPath, lines.join('\n'));
}
const secretNames = () => Object.keys(process.env).filter(k => k.startsWith('SECRET_')).map(k => k.slice(7)).sort();
// A secret is usable only in the projects it is given to (Settings > Secrets): a tester of one project must
// not be able to type another project's password into a site of their choosing
const secretProjects = () => loadSettingsFile().secretProjects ?? {};
const projectSecrets = project => secretNames().filter(n => (secretProjects()[n] ?? []).includes(project));
function validSecretProjects(map = {}, projectIds) {
  const out = {};
  for (const [name, list] of Object.entries(map)) {
    const ps = [...new Set([].concat(list ?? []))].filter(x => projectIds.includes(x));
    if (ps.length) out[String(name).toUpperCase()] = ps.sort();
  }
  return out;
}

// Validates the providers payload; returns [providers to store (keys stripped), env writes]
function validProviders(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Add at least one provider');
  const ids = new Set(), keys = [];
  const saved = list.map(p => {
    const id = String(p.id || p.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!id || ids.has(id)) throw new Error(`Provider name is empty or duplicated: "${p.label}"`);
    ids.add(id);
    if (!engines[p.engine]) throw new Error(`Unknown engine: ${p.engine}`);
    const prov = { id, label: String(p.label || id), engine: p.engine, model: String(p.model || '') };
    if (p.engine === 'claude-code' && String(p.configDir ?? '').trim()) {
      resolveConfigDir(p.configDir); // must exist now; kept as typed (~/.claude-2) so the file stays readable
      prov.configDir = String(p.configDir).trim();
    }
    if (p.engine === 'openai-compatible') {
      if (!/^https?:\/\/\S+$/.test(p.baseURL || '')) throw new Error(`Invalid Base URL: ${prov.label}`);
      prov.baseURL = p.baseURL;
    }
    const apiKey = String(p.apiKey || '').trim();
    if (/[\r\n]/.test(apiKey)) throw new Error(`Invalid API key: ${prov.label}`);
    prov.apiKeyEnv = p.apiKeyEnv || (apiKey ? `${id.toUpperCase().replace(/-/g, '_')}_API_KEY` : undefined);
    if (prov.apiKeyEnv && !/^[A-Z][A-Z0-9_]*$/.test(prov.apiKeyEnv)) throw new Error(`Invalid env variable name: ${prov.apiKeyEnv}`);
    if (apiKey) keys.push([prov.apiKeyEnv, apiKey]);
    return prov;
  });
  return [saved, keys];
}

// Secrets payload: the full list of names to keep; a value only when set/changed. Returns env writes.
function validSecrets(list) {
  if (!Array.isArray(list)) return [];
  const keep = new Set(), writes = [];
  for (const { name, value } of list) {
    const n = String(name ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,49}$/.test(n)) throw new Error(`Invalid secret name: "${name}" (use uppercase letters, digits and _)`);
    if (keep.has(n)) throw new Error(`Duplicate secret name: ${n}`);
    keep.add(n);
    const v = String(value ?? '');
    if (/[\r\n]/.test(v)) throw new Error(`Secret ${n} can't contain line breaks`);
    if (v) writes.push([`SECRET_${n}`, v]);
    else if (!process.env[`SECRET_${n}`]) throw new Error(`Secret ${n} has no value yet`);
  }
  for (const n of secretNames()) if (!keep.has(n)) writes.push([`SECRET_${n}`, null]);
  return writes;
}

/* ---------- login sessions ---------- */
// per project (app/data/sessions/<project>/<name>.json): a saved login is only usable inside its project
const sessionFile = (project, name) => {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name ?? '')) throw new Error('Session names can only use lowercase letters, digits and "-"');
  projectDir(project);
  return join(sessionsDir, project, `${name}.json`);
};
const listSessions = project => {
  const folder = join(sessionsDir, project);
  return existsSync(folder)
    ? readdirSync(folder).filter(f => f.endsWith('.json')).map(f => {
        const s = JSON.parse(readFileSync(join(folder, f), 'utf8'));
        return { name: f.slice(0, -5), saved: statSync(join(folder, f)).mtimeMs, sites: [...new Set([...(s.cookies ?? []).map(c => c.domain.replace(/^\./, '')), ...(s.origins ?? []).map(o => new URL(o.origin).host)])] };
      }).sort((a, b) => b.saved - a.saved)
    : [];
};
const pickSession = (project, name) => { if (!name) return null; const f = sessionFile(project, name); if (!existsSync(f)) throw new Error(`Session "${name}" not found`); return f; };

/* ---------- disk: keep the newest videos and PDFs, drop Playwright MCP's scratch files ---------- */
function pruneOutputs(keep) {
  pruneFolders(visualDir, keep);
  const oldGuides = pruneDir(guidesDir, keep, '.pdf');
  for (const g of oldGuides) rmSync(guideFolder(join(guidesDir, g)), { recursive: true, force: true }); // its editable document
  const gone = new Set([...pruneDir(recordingsDir, keep, '.mp4'), ...oldGuides]);
  if (!gone.size) return;
  // history keeps the run, without links to files that no longer exist
  for (const r of listRuns()) if (gone.has(r.video) || gone.has(r.guide))
    patchRun(r.id, { ...(gone.has(r.video) && { video: undefined }), ...(gone.has(r.guide) && { guide: undefined }) });
}

/* ---------- runs ---------- */
// Up to MAX_RUNS runs at once, each with its own browser (stage). More wait in line (FIFO); a client that
// leaves while waiting drops out. Runs that reset the same test database never overlap.
const MAX_RUNS = Math.max(1, Number(process.env.MAX_RUNS) || 2);
const slots = createLimiter(MAX_RUNS);
const active = new Map(); // run id -> { stage, project, abort, done, doneAt }: live view, Stop and "Save login session" by id
const dbLock = (project, env) => { const db = projectDb(project, env.name)?.cfg; return db?.reset ? [`db:${db.host}:${db.port}/${db.database}`] : []; };
// A finished AI run keeps its browser 5 minutes for "Save login session"; keep at most MAX_RUNS of those
function trimIdle() {
  const runs = [...active.entries()].map(([id, r]) => ({ id, done: r.done, doneAt: r.doneAt, browser: r.stage.hasOwnBrowser() }));
  for (const id of idleToClose(runs, MAX_RUNS)) { active.get(id).stage.close(); active.delete(id); }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { console.log(`Stopped (${sig})`); await Promise.all([...active.values()].map(r => r.stage.close())); process.exit(0); }); // Playwright's own handler doesn't exit

const SYSTEM = `You are a web automation agent. The user watches the browser live.
Use the Playwright browser tools to do the user's task, starting at the given URL.
Take a snapshot before interacting, verify each step, and stop if something blocks you.
Whenever a browser tool takes an "element" description, always fill it with the element's visible label and type, e.g. "Login button" or "Orders menu"; it is shown to the user as the step name.
Values in double braces, like {{ADMIN_PASS}}, {{today}}, {{today+3}}, {{random}} or {{baseUrl}}, are filled in by the system when a browser tool runs: type or use them exactly as written, braces included (e.g. navigate to "{{baseUrl}}/orders"). Uppercase ones are secrets: you will never see their value and must not try to reveal it.
When done, answer in English (even if the task is written in another language) with:
1. A first line exactly "RESULT: SUCCESS" or "RESULT: FAILED", then the evidence (message, URL, number shown on screen).
2. A @playwright/test TypeScript test in one \`\`\`ts block that replays the steps, using role/label/placeholder locators. Keep every double-brace value as a literal string, e.g. '{{ADMIN_PASS}}' or '{{today}}'.`;

// the project's source folders, if set (only the Claude Code engine reads it)
const codebaseOf = id => { try { return id ? readProject(id).codebase : undefined; } catch { return undefined; } };

const stamp = t => new Date(t).toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Shared shell for AI runs and replays: SSE stream, abort, recording, history entry
// Waits for a run slot (and the run's locks); the slot comes back however the run ends
function withRun(res, opts, body) {
  const left = new AbortController(); // the client left while waiting in line
  res.on('close', () => left.abort());
  const queued = position => res.write(`event: queued\ndata: ${JSON.stringify({ position })}\n\n`);
  return slots.run(opts.locks ?? [], queued, left.signal, () => runOnStage(res, opts, body));
}
async function runOnStage(res, { kind, record, guide, label, project }, body) {
  const send = (type, data) => { if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  const abort = new AbortController();
  res.on('close', () => abort.abort()); // tab closed
  const started = Date.now();
  const tag = randomBytes(3).toString('hex'); // runs can now start in the same second
  const id = `${stamp(started)}-${kind}-${tag}`;
  const video = `${stamp(started)}-${label}-${tag}.mp4`;
  const runDir = join(dataDir, 'live', id); // this run's MCP config and output, replay output; removed when the run ends
  mkdirSync(runDir, { recursive: true });
  const entry = { id, kind, started, project };
  const stage = createStage(ports);
  const run = { stage, project, abort, done: false };
  active.set(id, run);
  const rec = loadRecording();
  if (rec.device) entry.device = rec.device;
  let recorder;
  const steps = guide || record ? guideCollector(stage.currentFrame, () => recorder?.at()) : null; // PDF steps, video captions
  const mask = secretMasker(projectSecrets(project));
  const addGuideStep = step => { if (!steps) return; if (step && !step.section) step.detail = mask(step.detail ?? ''); steps.add(step); };
  const stopBoxes = steps ? stage.onHighlight((frame, info) => steps.highlight(frame, info)) : null;
  // console errors / failed requests seen during the run; repeats are counted, not listed again
  entry.issues = [];
  const issueKeys = new Map();
  const productionHosts = guard.productionHostsFromSettings();
  const stopIssues = stage.onIssue(issue => {
    // the browser could not reach a production address (it never resolves): stop the run and say why
    if (issue.kind === 'failed' && !entry.blocked && guard.isProduction(issue.url, productionHosts)) { entry.blocked = guard.hostOf(issue.url); abort.abort(); }
    const key = `${issue.kind}|${issue.text}|${issue.url ?? ''}`;
    if (issueKeys.has(key)) { issueKeys.get(key).count++; return; }
    if (entry.issues.length >= 200) return;
    const item = { ...issue, count: 1, at: Math.round((Date.now() - started) / 1000) };
    issueKeys.set(key, item); entry.issues.push(item);
    send('issue', item);
  });
  send('run', { id });
  try {
    await body({ send, signal: abort.signal, entry, rec, runDir, stage, mask, addGuideStep, startRecording: () => { if (record && !recorder) recorder = stage.startRecording(join(recordingsDir, video), rec); } });
  } catch (e) {
    entry.status = abort.signal.aborted ? 'stopped' : 'error';
    if (entry.status === 'stopped') send('stopped', 'Stopped'); else { entry.error = e.message; send('fail', e.message); }
  } finally {
    // the browser first: whatever throws below (history write, cleanup) must not keep it open forever
    Object.assign(run, { done: true, doneAt: Date.now() });
    stage.closeWhenIdle(() => active.delete(id));
    trimIdle();
    entry.secs = Math.round((Date.now() - started) / 1000);
    if (entry.blocked) {
      entry.status = 'blocked';
      entry.error = `Blocked: the run tried to open ${entry.blocked}, a production address (Settings > Environments). The browser never reached it.`;
      send('fail', entry.error);
    }
    stopBoxes?.(); stopIssues();
    const done = steps?.finish();
    if (recorder) {
      const err = await recorder.stop(); // saved even when the run failed or was stopped: that's when you need it most
      if (err) send('fail', `Recording failed: ${err}`);
      else {
        const meta = readProject(project), { lang, accent } = loadGuide();
        let n = 0;
        const captions = done.filter(s => !s.section).map(s => ({ n: ++n, at: s.at, text: translateStep(s.what, lang), zoom: s.box?.zoom, hold: entersValue(s.what) })).filter(c => c.at !== undefined);
        const cardErr = await finishVideo(join(recordingsDir, video), { ...rec, title: runTitle(entry, guideLabels(lang).suite), app: meta.app || meta.name, logo: projectLogoDataUrl(project) || logoDataUrl(), accent, captions });
        if (cardErr) send('log', `Title card and captions skipped: ${cardErr}`);
        entry.video = video; send('video', `/recordings/${video}`);
      }
    }
    if (guide) {
      const name = `${stamp(started)}-${label}-${tag}.pdf`;
      try { await buildGuidePdf(entry, done, join(guidesDir, name), { ...loadGuide(), logo: projectLogoDataUrl(project) || logoDataUrl() }); entry.guide = name; entry.guideDoc = true; send('guide', `/guides/${name}`); }
      catch (e) { send('fail', `PDF guide failed: ${e.message}`); }
    }
    addRun(entry);
    rmSync(runDir, { recursive: true, force: true });
    send('saved', { id });
    pruneOutputs(rec.keep ?? DEFAULT_RECORDING.keep);
    res.end();
  }
}

function aiRun(res, { project, url, title, task, provider, model, record, guide, session, flow, env, expected }) {
  return withRun(res, { kind: 'ai', record, guide, label: provider.id, project, locks: dbLock(project, env) }, async ({ send, signal, entry, rec, runDir, stage, startRecording, addGuideStep }) => {
    Object.assign(entry, { url, title: title || undefined, task, provider: provider.label, model: model || provider.model || '', session: session || undefined, flow: flow || undefined, env: env.name || undefined, expected: expected || undefined, steps: [] });
    await resetDatabase(project, env, line => send('text', line));
    const startUrl = makeResolver({ vars: env.vars }).fill(url); // {{baseUrl}} in the URL field
    const sessionData = session ? JSON.parse(readFileSync(pickSession(project, session), 'utf8')) : null;
    const mcp = mcpFor(runDir, await stage.ownBrowser(rec, sessionData), env, project);
    startRecording();
    const secrets = projectSecrets(project);
    const envVarNames = Object.keys(env.vars);
    const prompt = [
      `URL: ${startUrl}`,
      envVarNames.length && `Environment "${env.name}" values you can use: ${envVarNames.map(n => /^https?:\/\//.test(env.vars[n]) ? `{{${n}}} (= ${env.vars[n]})` : `{{${n}}}`).join(', ')}. Built-in values: {{today}}, {{today+N}}, {{today-N}}, {{now}}, {{random}}.`,
      sessionData && `The browser starts with a saved login session ("${session}"), so you may already be logged in.`,
      secrets.length && `Available secrets: ${secrets.map(n => `{{${n}}}`).join(', ')}`,
      flow && `The user recorded this flow with Playwright codegen. Use it as the route map: go through the same pages and use the same elements (the locators tell you which), so you do not need to explore. Adapt if something on screen differs, and verify the outcome yourself.\n\`\`\`ts\n${flowScript(flow)}\n\`\`\``,
      `Task:\n${task}`,
      expected && `Expected result (check it yourself on screen after the task):\n${expected}\n\nRight after the RESULT line, write exactly "EXPECTED: MET" or "EXPECTED: NOT MET", then what you actually saw. RESULT is SUCCESS only if the expected result is met. The test you write must assert this expected result.`,
    ].filter(Boolean).join('\n\n');
    const emit = (type, data) => {
      if (type === 'tool') { if (entry.steps.length < 300) entry.steps.push(data); addGuideStep(aiStep(data)); }
      send(type, data);
    };
    const { text } = await engines[provider.engine]({
      provider, model: model || provider.model, prompt, system: SYSTEM, ...mcp, cwd: dir, codebase: codebaseOf(project),
    }, emit, signal);
    const { evidence, script } = splitAnswer(text);
    // with an expectation, both the task and the expectation must hold; the AI's word alone is not enough
    const met = expected ? expectedVerdict(text) : null;
    const ok = /RESULT:\s*SUCCESS/.test(text) && (!expected || met === true);
    Object.assign(entry, { status: ok ? 'pass' : 'fail', text, evidence, script, ...(expected && { expectedMet: met }) });
    send('done', { ok, text, steps: entry.steps.length, secs: Math.round((Date.now() - entry.started) / 1000) });
  });
}

// Plays test files in the runner's browser, streamed to the stage. Shared by replays and fix verification.
async function playTests(files, { project, rec, session, storageFile, testDir, testDataDir, vars, envName, dbUrl, repeatEach, dataRows, updateSnapshots }, { send, signal, entry, mask, startRecording, addGuideStep, runDir, stage }) {
  const cdpPort = await stage.reservePort(); // this run's runner browser; the live view attaches to it
  const runnerDone = new AbortController(); // stop waiting for the browser if the runner ends first (e.g. a compile error)
  const watchSignal = AbortSignal.any([signal, runnerDone.signal]);
  const watching = stage.watchReplayBrowser(cdpPort, rec, watchSignal).then(() => { if (!watchSignal.aborted) startRecording(); });
  entry.log ??= []; entry.replaySteps ??= [];
  const onLine = line => { if (entry.log.length < 500) entry.log.push(line); send('log', line); };
  const onStep = raw => {
    const step = replayStep(raw, mask);
    addGuideStep(step);
    if (step && entry.replaySteps.length < 500) { entry.replaySteps.push(step); send('step', step); }
  };
  let result;
  try { result = await runTests(files, { ...rec, cdpPort, outputDir: join(runDir, `replay-${Date.now()}`), sessionFile: storageFile ?? pickSession(project, session), secrets: projectSecrets(project), apiKeyEnvs: loadProviders().map(pr => pr.apiKeyEnv).filter(Boolean), testDir, testDataDir, dbUrl, vars, envName, repeatEach, dataRows, updateSnapshots }, { onLine, onStep }, signal); }
  finally { runnerDone.abort(); await watching; stage.releasePort(cdpPort); } // a workflow may replay many tests in one run
  keepErrorContext(result.tests, entry.log);
  keepVisualDiffs(result.tests, entry.id);
  return result;
}

// Screenshot mismatches: copy expected/actual/diff images out of Playwright's output (wiped on the next replay)
function keepVisualDiffs(tests, runId) {
  tests.forEach((t, i) => {
    if (!t.images?.length) { delete t.images; return; }
    const folder = join(visualDir, runId);
    mkdirSync(folder, { recursive: true });
    t.visual = t.images.flatMap(img => {
      const file = `${i}-${img.name}`.replace(/[^\w.-]/g, '_');
      try { copyFileSync(img.path, join(folder, file)); return [{ kind: img.kind, file }]; } catch { return []; }
    });
    delete t.images;
  });
}

// Playwright writes the page state at a failure to error-context.md, but wipes it on the next replay:
// keep it with the run, "Fix with AI" needs it
function keepErrorContext(tests, log) {
  let file; const paths = {};
  for (const line of log) {
    const head = line.match(/^\s*\d+\) \[[^\]]+\] › (?:\S*\/)?(\S+?\.spec\.ts)/);
    if (head) file = head[1];
    const ctx = line.match(/Error Context: (\S+)/);
    if (ctx && file) paths[file] = ctx[1];
  }
  for (const t of tests) {
    if (!paths[t.file]) continue;
    try { t.context = readFileSync(join(dir, '..', paths[t.file]), 'utf8').slice(0, 8000); } catch {}
  }
}

function replayRun(res, { project, names, record, guide, session, env, times = 1, schedule, updateSnapshots = false }) {
  return withRun(res, { kind: 'replay', record, guide, label: names.length > 1 ? 'suite' : names[0], project, locks: dbLock(project, env) }, async ctx => {
    const { send, entry, rec } = ctx;
    // a single test with a data set runs once per row; in a suite, data-driven tests use their first row
    const rows = names.length === 1 ? parseCsv(readData(project, names[0])).length : 0;
    const extra = [rows > 1 && `${rows} data rows`, times > 1 && `${times}× each`].filter(Boolean).join(', ');
    const what = `${names.length > 1 ? `Suite: ${names.join(', ')}` : `Replay: ${names[0]}`}${extra ? ` (${extra})` : ''}`;
    Object.assign(entry, { task: updateSnapshots ? `Update visual baseline: ${names.join(', ')}` : schedule ? `Scheduled "${schedule}": ${what}` : what, testNames: names, session: session || undefined, env: env.name || undefined, times, schedule });
    await resetDatabase(project, env, line => send('log', line));
    const { tests, ok } = await playTests(names.map(n => testPath(project, n)), { project, rec, session, vars: env.vars, envName: env.name, dbUrl: projectDb(project, env.name)?.url, repeatEach: updateSnapshots ? 1 : Math.max(1, rows) * times, dataRows: rows, updateSnapshots }, ctx);
    Object.assign(entry, { status: ok ? 'pass' : 'fail', tests, flaky: flakyOf(tests) });
    send('done', { ok, tests, secs: Math.round((Date.now() - entry.started) / 1000) });
  });
}

// "Fix with AI": the AI reproduces a failing saved test in the browser, writes a corrected version, and the
// corrected version is then replayed without AI as proof. Nothing is saved until the user clicks "Save fix".
function fixRun(res, { run, name, provider, model, env }) {
  const { project } = run;
  return withRun(res, { kind: 'fix', record: false, guide: false, label: `fix-${name}`, project, locks: dbLock(project, env) }, async ctx => {
    const { send, signal, entry, rec, runDir, stage } = ctx;
    const failed = run.tests.find(t => t.file.replace(/\.spec\.ts$/, '') === name);
    const original = readTest(project, name);
    Object.assign(entry, { task: `Fix test: ${name}`, testNames: [name], fixOf: run.id, provider: provider.label, model: model || provider.model || '', session: run.session, env: env.name || undefined, original, steps: [] });
    await resetDatabase(project, env, line => send('text', line));
    const sessionData = run.session ? JSON.parse(readFileSync(pickSession(project, run.session), 'utf8')) : null;
    const mcp = mcpFor(runDir, await stage.ownBrowser(rec, sessionData), env, project);

    const firstUrl = makeResolver({ vars: env.vars }).fill(withPlaceholders(original).match(/goto\(\s*(['"`])(.*?)\1/)?.[2] ?? '/');
    const url = /^https?:/.test(firstUrl) ? firstUrl : new URL(firstUrl, env.vars.baseUrl || process.env.BASE_URL || 'http://localhost').href;
    const appErrors = (run.issues ?? []).filter(isAppError).slice(0, 15);
    const prompt = [
      `URL: ${url}`,
      projectSecrets(project).length && `Available secrets: ${projectSecrets(project).map(n => `{{${n}}}`).join(', ')}`,
      `Task: a saved Playwright test fails. Repair it.\n\nThe test file tests/${project}/${name}.spec.ts:\n\`\`\`ts\n${withPlaceholders(original)}\n\`\`\``,
      `It failed with:\n${failed.error ?? 'unknown error'}`,
      failed.context && `Page state at the moment it failed (accessibility snapshot):\n${failed.context}`,
      appErrors.length && `The application reported these errors during the failed run:\n${appErrors.map(i => `- ${i.text}${i.url ? ` (${i.url})` : ''}`).join('\n')}`,
      `What to do:
1. In the browser, go through the test's steps up to the failing point, the way the test does. Values like {{NAME}} are secrets: type them exactly as written.
2. Find why it fails: a changed label or page, a new required field, missing test data, slow loading, or a real bug in the application.
3. If the application itself is broken (the flow cannot work even by hand), answer RESULT: FAILED and explain. Do not hide a real bug by weakening the test.
4. Otherwise answer RESULT: SUCCESS, explain in 1-3 bullets what was wrong and what you changed, and give the complete corrected test file in one \`\`\`ts block. Keep the test title, the steps that already work, and secrets as '{{NAME}}'. Prefer getByRole/getByLabel locators and expect() waits over fixed timeouts.`,
    ].filter(Boolean).join('\n\n');
    const emit = (type, data) => { if (type === 'tool' && entry.steps.length < 300) entry.steps.push(data); send(type, data); };
    const { text } = await engines[provider.engine]({ provider, model: model || provider.model, prompt, system: SYSTEM, ...mcp, cwd: dir, codebase: codebaseOf(project) }, emit, signal);
    const { evidence, script } = splitAnswer(text);
    Object.assign(entry, { text, evidence });
    if (!/RESULT:\s*SUCCESS/.test(text) || !script || !/\btest\(/.test(script)) {
      entry.status = 'fail';
      send('done', { ok: false, text, secs: Math.round((Date.now() - entry.started) / 1000) });
      return;
    }
    entry.script = prepareScript(script, { urlVars: urlVars() });
    send('log', 'Verifying the corrected test with plain Playwright (no AI)…');
    const fixDir = join(runDir, 'fix'); // per run: two fixes of the same test name must not overwrite each other
    mkdirSync(fixDir, { recursive: true });
    const file = join(fixDir, `${name}.spec.ts`);
    // same script, but its helper import must point back to tests/support from here
    const support = relative(fixDir, join(testsDir, 'support', 'vars')).split('\\').join('/');
    writeFileSync(file, prepareScript(script, { urlVars: urlVars(), supportImport: support.startsWith('.') ? support : `./${support}` }));
    const { tests, ok } = await playTests([file], { project, rec, session: run.session, testDir: fixDir, testDataDir: join(projectDir(project), 'data'), vars: env.vars, envName: env.name, dbUrl: projectDb(project, env.name)?.url }, ctx);
    Object.assign(entry, { status: ok ? 'pass' : 'fail', tests });
    send('done', { ok, tests, text, secs: Math.round((Date.now() - entry.started) / 1000) });
  });
}

const noProduction = url => {
  if (guard.isProduction(url, guard.productionHostsFromSettings())) throw new Error(`${guard.hostOf(url)} is a production address: the app never opens it (Settings > Environments)`);
};

/* ---------- workflows ---------- */
// One browser for the whole workflow, so a login or an open page carries over. A Saved Test block runs in the
// test runner's browser with the same login; the next AI block reopens ours with the login it had last.
function workflowRun(res, { project, wf, params, env, session, record, guide, provider, model }) {
  return withRun(res, { kind: 'workflow', record, guide, label: `wf-${wf.id}`, project, locks: dbLock(project, env) }, async ctx => {
    const { send, signal, entry, rec, runDir, stage, mask, startRecording, addGuideStep } = ctx;
    Object.assign(entry, { task: `Workflow: ${wf.name}`, workflow: wf.id, params, env: env.name || undefined, session: session || undefined, provider: provider.label, model: model || provider.model || '', blocks: [], steps: [] });
    await resetDatabase(project, env, line => send('text', line));
    const secrets = projectSecrets(project);
    // HTTP blocks fill {{...}} here, with this project's secrets only
    const resolver = makeResolver({ vars: env.vars, secrets: Object.fromEntries(secrets.map(n => [n, process.env[`SECRET_${n}`]])), envName: env.name });
    let storage = session ? JSON.parse(readFileSync(pickSession(project, session), 'utf8')) : null;
    let browserOpen = false, mcp = null;
    const openBrowser = async () => { // a test block closes our browser; a later AI block reopens it on a new port
      if (browserOpen) return;
      mcp = mcpFor(runDir, await stage.ownBrowser(rec, storage), env, project);
      browserOpen = true;
      startRecording();
    };
    const screenshot = (n, key) => { // what the page looked like when the block ended
      const frame = stage.currentFrame();
      if (!frame) return undefined;
      const folder = join(visualDir, entry.id), name = `${n}-${key}.jpg`;
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, name), Buffer.from(frame, 'base64'));
      return name;
    };
    // the last click may still be loading a page: give the screen a moment, else the picture is blank
    const settledScreenshot = async (n, key) => { await new Promise(r => setTimeout(r, 1200)); return screenshot(n, key); };
    const wctx = { params, outputs: {}, item: undefined };
    let n = 0;

    async function http(b) {
      const fill = str => resolver.fill(fillRefs(str, wctx));
      const url = fill(b.url);
      noProduction(url);
      const r = await fetch(url, {
        method: b.method, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: Object.fromEntries(Object.entries(b.headers).map(([k, v]) => [k, fill(v)])),
        body: b.method === 'GET' ? undefined : fill(b.body) || undefined,
      });
      const raw = (await r.text()).slice(0, 1_000_000);
      let body; try { body = JSON.parse(raw); } catch { body = raw.slice(0, 5000); }
      return { ok: r.status < 400, output: { status: r.status, body }, evidence: `${b.method} ${mask(url)} → HTTP ${r.status}` };
    }

    async function runBlocks(list, iteration) {
      for (const b of list) if (!(await runBlock(b, iteration)) && !b.continueOnFailure) return false;
      return true;
    }
    async function runBlock(b, iteration) {
      const index = ++n, t0 = Date.now();
      const base = { n: index, key: b.key, type: b.type, label: b.label, ...(iteration !== undefined && { iteration: iteration + 1 }) };
      send('block', { ...base, status: 'running' });
      if (b.type !== 'loop') addGuideStep({ section: `${index}. ${b.label}${base.iteration ? ` (#${base.iteration})` : ''}` }); // a heading in the PDF guide
      let result;
      try {
        if (b.type === 'loop') {
          const items = loopItems(b, wctx, parseCsv);
          let ok = true;
          for (const [i, item] of items.entries()) {
            wctx.item = item;
            if (!(await runBlocks(b.blocks, i))) { ok = false; break; }
          }
          wctx.item = undefined;
          result = { ok, output: { count: items.length }, evidence: ok ? `Ran ${items.length} time(s)` : 'Stopped: a block inside failed' };
        } else if (b.type === 'test') {
          if (browserOpen) storage = await stage.saveSession(); // hand our login to the test runner's browser
          const file = join(runDir, 'wf-storage.json');
          writeFileSync(file, JSON.stringify(storage ?? { cookies: [], origins: [] }));
          browserOpen = false; // the runner's browser takes the stage; ours is closed
          try {
            const { tests, ok } = await playTests([testPath(project, b.test)], { project, rec, storageFile: file, vars: env.vars, envName: env.name, dbUrl: projectDb(project, env.name)?.url }, ctx);
            const bad = tests.find(t => t.status !== 'passed');
            result = { ok, output: { passed: tests.filter(t => t.status === 'passed').length, total: tests.length }, evidence: bad ? `${bad.title}: ${(bad.error ?? bad.status).split('\n')[0]}` : `${tests.length} test(s) passed` };
          } finally { rmSync(file, { force: true }); }
        } else if (b.type === 'http') {
          result = await http(b);
        } else {
          await openBrowser();
          const url = b.url ? makeResolver({ vars: env.vars }).fill(fillRefs(b.url, wctx)) : '';
          if (url) { noProduction(url); entry.url ??= url; } // the PDF guide's "Website": the first address opened
          const prompt = blockPrompt({ ...b, prompt: fillRefs(b.prompt, wctx) }, { url, secrets, envVars: Object.keys(env.vars) });
          const emit = (type, data) => {
            if (type === 'tool') { if (entry.steps.length < 500) entry.steps.push({ ...data, block: index }); addGuideStep(aiStep(data)); }
            send(type, data);
          };
          const { text } = await engines[provider.engine]({ provider, model: model || provider.model, prompt, system: WF_SYSTEM, ...mcp, cwd: dir, codebase: codebaseOf(project) }, emit, signal);
          result = readAnswer(b, text);
        }
      } catch (e) {
        if (signal.aborted) throw e;
        result = { ok: false, evidence: e.message };
      }
      if (result.output !== undefined) wctx.outputs[b.key] = result.output; // later blocks: {{blocks.<key>.<field>}}
      // the PDF guide: blocks without clicks or typing get one step with their outcome (and the page, for AI checks)
      const oneLine = t => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (b.type === 'validate') addGuideStep({ mode: 'before', what: `Check that ${oneLine(fillRefs(b.prompt, wctx)).replace(/^that\s+/i, '').replace(/^[A-Z](?=[a-z\s])/, c => c.toLowerCase())}`, detail: result.ok ? 'Yes' : `No: ${oneLine(result.evidence)}` });
      if (b.type === 'extract') addGuideStep({ mode: 'before', what: `Read ${Object.keys(b.schema).join(', ')}`, detail: result.output ? oneLine(Object.entries(result.output).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join('; ')) : oneLine(result.evidence) });
      if (b.type === 'http') addGuideStep({ what: mask(oneLine(result.evidence.split(' → ')[0])), detail: result.evidence.split(' → ')[1] ?? oneLine(result.evidence) });
      const done = {
        ...base, status: result.ok ? 'pass' : 'fail', secs: Math.round((Date.now() - t0) / 1000), evidence: mask(result.evidence ?? ''),
        ...(result.output !== undefined && { output: JSON.parse(mask(JSON.stringify(result.output))) }),
        ...(['ai', 'extract', 'validate'].includes(b.type) && { screenshot: await settledScreenshot(index, b.key) }),
      };
      if (entry.blocks.length < 300) entry.blocks.push(done);
      send('block', done);
      return result.ok;
    }

    const ok = await runBlocks(wf.blocks);
    Object.assign(entry, { status: ok ? 'pass' : 'fail', outputs: JSON.parse(mask(JSON.stringify(wctx.outputs))) });
    send('done', { ok, secs: Math.round((Date.now() - entry.started) / 1000) });
  });
}

/* ---------- scheduled suites ---------- */
const testExists = (project, name) => { try { return existsSync(testPath(project, name)); } catch { return false; } };
// A run with no browser tab attached: the same withRun/queue path, events go to `onEvent` instead of a stream
function backgroundRes(onEvent) {
  const listeners = [];
  return {
    destroyed: false, headersSent: true,
    writeHead() {},
    write(chunk) { const m = String(chunk).match(/^event: (\w+)\ndata: (.*)\n/s); if (m) onEvent(m[1], JSON.parse(m[2])); return true; },
    end() { this.destroyed = true; for (const [ev, fn] of listeners) if (ev === 'close') fn(); },
    on(ev, fn) { listeners.push([ev, fn]); return this; },
  };
}

async function runSchedule(sched) {
  let savedId;
  const res = backgroundRes((type, data) => { if (type === 'saved') savedId = data.id; });
  try {
    const env = pickEnv(sched.env);
    const names = sched.tests.filter(n => testExists(sched.project, n));
    if (!names.length) throw new Error('none of its tests exist any more');
    await replayRun(res, { project: sched.project, names, record: sched.record, guide: sched.guide, session: sched.session || '', env, times: sched.repeat ?? 1, schedule: sched.name });
    const run = savedId && getRun(savedId);
    // a failing notification (e.g. wrong token) is not a failed run: log it, keep the run's own result
    if (run) await notify(loadSettingsFile().notify ?? {}, summary(run, `Scheduled "${sched.name}"`), { name: `report-${run.id}.html`, html: buildReport(run, recordingsDir) })
      .catch(e => console.error(`Schedule "${sched.name}": notification failed: ${e.message}`));
  } catch (e) {
    console.error(`Schedule "${sched.name}": ${e.message}`);
    await notify(loadSettingsFile().notify ?? {}, `❌ Scheduled "${sched.name}" could not run: ${e.message}`).catch(() => {});
  } finally { res.end(); }
}

const schedState = scheduleState(join(dataDir, 'schedule-state.json'));
setInterval(() => {
  for (const sched of dueSchedules(loadSettingsFile().schedules ?? [], new Date(), schedState.load())) {
    schedState.markRun(sched.id); // before starting: a restart mid-run must not start it again today
    runSchedule(sched);
  }
}, 30_000).unref();

/* ---------- access ---------- */
// One person per install: no accounts. The origin check below is what keeps other websites out.
const denied = (msg, status = 403) => Object.assign(new Error(msg), { status });
const runOr404 = run => { if (!run) throw denied('Run not found', 404); return run; };
// The page sets a SameSite=Strict cookie; every API call must carry it. Browsers never send it with a request
// another site starts (form POST, <img>, even in browsers too old for Sec-Fetch-Site), so no site can drive the app.
// ponytail: a new token per server start; an open tab needs a reload after a restart
const pageToken = randomBytes(24).toString('hex');
const fromOurPage = req => (req.headers.cookie ?? '').split(/;\s*/).includes(`abr_page=${pageToken}`);

/* ---------- http ---------- */
// Only this page may call the API: blocks other sites (CSRF / key theft via baseURL) and DNS rebinding
const sameOrigin = req => {
  const host = (req.headers.host ?? '').toLowerCase();
  const known = /^(127\.0\.0\.1|localhost):\d+$/.test(host);
  return known && ['same-origin', 'none', undefined].includes(req.headers['sec-fetch-site']);
};
const json = (res, data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const fail = (res, e, code = e.status ?? 400) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(e.message ?? String(e)); };
const readBody = (req, limit = 500_000) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', c => { body += c; if (body.length > limit) { reject(new Error('Request body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
});
const sse = res => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
const sendFile = (res, file, headers) => { if (!existsSync(file)) { res.writeHead(404); return res.end(); } res.writeHead(200, headers); return createReadStream(file).pipe(res); };

async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname, m = req.method;
  const q = k => u.searchParams.get(k) ?? '';

  // the page itself: it shows the login screen when there is no session
  if (p === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-abr-folder': encodeURIComponent(join(dir, '..')), 'set-cookie': `abr_page=${pageToken}; HttpOnly; SameSite=Strict; Path=/` }); return res.end(readFileSync(join(dir, 'index.html'))); }
  const STATIC = { '/shared.mjs': 'text/javascript', '/app.js': 'text/javascript', '/studio.js': 'text/javascript', '/app.css': 'text/css' };
  if (STATIC[p]) { res.writeHead(200, { 'content-type': `${STATIC[p]}; charset=utf-8` }); return res.end(readFileSync(join(dir, p.slice(1)))); }
  if (!fromOurPage(req)) throw denied('Open the app from its own page (reload it after the app restarts)');


  /* ----- live view, files, stop ----- */
  const liveRun = id => { const run = active.get(id); if (!run) throw denied('That run is not running'); return run; };
  if (p === '/screen') { const run = liveRun(q('run')); sse(res); return run.stage.addViewer(res); }

  const recMatch = p.match(/^\/recordings\/([\w-]+\.mp4)$/);
  if (recMatch) {
    runOr404(runOfFile('video', recMatch[1]));
    const file = join(recordingsDir, recMatch[1]);
    if (!existsSync(file)) { res.writeHead(404); return res.end(); }
    const size = statSync(file).size;
    const [, a, b] = req.headers.range?.match(/bytes=(\d*)-(\d*)/) ?? [];
    const start = a ? Number(a) : 0, end = b ? Math.min(Number(b), size - 1) : size - 1;
    res.writeHead(req.headers.range ? 206 : 200, {
      'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1,
      ...(req.headers.range && { 'content-range': `bytes ${start}-${end}/${size}` }),
    });
    return createReadStream(file, { start, end }).pipe(res);
  }
  const visMatch = p.match(/^\/visual\/([\w-]+)\/([\w.-]+\.(png|jpg))$/);
  if (visMatch) { runOr404(getRun(visMatch[1])); return sendFile(res, join(visualDir, visMatch[1], visMatch[2]), { 'content-type': visMatch[3] === 'jpg' ? 'image/jpeg' : 'image/png' }); }
  // the guide editor: the document behind a PDF, its screenshots, and saving it (the PDF is made again)
  const guideDocMatch = p.match(/^\/guides\/([\w-]+\.pdf)\/(doc|frame|\d{3}\.(?:jpg|png))$/);
  if (guideDocMatch) {
    const [, pdf, part] = guideDocMatch;
    const run = runOr404(runOfFile('guide', pdf));
    const folder = guideFolder(join(guidesDir, pdf));
    if (!existsSync(join(folder, 'doc.json'))) throw denied('This guide was made before guides could be edited: run it again to edit its guide', 404);
    if (part === 'frame' && m === 'POST') return json(res, { frame: addGuideFrame(folder, (await readBody(req, 15_000_000)).dataUrl) }); // Replace image
    if (part !== 'doc') { if (!FRAME_FILE.test(part)) throw denied('Not found', 404); return sendFile(res, join(folder, part), { 'content-type': frameType(part) }); }
    if (m === 'GET') return json(res, readGuideDoc(folder));
    if (m === 'PUT') {
      const doc = cleanGuideDoc((await readBody(req, 5_000_000)).doc, readGuideDoc(folder), guideFrames(folder));
      writeFileSync(join(folder, 'doc.json'), JSON.stringify(doc, null, 1));
      pruneGuideFrames(folder, doc);
      await renderGuidePdf(doc, folder, join(guidesDir, pdf), { ...loadGuide(), logo: projectLogoDataUrl(run.project) || logoDataUrl() });
      return json(res, { ok: true, pdf: `/guides/${pdf}` });
    }
  }
  const guideMatch = p.match(/^\/guides\/([\w-]+\.pdf)$/);
  if (guideMatch) {
    runOr404(runOfFile('guide', guideMatch[1]));
    return sendFile(res, join(guidesDir, guideMatch[1]), { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="guide-${guideMatch[1]}"` });
  }
  if (p === '/stop' && m === 'POST') { liveRun(q('run')).abort.abort(); res.writeHead(204); return res.end(); }

  /* ----- settings: admins change them; everyone gets what the run forms need ----- */
  if (p === '/settings' && m === 'GET') {
    const providers = loadProviders().map(pr => ({ ...pr, ready: ready(pr), ...(pr.engine === 'claude-code' && { account: accountOf(pr) }) }));
    // never send key/secret values to the browser, only names and whether a key is set
    return json(res, { engines: Object.keys(engines), days: DAYS, activeEnv: defaultEnv(), recording: loadRecording(), providers, devices: DEVICES, schedules: loadSettingsFile().schedules ?? [], guide: loadGuide(), guideLangs: GUIDE_LANGS, hasLogo: existsSync(logoFile), notify: loadSettingsFile().notify ?? {}, secrets: secretNames(), secretProjects: secretProjects(), environments: loadEnvironments() });
  }
  if (p === '/settings' && m === 'POST') {
    const { providers, recording, secrets, secretProjects: scopes, environments, activeEnv, schedules, notify: notifyCfg, guide } = await readBody(req);
    const guideCfg = validGuide(guide ?? loadGuide());
    const envs = validEnvironments(environments, activeEnv);
    const scheds = validSchedules(schedules ?? [], testExists);
    const chat = String(notifyCfg?.telegramChatId ?? '').trim();
    if (chat && !/^-?\d+$|^@\w+$/.test(chat)) throw new Error('Telegram chat id is a number (or @channelname)');
    const rec = validRecording(recording ?? {}); // validate everything before writing anything
    const [saved, keyWrites] = validProviders(providers);
    const secretWrites = validSecrets(secrets);
    const scoped = validSecretProjects(scopes, listProjects().map(pr => pr.id));
    for (const [k, v] of [...keyWrites, ...secretWrites]) saveEnv(k, v);
    writeFileSync(providersPath, JSON.stringify(saved, null, 2) + '\n');
    writeFileSync(settingsPath, JSON.stringify({ recording: rec, ...envs, schedules: scheds, notify: { telegramChatId: chat }, guide: guideCfg, secretProjects: scoped }, null, 2) + '\n');
    res.writeHead(200); return res.end('ok');
  }

  /* ----- projects ----- */
  if (p === '/projects' && m === 'GET') { // the start screen: every project on this computer
    const all = listProjects(), ids = all.map(pr => pr.id);
    const runs = listRuns(ids);
    return json(res, all.map(({ db, ...pr }) => {
      const own = runs.filter(r => r.project === pr.id);
      return {
        ...pr, tests: listTests(pr.id).map(t => t.name), runs: own.length,
        last: own[0] ? { status: own[0].status, started: own[0].started } : null, recent: own.slice(0, 12).map(r => r.status),
        secrets: projectSecrets(pr.id), sessions: listSessions(pr.id), hasLogo: Boolean(projectLogoDataUrl(pr.id)),
        db, dbPassSet: Object.fromEntries(Object.keys(db ?? {}).map(e => [e, Boolean(process.env[dbPassKey(pr.id, e)])])),
      };
    }));
  }
  const projMatch = p.match(/^\/projects\/([a-z0-9-]+)$/);
  if ((p === '/projects' && m === 'POST') || (projMatch && m === 'PUT')) {
    if (projMatch) projectDir(projMatch[1]);
    const { dbPasswords = {}, ...fields } = await readBody(req);
    const db = validDb(fields.db); // before writing anything
    for (const v of Object.values(dbPasswords)) if (/[\r\n]/.test(String(v))) throw new Error('Invalid database password');
    const id = saveProject(projMatch?.[1], { ...fields, db });
    for (const [envName, pass] of Object.entries(dbPasswords)) if (pass && db[envName]) saveEnv(dbPassKey(id, envName), String(pass));
    return json(res, { id });
  }
  /* ----- first run: what this computer still needs ----- */
  if (p === '/setup/status' && m === 'GET') return json(res, { os: process.platform, osName: OS_NAMES[process.platform] ?? process.platform, portable: Boolean(process.env.ABR_PORTABLE), items: await checkRequirements({ root: join(dir, '..') }) });
  if (p === '/setup/browsers' && m === 'GET') { // download Chromium, the installer's lines streamed
    if (browsersInstalling) throw new Error('Chromium is already being downloaded');
    browsersInstalling = true;
    sse(res);
    const send = (type, data) => { if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
    try { send('done', { ok: await installBrowsers(join(dir, '..'), line => send('log', line)) }); }
    finally { browsersInstalling = false; res.end(); }
    return;
  }
  if (p === '/folders' && m === 'GET') return json(res, listFolders(q('path'))); // codebase folder picker: names only
  if (p === '/db/test' && m === 'POST') { // settings not saved yet: the password typed now, else the saved one
    const { project: pr, env: envName, config, password } = await readBody(req);
    if (pr) projectDir(pr);
    const cfg = validDb({ [envName]: config })[envName];
    const pass = password || (pr ? process.env[dbPassKey(pr, envName)] : '');
    return json(res, { ok: true, server: await testDb(cfg, pass) });
  }
  if (projMatch && m === 'DELETE') { // its tests, runs, videos, PDFs, sessions and database passwords
    const id = projMatch[1];
    const dbKeys = Object.keys(readProject(id).db ?? {}).map(e => dbPassKey(id, e));
    deleteProject(id);
    for (const k of dbKeys) saveEnv(k, null);
    rmSync(join(sessionsDir, id), { recursive: true, force: true });
    for (const r of removeRuns(id)) {
      if (r.video) rmSync(join(recordingsDir, r.video), { force: true });
      if (r.guide) { rmSync(join(guidesDir, r.guide), { force: true }); rmSync(guideFolder(join(guidesDir, r.guide)), { recursive: true, force: true }); }
      rmSync(join(visualDir, r.id), { recursive: true, force: true });
    }
    res.writeHead(204); return res.end();
  }
  /* ----- share a project as one file ----- */
  const expMatch = p.match(/^\/projects\/([a-z0-9-]+)\/export$/);
  if (expMatch && m === 'GET') {
    const id = expMatch[1];
    const { id: _, codebase: __, ...meta } = readProject(id); // the codebase folder is this computer's
    const bundle = packProject(projectDir(id), { id, ...meta }, projectSecrets(id));
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${id}.abr.json"` });
    return res.end(JSON.stringify(bundle));
  }
  if (p === '/projects/export' && m === 'GET') { // every project in one file
    const bundles = listProjects().map(({ id, codebase: _, ...meta }) => packProject(projectDir(id), { id, ...meta }, projectSecrets(id)));
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="abra-projects-${new Date().toISOString().slice(0, 10)}.abr.json"` });
    return res.end(JSON.stringify(packAll(bundles)));
  }
  if (p === '/projects/demo' && m === 'POST') { // the practice project a new user starts with (app/demo), through the normal import checks
    if (listProjects().some(pr => pr.id === 'saucedemo')) return json(res, { id: 'saucedemo' });
    return json(res, importProject(unpackBundle(JSON.parse(readFileSync(join(dir, 'demo', 'saucedemo.abr.json'), 'utf8'))), 'new'));
  }
  if (p === '/projects/import' && m === 'POST') {
    const { bundle, mode } = await readBody(req, 200_000_000);
    if (!isAll(bundle)) { // one project
      const result = importProject(unpackBundle(bundle), mode); // unpackBundle throws before anything is written
      return result.conflict ? json(res, result, 409) : json(res, result);
    }
    // every project in the file: all of them checked first, then asked once what to do with the ones already here
    const parts = unpackAll(bundle);
    const conflicts = parts.map(x => x.project.id).filter(projectTaken);
    if (conflicts.length && !['overwrite', 'new', 'skip'].includes(mode)) return json(res, { conflicts }, 409);
    if (mode === 'overwrite') for (const id of conflicts) if (!listProjects().some(pr => pr.id === id)) throw new Error(`tests/${id} is not a project; import as new copies or skip it`);
    return json(res, { all: true, results: parts.map(x => (mode === 'skip' && projectTaken(x.project.id) ? { skipped: x.project.id } : importProject(x, mode))) });
  }
  const projLogo = p.match(/^\/projects\/([a-z0-9-]+)\/logo$/);
  if (projLogo && m === 'POST') { saveProjectLogo(projLogo[1], (await readBody(req)).dataUrl); return json(res, { ok: true }); }
  if (projLogo && m === 'DELETE') { deleteProjectLogo(projLogo[1]); res.writeHead(204); return res.end(); }
  if (projLogo && m === 'GET') {
    const url = projectLogoDataUrl(projLogo[1]);
    if (!url) { res.writeHead(404); return res.end(); }
    const [, type, b64] = url.match(/^data:([^;]+);base64,(.*)$/);
    res.writeHead(200, { 'content-type': type }); return res.end(Buffer.from(b64, 'base64'));
  }
  const projSes = p.match(/^\/projects\/([a-z0-9-]+)\/sessions\/([a-z0-9-]+)$/);
  if (projSes && m === 'DELETE') { projectDir(projSes[1]); unlinkSync(sessionFile(projSes[1], projSes[2])); res.writeHead(204); return res.end(); }
  if (p === '/sessions' && m === 'POST') { // "Save login session" after an AI run or a recording
    const { project: pr, name, flowId, run: runId } = await readBody(req);
    projectDir(pr);
    const file = sessionFile(pr, slug(name));
    const state = flowId ? JSON.parse(flowStorage(flowId)) : await (() => {
      const r = liveRun(runId);
      if (r.project !== pr) throw denied('That run belongs to another project'); // never save one project's login into another
      return r.stage.saveSession();
    })();
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(state));
    return json(res, { name: slug(name), cookies: state.cookies.length });
  }

  /* ----- saved tests of one project: ?project=<id> on every call ----- */
  const project = q('project');
  const testMatch = p.match(/^\/tests\/([a-z0-9-]+)$/);
  const dataMatch = p.match(/^\/tests\/([a-z0-9-]+)\/data$/);
  if (p === '/tests' || testMatch || dataMatch) projectDir(project);
  if (p === '/tests' && m === 'GET') return json(res, listTests(project));
  if (p === '/tests' && m === 'POST') {
    const { name, runId, code, overwrite } = await readBody(req);
    let script = code;
    if (runId) { const run = getRun(runId); runOr404(run); script = run.script; }
    if (!script) throw new Error('This run has no test script');
    return json(res, { name: saveTest(project, slug(name), script, overwrite, { urlVars: urlVars() }) });
  }
  if (testMatch && m === 'GET') { const code = readTest(project, testMatch[1]); res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(code); }
  if (testMatch && m === 'PUT') { // edited in the app: script and data set
    const { code, csv } = await readBody(req);
    if (typeof code === 'string') saveTest(project, testMatch[1], code, true, { urlVars: urlVars() });
    if (typeof csv === 'string') saveData(project, testMatch[1], csv);
    return json(res, { name: testMatch[1], dataRows: parseCsv(readData(project, testMatch[1])).length });
  }
  if (dataMatch && m === 'GET') { const csv = readData(project, dataMatch[1]); res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(csv); }
  if (testMatch && m === 'DELETE') { deleteTest(project, testMatch[1]); res.writeHead(204); return res.end(); }

  /* ----- workflows of one project ----- */
  const wfMatch = p.match(/^\/workflows\/([a-z0-9-]+)$/);
  if (p === '/workflows' || wfMatch) projectDir(project);
  if (p === '/workflows' && m === 'GET') return json(res, listWorkflows(project));
  if (wfMatch && m === 'GET') return json(res, readWorkflow(project, wfMatch[1]));
  if ((p === '/workflows' && m === 'POST') || (wfMatch && m === 'PUT')) {
    const wf = validWorkflow(await readBody(req), { testExists: name => testExists(project, name) });
    return json(res, { id: saveWorkflow(project, wfMatch?.[1], wf) });
  }
  if (wfMatch && m === 'DELETE') { deleteWorkflow(project, wfMatch[1]); res.writeHead(204); return res.end(); }

  /* ----- history ----- */
  if (p === '/history') { projectDir(project); return json(res, listRuns(project)); }
  const histMatch = p.match(/^\/history\/([\w-]+)$/);
  if (histMatch) { const r = getRun(histMatch[1]); runOr404(r); return json(res, r); }
  const repMatch = p.match(/^\/report\/([\w-]+)$/);
  if (repMatch) {
    const r = getRun(repMatch[1]);
    runOr404(r);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `attachment; filename="report-${r.id}.html"` });
    return res.end(buildReport(r, recordingsDir));
  }

  /* ----- record flow (a window on this computer's desktop: local mode only) ----- */
  if (p === '/record' && m === 'GET') {
    projectDir(project);
    const url = makeResolver({ vars: pickEnv(q('env')).vars }).fill(q('url')); // {{baseUrl}} allowed
    if (!/^https?:\/\//.test(url)) throw new Error('A URL (http/https) is required');
    noProduction(url); // codegen's browser takes no launch flags: only its start address can be checked
    const session = q('session');
    const { id, done } = recordFlow(url, { sessionFile: session ? pickSession(project, session) : undefined });
    sse(res);
    const send = (type, data) => { if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
    send('started', { id });
    return done.then(r => send('done', r), e => send('fail', e.message)).finally(() => res.end());
  }
  if (p === '/record/stop' && m === 'POST') { stopRecording(); res.writeHead(204); return res.end(); }

  /* ----- admin tools ----- */
  const schedRun = p.match(/^\/schedules\/([a-z0-9-]+)\/run$/);
  if (schedRun && m === 'POST') {
    const sched = (loadSettingsFile().schedules ?? []).find(x => x.id === schedRun[1]);
    if (!sched) return fail(res, 'Schedule not found', 404);
    runSchedule(sched);
    return json(res, { queued: true });
  }
  if (p === '/ci/export' && m === 'POST') {
    const { env: envName } = await readBody(req);
    const env = pickEnv(envName);
    const secrets = secretNames().filter(n => !['TELEGRAM_TOKEN', 'SLACK_WEBHOOK'].includes(n)); // app-only
    const file = join(dir, '..', '.github', 'workflows', 'e2e.yml');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, ciWorkflow({ secrets }));
    const local = Object.values(env.vars).filter(v => /^https?:\/\/[^/]*(\.test|localhost|127\.0\.0\.1)/.test(v));
    return json(res, { path: '.github/workflows/e2e.yml', secrets, vars: JSON.stringify(env.vars), env: env.name, localAddresses: local });
  }
  if (p === '/branding/logo' && m === 'POST') { // { dataUrl: 'data:image/png;base64,...' } from the file picker
    const { dataUrl } = await readBody(req);
    const match = String(dataUrl ?? '').match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error('The logo must be a PNG or JPG image');
    mkdirSync(join(logoFile, '..'), { recursive: true });
    writeFileSync(logoFile, `${match[1]}\n${match[2]}`);
    return json(res, { ok: true });
  }
  if (p === '/branding/logo' && m === 'DELETE') { rmSync(logoFile, { force: true }); res.writeHead(204); return res.end(); }
  if (p === '/branding/logo' && m === 'GET') {
    const url = logoDataUrl();
    if (!url) { res.writeHead(404); return res.end(); }
    const [, type, b64] = url.match(/^data:([^;]+);base64,(.*)$/);
    res.writeHead(200, { 'content-type': type }); return res.end(Buffer.from(b64, 'base64'));
  }
  if (p === '/notify/test' && m === 'POST') {
    const sent = await notify(loadSettingsFile().notify ?? {}, '🔔 Test message from ABRA: notifications work.');
    if (!sent.length) throw new Error('Nothing is set up: add the secret TELEGRAM_TOKEN plus a chat id, or the secret SLACK_WEBHOOK');
    return json(res, { sent });
  }

  /* ----- runs ----- */
  const pickProvider = () => {
    const providers = loadProviders();
    const provider = providers.find(pr => pr.id === q('provider')) ?? providers[0];
    if (!provider) throw new Error('No AI provider is set up: an admin adds one in Settings');
    if (!ready(provider)) throw new Error(`${provider.apiKeyEnv} is not set`);
    return provider;
  };
  if (p === '/fix') {
    const run = getRun(q('run')), name = q('test');
    runOr404(run);
    if (!run.tests?.some(t => t.status !== 'passed' && t.file.replace(/\.spec\.ts$/, '') === name)) throw new Error('That test did not fail in this run');
    if (!existsSync(testPath(run.project, name))) throw new Error(`Test "${name}" not found`);
    const provider = pickProvider();
    const env = pickEnv(q('env') || run.env);
    sse(res); // after every check; withRun waits if all run slots are taken
    return fixRun(res, { run, name, provider, model: q('model'), env });
  }
  if (p === '/workflow-run') {
    projectDir(project);
    const saved = readWorkflow(project, q('workflow'));
    const wf = { id: saved.id, ...validWorkflow(saved, { testExists: name => testExists(project, name) }) }; // its tests may be gone
    const given = JSON.parse(q('params') || '{}');
    const params = Object.fromEntries(wf.params.map(x => [x.name, String(given[x.name] ?? x.default).slice(0, 500)]));
    const session = q('session');
    if (session) pickSession(project, session);
    const env = pickEnv(q('env'));
    const provider = pickProvider();
    sse(res);
    return workflowRun(res, { project, wf, params, env, session, record: q('record') === '1', guide: q('guide') === '1', provider, model: q('model') });
  }
  if (p === '/run' || p === '/replay') {
    projectDir(project); // every run belongs to a project
    const session = q('session');
    if (session) pickSession(project, session);
    const record = q('record') === '1', guide = q('guide') === '1';
    const env = pickEnv(q('env'));
    if (p === '/run') {
      const url = q('url'), task = q('task');
      const provider = pickProvider();
      if (!/^https?:\/\//.test(makeResolver({ vars: env.vars }).fill(url)) || !task.trim()) throw new Error('A URL (http/https, or {{baseUrl}}/...) and instructions are required');
      noProduction(makeResolver({ vars: env.vars }).fill(url));
      const flow = q('flow'); if (flow) flowScript(flow); // validates before streaming
      sse(res);
      return aiRun(res, { project, url, title: q('title').trim().slice(0, 100), task, provider, model: q('model'), record, guide, session, flow, env, expected: q('expected').trim() });
    }
    const names = q('tests').split(',').filter(Boolean);
    if (!names.length) throw new Error('Select at least one test');
    for (const n of names) if (!existsSync(testPath(project, n))) throw new Error(`Test "${n}" not found`); // also validates names
    const times = Number(q('repeat') || 1);
    if (![1, 3, 5].includes(times)) throw new Error('Repeat must be 1, 3 or 5');
    sse(res); // only after every check
    return replayRun(res, { project, names, record, guide, session, env, times, updateSnapshots: q('update') === '1' });
  }
  res.writeHead(404); res.end();
}

// Writes one unpacked project bundle. mode: undefined (answers a conflict), 'overwrite' or 'new' (a copy "<id>-2").
const projectTaken = id => listProjects().some(pr => pr.id === id) || existsSync(join(testsDir, id));
function importProject({ project, secrets, files }, mode) {
  const envNames = new Set(loadEnvironments().map(e => e.name));
  const skippedDb = Object.keys(project.db ?? {}).filter(e => !envNames.has(e));
  const db = validDb(Object.fromEntries(Object.entries(project.db ?? {}).filter(([e]) => envNames.has(e))));
  let id = project.id, name = project.name.trim();
  // overwrite only a real project: a plain folder under tests/ is not ours to empty
  if (mode === 'overwrite' && projectTaken(id) && !listProjects().some(pr => pr.id === id)) throw new Error(`tests/${id} is not a project; import it as a new project instead`);
  if (projectTaken(id) && mode !== 'overwrite') {
    let n = 2; while (projectTaken(`${project.id}-${n}`)) n++;
    if (mode !== 'new') return { conflict: id, suggestion: `${project.id}-${n}` };
    id = `${project.id}-${n}`; name = `${project.name} (${n})`;
  }
  const dir = join(testsDir, id);
  if (mode === 'overwrite' && existsSync(dir)) for (const f of readdirSync(dir)) if (f !== 'project.json') rmSync(join(dir, f), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { created, codebase } = existsSync(join(dir, 'project.json')) ? JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) : {};
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name, description: project.description ?? '', url: project.url ?? '', app: project.app ?? '', env: envNames.has(project.env) ? project.env : '', ...(Object.keys(db).length && { db }), ...(codebase && { codebase }), created: created ?? Date.now() }, null, 2) + '\n');
  for (const f of files) { mkdirSync(join(dir, f.path, '..'), { recursive: true }); writeFileSync(join(dir, f.path), f.data); }
  // never bind secrets by itself: an imported workflow could send them anywhere. The user ticks them in Settings.
  const have = new Set(secretNames());
  return { id, files: files.length, unboundSecrets: secrets.filter(n => have.has(n)), missingSecrets: secrets.filter(n => !have.has(n)), missingVars: missingVars(files, loadEnvironments()), skippedDb };
}

const server = http.createServer((req, res) => {
  if (!sameOrigin(req)) { res.writeHead(403); return res.end('forbidden'); }
  route(req, res).catch(e => { if (!res.headersSent) fail(res, e); else res.end(); });
});
// The port is taken: this same app already running (a second start) just opens it; anything else says what to do
server.on('error', async e => {
  if (e.code !== 'EADDRINUSE') throw e;
  const url = `http://127.0.0.1:${PORT}`;
  const folder = await fetch(url, { signal: AbortSignal.timeout(3000) }).then(r => r.headers.get('x-abr-folder'), () => null);
  const here = join(dir, '..');
  if (folder && decodeURIComponent(folder) === here) {
    console.log(`ABRA is already running → ${url}`);
    if (process.env.ABR_OPEN) openWindow(url, false);
    process.exit(0);
  }
  const other = process.platform === 'win32' ? `set PORT=${PORT + 1} && start.cmd` : process.env.ABR_PORTABLE ? `PORT=${PORT + 1} ./start.sh` : `PORT=${PORT + 1} npm run app`;
  console.error(`\nPort ${PORT} is already in use${folder ? ` by another copy of ABRA (${decodeURIComponent(folder)})` : ' by another program'}.
Close it, or start this one on another port:  ${other}\n`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => { // this computer only: nothing else on the network can reach it
  console.log(`ABRA → http://127.0.0.1:${PORT}`);
  if (process.env.ABR_OPEN) openWindow(`http://127.0.0.1:${PORT}`, true); // the portable launcher asks for this
});

// The app's own window (see window.mjs). quitWithIt: closing the window stops the app, like any desktop app.
function openWindow(url, quitWithIt) {
  const onClose = () => { if (quitWithIt) { console.log('Window closed: ABRA stopped.'); process.exit(0); } };
  openAppWindow(url, { profile: join(dataDir, 'window'), bundled: bundledChromium.executablePath(), onClose });
}
