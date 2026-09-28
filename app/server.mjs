import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, createReadStream, readdirSync, unlinkSync, rmSync, copyFileSync, appendFileSync, renameSync } from 'node:fs';
import { format } from 'node:util';
import { join, relative } from 'node:path';
import { engines } from './agents.mjs';
import * as stage from './stage.mjs';
import { devices as playwrightDevices } from 'playwright-core';
import { listTests, readTest, saveTest, deleteTest, testPath, slug, prepareScript, withPlaceholders, readData, saveData, testsDir, projectDir, listProjects, readProject, saveProject, deleteProject, listWorkflows, readWorkflow, saveWorkflow, deleteWorkflow } from './library.mjs';
import varsCore from './vars-core.cjs';
import guard from './guard.cjs';
const { makeResolver, parseCsv, secretsFromEnv } = varsCore;
import { runTests } from './replay.mjs';
import { addRun, getRun, listRuns, patchRun, removeRuns, runOfFile, dataDir } from './history.mjs';
import { userCount, userOf, login, logout, changeOwnPassword, createUser, updateUser, listUsers, can, roleIn, visibleProjects, listMembers, setMember, dropProjectMembers } from './auth.mjs';
import { buildReport } from './report.mjs';
import { pruneDir, pruneFolders } from './housekeeping.mjs';
import { dueSchedules, validSchedules, scheduleState, DAYS } from './scheduler.mjs';
import { notify, summary } from './notify.mjs';
import { ciWorkflow } from './ci.mjs';
import { recordFlow, stopRecording, isRecording, flowScript, flowStorage } from './recorder.mjs';
import { splitAnswer, flakyOf, expectedVerdict, isAppError } from './shared.mjs';
import { aiStep, replayStep, guideCollector, buildGuidePdf, secretMasker } from './guide.mjs';
import { GUIDE_LANGS } from './guide-i18n.mjs';
import { validWorkflow, fillRefs, loopItems, blockPrompt, readAnswer, SYSTEM as WF_SYSTEM } from './workflow.mjs';

const dir = import.meta.dirname;
const envPath = join(dir, '..', '.env');
const providersPath = join(dir, 'providers.json');
const recordingsDir = join(dir, 'recordings');
const guidesDir = join(dir, 'guides');
const sessionsDir = join(dataDir, 'sessions');
const fixesDir = join(dataDir, 'fixes');
const visualDir = join(dataDir, 'visual');
const logoFile = join(dataDir, 'branding', 'logo');

// Everything the server prints also lands in app/data/server.log: after the terminal is gone you can still tell a crash from a stop
const logPath = join(dataDir, 'server.log');
if (existsSync(logPath) && statSync(logPath).size > 5e6) renameSync(logPath, `${logPath}.1`); // ponytail: one old file kept, logrotate if more history is needed
const toLog = line => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`); } catch {} };
for (const k of ['log', 'warn', 'error']) { const out = console[k]; console[k] = (...a) => { out(...a); toLog(format(...a)); }; }
process.on('uncaughtExceptionMonitor', (e, origin) => toLog(`CRASH (${origin}): ${e?.stack ?? e}`)); // monitor only: Node still prints it and exits
// PDF guide branding: language, company, accent color (settings) and a logo (file, as a data: URL)
const loadGuide = () => ({ lang: 'en', company: '', accent: '#2B59C3', ...(loadSettingsFile().guide ?? {}) });
const logoDataUrl = () => { try { const [type, b64] = readFileSync(logoFile, 'utf8').split('\n'); return `data:${type};base64,${b64}`; } catch { return ''; } };
function validGuide({ lang = 'en', company = '', accent = '#2B59C3' } = {}) {
  if (!GUIDE_LANGS.includes(lang)) throw new Error(`Guide language must be one of ${GUIDE_LANGS.join(', ')}`);
  if (String(company).length > 80) throw new Error('Company name: at most 80 characters');
  if (!/^#[0-9a-f]{6}$/i.test(accent)) throw new Error('Accent color must look like #2B59C3');
  return { lang, company: String(company).trim(), accent };
}
const settingsPath = join(dir, 'settings.json');
const mcpConfigPath = join(dir, 'mcp.json');
const mcpServer = JSON.parse(readFileSync(mcpConfigPath, 'utf8')).mcpServers.playwright;
const PORT = Number(process.env.PORT ?? 4321);
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
// the MCP proxy reads the chosen environment's values from here when an AI run starts
const writeRunVars = (env, project) => { mkdirSync(dataDir, { recursive: true }); writeFileSync(join(dataDir, 'run-vars.json'), JSON.stringify({ vars: env.vars, env: env.name, secrets: projectSecrets(project) })); };

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
const ready = p => !p.apiKeyEnv || Boolean(process.env[p.apiKeyEnv]);

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
  const gone = new Set([...pruneDir(recordingsDir, keep, '.mp4'), ...pruneDir(guidesDir, keep, '.pdf')]);
  if (!gone.size) return;
  // history keeps the run, without links to files that no longer exist
  for (const r of listRuns()) if (gone.has(r.video) || gone.has(r.guide))
    patchRun(r.id, { ...(gone.has(r.video) && { video: undefined }), ...(gone.has(r.guide) && { guide: undefined }) });
}
// Playwright MCP writes a snapshot file per step to app/runs; nothing reads them, so each AI run starts empty
const clearMcpScratch = () => rmSync(join(dir, 'runs'), { recursive: true, force: true });

/* ---------- runs ---------- */
// One live stage, so runs take turns. A run that arrives while another is going waits in line (FIFO)
// instead of being rejected; a client that leaves while waiting drops out of the line.
let running = false;
const waiting = [];
function takeTurn(res) {
  if (!running && !waiting.length) { running = true; return Promise.resolve(); }
  const position = waiting.length + 1;
  res.write(`event: queued\ndata: ${JSON.stringify({ position })}\n\n`);
  return new Promise((resolve, reject) => {
    const w = { resolve };
    waiting.push(w);
    res.on('close', () => { const i = waiting.indexOf(w); if (i >= 0) { waiting.splice(i, 1); reject(new Error('left the queue')); } });
  });
}
// hand the stage to the next in line (running stays true), or free it
function releaseTurn() { const next = waiting.shift(); if (next) next.resolve(); else running = false; }
let currentAbort; // lets POST /stop end the run while the stream stays open for the video
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { console.log(`Stopped (${sig})`); await stage.shutdown(); process.exit(0); }); // Playwright's own handler doesn't exit

const SYSTEM = `You are a web automation agent. The user watches the browser live.
Use the Playwright browser tools to do the user's task, starting at the given URL.
Take a snapshot before interacting, verify each step, and stop if something blocks you.
Whenever a browser tool takes an "element" description, always fill it with the element's visible label and type, e.g. "Login button" or "Orders menu"; it is shown to the user as the step name.
Values in double braces, like {{ADMIN_PASS}}, {{today}}, {{today+3}}, {{random}} or {{baseUrl}}, are filled in by the system when a browser tool runs: type or use them exactly as written, braces included (e.g. navigate to "{{baseUrl}}/orders"). Uppercase ones are secrets: you will never see their value and must not try to reveal it.
When done, answer in English (even if the task is written in another language) with:
1. A first line exactly "RESULT: SUCCESS" or "RESULT: FAILED", then the evidence (message, URL, number shown on screen).
2. A @playwright/test TypeScript test in one \`\`\`ts block that replays the steps, using role/label/placeholder locators. Keep every double-brace value as a literal string, e.g. '{{ADMIN_PASS}}' or '{{today}}'.`;

const stamp = t => new Date(t).toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Shared shell for AI runs and replays: SSE stream, abort, recording, history entry
let currentRun = null; // { project }: who may watch and stop it
async function withRun(res, { kind, record, guide, label, project, userId }, body) {
  const send = (type, data) => { if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  const abort = currentAbort = new AbortController();
  res.on('close', () => abort.abort()); // tab closed
  const started = Date.now();
  const id = `${stamp(started)}-${kind}`;
  const video = `${stamp(started)}-${label}.mp4`;
  const entry = { id, kind, started, project, ...(userId && { userId }) };
  currentRun = { project };
  stage.setAudience(project); // the live view is shown only to members of this project
  const rec = loadRecording();
  if (rec.device) entry.device = rec.device;
  let stopRecording;
  const steps = guide ? guideCollector(stage.currentFrame) : null;
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
    await body({ send, signal: abort.signal, entry, rec, mask, addGuideStep, startRecording: () => { if (record && !stopRecording) stopRecording = stage.startRecording(join(recordingsDir, video), rec); } });
  } catch (e) {
    entry.status = abort.signal.aborted ? 'stopped' : 'error';
    if (entry.status === 'stopped') send('stopped', 'Stopped'); else { entry.error = e.message; send('fail', e.message); }
  } finally {
    entry.secs = Math.round((Date.now() - started) / 1000);
    if (entry.blocked) {
      entry.status = 'blocked';
      entry.error = `Blocked: the run tried to open ${entry.blocked}, a production address (Settings > Environments). The browser never reached it.`;
      send('fail', entry.error);
    }
    if (stopRecording) {
      const err = await stopRecording(); // saved even when the run failed or was stopped: that's when you need it most
      if (err) send('fail', `Recording failed: ${err}`); else { entry.video = video; send('video', `/recordings/${video}`); }
    }
    stopBoxes?.(); stopIssues();
    if (steps) {
      const name = `${stamp(started)}-${label}.pdf`;
      try { await buildGuidePdf(entry, steps.finish(), join(guidesDir, name), { ...loadGuide(), logo: logoDataUrl() }); entry.guide = name; send('guide', `/guides/${name}`); }
      catch (e) { send('fail', `PDF guide failed: ${e.message}`); }
    }
    addRun(entry);
    send('saved', { id });
    stage.closeWhenIdle();
    pruneOutputs(rec.keep ?? DEFAULT_RECORDING.keep);
    releaseTurn();
    res.end();
  }
}

function aiRun(res, { project, userId, url, task, provider, model, record, guide, session, flow, env, expected }) {
  return withRun(res, { kind: 'ai', record, guide, label: provider.id, project, userId }, async ({ send, signal, entry, rec, startRecording, addGuideStep }) => {
    Object.assign(entry, { url, task, provider: provider.label, model: model || provider.model || '', session: session || undefined, flow: flow || undefined, env: env.name || undefined, expected: expected || undefined, steps: [] });
    writeRunVars(env, project);
    await resetDatabase(project, env, line => send('text', line));
    const startUrl = makeResolver({ vars: env.vars }).fill(url); // {{baseUrl}} in the URL field
    const sessionData = session ? JSON.parse(readFileSync(pickSession(project, session), 'utf8')) : null;
    clearMcpScratch();
    await stage.ownBrowser(rec, sessionData);
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
      provider, model: model || provider.model, prompt, system: SYSTEM, mcpConfigPath, mcpServer, cwd: dir,
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
async function playTests(files, { project, rec, session, storageFile, testDir, testDataDir, vars, envName, dbUrl, repeatEach, dataRows, updateSnapshots }, { send, signal, entry, mask, startRecording, addGuideStep }) {
  await stage.claimPort(stage.REPLAY_CDP_PORT); // the live view must attach to this run's browser, not another one
  const runnerDone = new AbortController(); // stop waiting for the browser if the runner ends first (e.g. a compile error)
  const watchSignal = AbortSignal.any([signal, runnerDone.signal]);
  const watching = stage.watchReplayBrowser(rec, watchSignal).then(() => { if (!watchSignal.aborted) startRecording(); });
  entry.log ??= []; entry.replaySteps ??= [];
  const onLine = line => { if (entry.log.length < 500) entry.log.push(line); send('log', line); };
  const onStep = raw => {
    const step = replayStep(raw, mask);
    addGuideStep(step);
    if (step && entry.replaySteps.length < 500) { entry.replaySteps.push(step); send('step', step); }
  };
  let result;
  try { result = await runTests(files, { ...rec, sessionFile: storageFile ?? pickSession(project, session), secrets: projectSecrets(project), apiKeyEnvs: loadProviders().map(pr => pr.apiKeyEnv).filter(Boolean), testDir, testDataDir, dbUrl, vars, envName, repeatEach, dataRows, updateSnapshots }, { onLine, onStep }, signal); }
  finally { runnerDone.abort(); await watching; }
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

function replayRun(res, { project, userId, names, record, guide, session, env, times = 1, schedule, updateSnapshots = false }) {
  return withRun(res, { kind: 'replay', record, guide, label: names.length > 1 ? 'suite' : names[0], project, userId }, async ctx => {
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
function fixRun(res, { run, userId, name, provider, model, env }) {
  const { project } = run;
  return withRun(res, { kind: 'fix', record: false, guide: false, label: `fix-${name}`, project, userId }, async ctx => {
    const { send, signal, entry, rec } = ctx;
    const failed = run.tests.find(t => t.file.replace(/\.spec\.ts$/, '') === name);
    const original = readTest(project, name);
    Object.assign(entry, { task: `Fix test: ${name}`, testNames: [name], fixOf: run.id, provider: provider.label, model: model || provider.model || '', session: run.session, env: env.name || undefined, original, steps: [] });
    writeRunVars(env, project);
    await resetDatabase(project, env, line => send('text', line));
    const sessionData = run.session ? JSON.parse(readFileSync(pickSession(project, run.session), 'utf8')) : null;
    clearMcpScratch();
    await stage.ownBrowser(rec, sessionData);

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
    const { text } = await engines[provider.engine]({ provider, model: model || provider.model, prompt, system: SYSTEM, mcpConfigPath, mcpServer, cwd: dir }, emit, signal);
    const { evidence, script } = splitAnswer(text);
    Object.assign(entry, { text, evidence });
    if (!/RESULT:\s*SUCCESS/.test(text) || !script || !/\btest\(/.test(script)) {
      entry.status = 'fail';
      send('done', { ok: false, text, secs: Math.round((Date.now() - entry.started) / 1000) });
      return;
    }
    entry.script = prepareScript(script, { urlVars: urlVars() });
    send('log', 'Verifying the corrected test with plain Playwright (no AI)…');
    mkdirSync(fixesDir, { recursive: true });
    const file = join(fixesDir, `${name}.spec.ts`);
    // same script, but its helper import must point back to tests/support from here
    const support = relative(fixesDir, join(testsDir, 'support', 'vars')).split('\\').join('/');
    writeFileSync(file, prepareScript(script, { urlVars: urlVars(), supportImport: support.startsWith('.') ? support : `./${support}` }));
    const { tests, ok } = await playTests([file], { project, rec, session: run.session, testDir: fixesDir, testDataDir: join(projectDir(project), 'data'), vars: env.vars, envName: env.name, dbUrl: projectDb(project, env.name)?.url }, ctx);
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
function workflowRun(res, { project, userId, wf, params, env, session, record, guide, provider, model }) {
  return withRun(res, { kind: 'workflow', record, guide, label: `wf-${wf.id}`, project, userId }, async ctx => {
    const { send, signal, entry, rec, mask, startRecording, addGuideStep } = ctx;
    Object.assign(entry, { task: `Workflow: ${wf.name}`, workflow: wf.id, params, env: env.name || undefined, session: session || undefined, provider: provider.label, model: model || provider.model || '', blocks: [], steps: [] });
    writeRunVars(env, project);
    await resetDatabase(project, env, line => send('text', line));
    const secrets = projectSecrets(project);
    // HTTP blocks fill {{...}} here, with this project's secrets only
    const resolver = makeResolver({ vars: env.vars, secrets: Object.fromEntries(secrets.map(n => [n, process.env[`SECRET_${n}`]])), envName: env.name });
    let storage = session ? JSON.parse(readFileSync(pickSession(project, session), 'utf8')) : null;
    let browserOpen = false;
    const openBrowser = async () => {
      if (browserOpen) return;
      clearMcpScratch();
      await stage.ownBrowser(rec, storage);
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
      // on a shared server a request may only go to this app's own addresses, not to the server's network
      if (SERVER_MODE && !loadEnvironments().filter(e => !e.production).some(e => Object.values(e.vars).some(v => /^https?:\/\//.test(v) && guard.hostOf(v) === guard.hostOf(url))))
        throw new Error(`${guard.hostOf(url)} is not an address of any environment: on a shared server, requests only go to those`);
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
          const file = join(dataDir, `wf-storage-${entry.id}.json`);
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
          const { text } = await engines[provider.engine]({ provider, model: model || provider.model, prompt, system: WF_SYSTEM, mcpConfigPath, mcpServer, cwd: dir }, emit, signal);
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
    await takeTurn(res);
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

/* ---------- accounts and access ---------- */
// Local mode (default): http://127.0.0.1 on this computer. Server mode (APP_MODE=server): shared by a team
// behind an HTTPS reverse proxy; HOST sets the listen address, APP_HOSTS the host names users open.
const SERVER_MODE = process.env.APP_MODE === 'server';
const HOST = process.env.HOST ?? '127.0.0.1';
const APP_HOSTS = (process.env.APP_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
// First start: whoever creates the first account becomes admin. Locally that is anyone on this computer;
// on a server they also need the code printed in the server log.
let setupCode = userCount() ? null : randomBytes(4).toString('hex');
const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const sessionToken = req => (req.headers.cookie ?? '').match(/(?:^|;\s*)abr_session=([a-f0-9]{64})/)?.[1];
const sessionCookie = (token, maxAge) => `abr_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${SERVER_MODE ? '; Secure' : ''}`;
const denied = (msg, status = 403) => Object.assign(new Error(msg), { status });
function need(user, project, role) {
  if (!can(user, project, role)) throw denied(roleIn(user, project) ? `This needs the ${role} role in this project` : 'You are not a member of this project');
  projectDir(project);
}
const needAdmin = user => { if (!user.admin) throw denied('Only an admin can do this'); };
// a run (and its video, PDF, screenshots) may be seen by members of its project
const needRun = (user, run, role = 'viewer') => {
  if (!run) throw denied('Run not found', 404);
  if (run.project ? !can(user, run.project, role) : !user.admin) throw denied('You are not a member of this run\'s project');
};

/* ---------- http ---------- */
// Only this page may call the API: blocks other sites (CSRF / key theft via baseURL) and DNS rebinding
const sameOrigin = req => {
  const host = (req.headers.host ?? '').toLowerCase();
  const known = /^(127\.0\.0\.1|localhost):\d+$/.test(host) || APP_HOSTS.includes(host) || APP_HOSTS.includes(host.replace(/:\d+$/, ''));
  return known && ['same-origin', 'none', undefined].includes(req.headers['sec-fetch-site']);
};
const json = (res, data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const fail = (res, e, code = e.status ?? 400) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(e.message ?? String(e)); };
const readBody = req => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 500_000) { reject(new Error('Request body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
});
const sse = res => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
const sendFile = (res, file, headers) => { if (!existsSync(file)) { res.writeHead(404); return res.end(); } res.writeHead(200, headers); return createReadStream(file).pipe(res); };

async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname, m = req.method;
  const q = k => u.searchParams.get(k) ?? '';

  // the page itself: it shows the login screen when there is no session
  if (p === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readFileSync(join(dir, 'index.html'))); }
  const STATIC = { '/shared.mjs': 'text/javascript', '/app.js': 'text/javascript', '/studio.js': 'text/javascript', '/app.css': 'text/css' };
  if (STATIC[p]) { res.writeHead(200, { 'content-type': `${STATIC[p]}; charset=utf-8` }); return res.end(readFileSync(join(dir, p.slice(1)))); }

  /* ----- sign in ----- */
  const user = userOf(sessionToken(req));
  if (p === '/auth/me') return json(res, { user, setup: !userCount(), setupNeedsCode: SERVER_MODE || !isLoopback(req), serverMode: SERVER_MODE });
  if (p === '/auth/setup' && m === 'POST') {
    const { name, email, password, code } = await readBody(req);
    if (userCount()) throw denied('Setup is already done: sign in');
    if ((SERVER_MODE || !isLoopback(req)) && code !== setupCode) throw denied('Wrong setup code: it is printed in the server log');
    createUser({ name, email, password, admin: true, mustChange: false });
    setupCode = null;
    const { token, maxAge } = login(email, password);
    res.setHeader('set-cookie', sessionCookie(token, maxAge));
    return json(res, { ok: true });
  }
  if (p === '/auth/login' && m === 'POST') {
    const { email, password } = await readBody(req);
    const { token, maxAge } = login(email, password);
    res.setHeader('set-cookie', sessionCookie(token, maxAge));
    return json(res, { ok: true });
  }
  if (p === '/auth/logout' && m === 'POST') { logout(sessionToken(req)); res.setHeader('set-cookie', sessionCookie('', 0)); return json(res, { ok: true }); }
  if (!user) throw denied('Sign in first', 401);
  if (p === '/auth/password' && m === 'POST') {
    const { current, next } = await readBody(req);
    changeOwnPassword(user.id, current, next);
    return json(res, { ok: true });
  }
  if (user.mustChange) throw denied('Choose your own password first', 403);

  /* ----- live view, files, stop ----- */
  if (p === '/screen') { sse(res); return stage.addViewer(res, project => Boolean(project) && can(user, project, 'viewer')); }

  const recMatch = p.match(/^\/recordings\/([\w-]+\.mp4)$/);
  if (recMatch) {
    needRun(user, runOfFile('video', recMatch[1]));
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
  if (visMatch) { needRun(user, getRun(visMatch[1])); return sendFile(res, join(visualDir, visMatch[1], visMatch[2]), { 'content-type': visMatch[3] === 'jpg' ? 'image/jpeg' : 'image/png' }); }
  const guideMatch = p.match(/^\/guides\/([\w-]+\.pdf)$/);
  if (guideMatch) {
    needRun(user, runOfFile('guide', guideMatch[1]));
    return sendFile(res, join(guidesDir, guideMatch[1]), { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="guide-${guideMatch[1]}"` });
  }
  if (p === '/stop' && m === 'POST') {
    if (!currentRun || !can(user, currentRun.project, 'tester')) throw denied('You can only stop runs of your own projects');
    currentAbort?.abort(); res.writeHead(204); return res.end();
  }

  /* ----- users (admin) and the member picker ----- */
  if (p === '/users' && m === 'GET') { needAdmin(user); return json(res, listUsers()); }
  if (p === '/users' && m === 'POST') { needAdmin(user); return json(res, { id: createUser(await readBody(req)) }); }
  const userMatch = p.match(/^\/users\/(\d+)$/);
  if (userMatch && m === 'PUT') { needAdmin(user); updateUser(Number(userMatch[1]), await readBody(req), user.id); return json(res, { ok: true }); }
  if (p === '/users/directory') { // to add members: maintainers of any project, and admins
    if (!user.admin && !Object.values(user.roles).includes('maintainer')) throw denied('Only maintainers can add members');
    return json(res, listUsers().filter(x => x.active).map(({ id, name, email }) => ({ id, name, email })));
  }

  /* ----- settings: admins change them; everyone gets what the run forms need ----- */
  if (p === '/settings' && m === 'GET') {
    const providers = loadProviders().filter(pr => !SERVER_MODE || pr.engine !== 'claude-code').map(pr => ({ ...pr, ready: ready(pr) }));
    const base = { serverMode: SERVER_MODE, engines: Object.keys(engines).filter(e => !SERVER_MODE || e !== 'claude-code'), days: DAYS, activeEnv: defaultEnv(), recording: loadRecording() };
    if (!user.admin) return json(res, { ...base, providers: providers.map(({ id, label, engine, model, ready: r }) => ({ id, label, engine, model, ready: r })), environments: loadEnvironments().filter(e => !e.production) });
    // never send key/secret values to the browser, only names and whether a key is set
    return json(res, { ...base, providers, devices: DEVICES, schedules: loadSettingsFile().schedules ?? [], guide: loadGuide(), guideLangs: GUIDE_LANGS, hasLogo: existsSync(logoFile), notify: loadSettingsFile().notify ?? {}, secrets: secretNames(), secretProjects: secretProjects(), environments: loadEnvironments() });
  }
  if (p === '/settings' && m === 'POST') {
    needAdmin(user);
    const { providers, recording, secrets, secretProjects: scopes, environments, activeEnv, schedules, notify: notifyCfg, guide } = await readBody(req);
    const guideCfg = validGuide(guide ?? loadGuide());
    const envs = validEnvironments(environments, activeEnv);
    const scheds = validSchedules(schedules ?? [], testExists);
    const chat = String(notifyCfg?.telegramChatId ?? '').trim();
    if (chat && !/^-?\d+$|^@\w+$/.test(chat)) throw new Error('Telegram chat id is a number (or @channelname)');
    const rec = validRecording(recording ?? {}); // validate everything before writing anything
    const [saved, keyWrites] = validProviders(providers);
    if (SERVER_MODE && saved.some(pr => pr.engine === 'claude-code')) throw new Error('On a shared server, use an API provider: a personal Claude subscription cannot be shared');
    const secretWrites = validSecrets(secrets);
    const scoped = validSecretProjects(scopes, listProjects().map(pr => pr.id));
    for (const [k, v] of [...keyWrites, ...secretWrites]) saveEnv(k, v);
    writeFileSync(providersPath, JSON.stringify(saved, null, 2) + '\n');
    writeFileSync(settingsPath, JSON.stringify({ recording: rec, ...envs, schedules: scheds, notify: { telegramChatId: chat }, guide: guideCfg, secretProjects: scoped }, null, 2) + '\n');
    res.writeHead(200); return res.end('ok');
  }

  /* ----- projects ----- */
  if (p === '/projects' && m === 'GET') { // the start screen: the projects this user belongs to
    const all = listProjects(), ids = visibleProjects(user, all.map(pr => pr.id));
    const runs = listRuns(ids);
    return json(res, all.filter(pr => ids.includes(pr.id)).map(({ db, ...pr }) => {
      const own = runs.filter(r => r.project === pr.id), role = roleIn(user, pr.id);
      return {
        ...pr, role, tests: listTests(pr.id).map(t => t.name), runs: own.length,
        last: own[0] ? { status: own[0].status, started: own[0].started } : null, recent: own.slice(0, 12).map(r => r.status),
        secrets: projectSecrets(pr.id), sessions: listSessions(pr.id),
        ...(role === 'maintainer' && { db, dbPassSet: Object.fromEntries(Object.keys(db ?? {}).map(e => [e, Boolean(process.env[dbPassKey(pr.id, e)])])) }),
      };
    }));
  }
  const projMatch = p.match(/^\/projects\/([a-z0-9-]+)$/);
  if ((p === '/projects' && m === 'POST') || (projMatch && m === 'PUT')) {
    if (projMatch) need(user, projMatch[1], 'maintainer'); else needAdmin(user);
    const { dbPasswords = {}, ...fields } = await readBody(req);
    const db = validDb(fields.db); // before writing anything
    for (const v of Object.values(dbPasswords)) if (/[\r\n]/.test(String(v))) throw new Error('Invalid database password');
    const id = saveProject(projMatch?.[1], { ...fields, db });
    for (const [envName, pass] of Object.entries(dbPasswords)) if (pass && db[envName]) saveEnv(dbPassKey(id, envName), String(pass));
    return json(res, { id });
  }
  if (p === '/db/test' && m === 'POST') { // settings not saved yet: the password typed now, else the saved one
    const { project: pr, env: envName, config, password } = await readBody(req);
    if (pr) need(user, pr, 'maintainer'); else needAdmin(user);
    const cfg = validDb({ [envName]: config })[envName];
    const pass = password || (pr ? process.env[dbPassKey(pr, envName)] : '');
    return json(res, { ok: true, server: await testDb(cfg, pass) });
  }
  if (projMatch && m === 'DELETE') { // its tests, runs, videos, PDFs, members, sessions and database passwords
    needAdmin(user);
    const id = projMatch[1];
    const dbKeys = Object.keys(readProject(id).db ?? {}).map(e => dbPassKey(id, e));
    deleteProject(id);
    for (const k of dbKeys) saveEnv(k, null);
    dropProjectMembers(id);
    rmSync(join(sessionsDir, id), { recursive: true, force: true });
    for (const r of removeRuns(id)) {
      if (r.video) rmSync(join(recordingsDir, r.video), { force: true });
      if (r.guide) rmSync(join(guidesDir, r.guide), { force: true });
      rmSync(join(visualDir, r.id), { recursive: true, force: true });
    }
    res.writeHead(204); return res.end();
  }
  const memMatch = p.match(/^\/projects\/([a-z0-9-]+)\/members$/);
  if (memMatch) {
    need(user, memMatch[1], 'maintainer');
    if (m === 'PUT') { const { userId, role } = await readBody(req); setMember(memMatch[1], Number(userId), role ?? null); }
    return json(res, listMembers(memMatch[1]));
  }
  const projSes = p.match(/^\/projects\/([a-z0-9-]+)\/sessions\/([a-z0-9-]+)$/);
  if (projSes && m === 'DELETE') { need(user, projSes[1], 'maintainer'); unlinkSync(sessionFile(projSes[1], projSes[2])); res.writeHead(204); return res.end(); }
  if (p === '/sessions' && m === 'POST') { // "Save login session" after an AI run or a recording
    const { project: pr, name, flowId } = await readBody(req);
    need(user, pr, 'tester');
    const file = sessionFile(pr, slug(name));
    const state = flowId ? JSON.parse(flowStorage(flowId)) : await stage.saveSession();
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(state));
    return json(res, { name: slug(name), cookies: state.cookies.length });
  }

  /* ----- saved tests of one project: ?project=<id> on every call ----- */
  const project = q('project');
  const testMatch = p.match(/^\/tests\/([a-z0-9-]+)$/);
  const dataMatch = p.match(/^\/tests\/([a-z0-9-]+)\/data$/);
  if (p === '/tests' || testMatch || dataMatch) need(user, project, m === 'GET' ? 'viewer' : m === 'DELETE' ? 'maintainer' : 'tester');
  if (p === '/tests' && m === 'GET') return json(res, listTests(project));
  if (p === '/tests' && m === 'POST') {
    const { name, runId, code, overwrite } = await readBody(req);
    let script = code;
    if (runId) { const run = getRun(runId); needRun(user, run, 'tester'); script = run.script; }
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
  if (p === '/workflows' || wfMatch) need(user, project, m === 'GET' ? 'viewer' : m === 'DELETE' ? 'maintainer' : 'tester');
  if (p === '/workflows' && m === 'GET') return json(res, listWorkflows(project));
  if (wfMatch && m === 'GET') return json(res, readWorkflow(project, wfMatch[1]));
  if ((p === '/workflows' && m === 'POST') || (wfMatch && m === 'PUT')) {
    const wf = validWorkflow(await readBody(req), { testExists: name => testExists(project, name) });
    return json(res, { id: saveWorkflow(project, wfMatch?.[1], wf) });
  }
  if (wfMatch && m === 'DELETE') { deleteWorkflow(project, wfMatch[1]); res.writeHead(204); return res.end(); }

  /* ----- history ----- */
  if (p === '/history') { need(user, project, 'viewer'); return json(res, listRuns(project)); }
  const histMatch = p.match(/^\/history\/([\w-]+)$/);
  if (histMatch) { const r = getRun(histMatch[1]); needRun(user, r); return json(res, r); }
  const repMatch = p.match(/^\/report\/([\w-]+)$/);
  if (repMatch) {
    const r = getRun(repMatch[1]);
    needRun(user, r);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `attachment; filename="report-${r.id}.html"` });
    return res.end(buildReport(r, recordingsDir));
  }

  /* ----- record flow (a window on this computer's desktop: local mode only) ----- */
  if (p === '/record' && m === 'GET') {
    if (SERVER_MODE) throw new Error('Record flow opens a window on the server\'s own screen, so it is off on a shared server');
    need(user, project, 'tester');
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
    needAdmin(user);
    const sched = (loadSettingsFile().schedules ?? []).find(x => x.id === schedRun[1]);
    if (!sched) return fail(res, 'Schedule not found', 404);
    runSchedule(sched);
    return json(res, { queued: true });
  }
  if (p === '/ci/export' && m === 'POST') {
    needAdmin(user);
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
    needAdmin(user);
    const { dataUrl } = await readBody(req);
    const match = String(dataUrl ?? '').match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error('The logo must be a PNG or JPG image');
    mkdirSync(join(logoFile, '..'), { recursive: true });
    writeFileSync(logoFile, `${match[1]}\n${match[2]}`);
    return json(res, { ok: true });
  }
  if (p === '/branding/logo' && m === 'DELETE') { needAdmin(user); rmSync(logoFile, { force: true }); res.writeHead(204); return res.end(); }
  if (p === '/branding/logo' && m === 'GET') {
    const url = logoDataUrl();
    if (!url) { res.writeHead(404); return res.end(); }
    const [, type, b64] = url.match(/^data:([^;]+);base64,(.*)$/);
    res.writeHead(200, { 'content-type': type }); return res.end(Buffer.from(b64, 'base64'));
  }
  if (p === '/notify/test' && m === 'POST') {
    needAdmin(user);
    const sent = await notify(loadSettingsFile().notify ?? {}, '🔔 Test message from AI Browser Runner: notifications work.');
    if (!sent.length) throw new Error('Nothing is set up: add the secret TELEGRAM_TOKEN plus a chat id, or the secret SLACK_WEBHOOK');
    return json(res, { sent });
  }

  /* ----- runs ----- */
  const pickProvider = () => {
    const providers = loadProviders().filter(pr => !SERVER_MODE || pr.engine !== 'claude-code');
    const provider = providers.find(pr => pr.id === q('provider')) ?? providers[0];
    if (!provider) throw new Error('No AI provider is set up: an admin adds one in Settings');
    if (!ready(provider)) throw new Error(`${provider.apiKeyEnv} is not set`);
    return provider;
  };
  if (p === '/fix') {
    const run = getRun(q('run')), name = q('test');
    needRun(user, run, 'tester');
    if (!run.tests?.some(t => t.status !== 'passed' && t.file.replace(/\.spec\.ts$/, '') === name)) throw new Error('That test did not fail in this run');
    if (!existsSync(testPath(run.project, name))) throw new Error(`Test "${name}" not found`);
    const provider = pickProvider();
    const env = pickEnv(q('env') || run.env);
    sse(res); await takeTurn(res); // after every check: waits if another run is going
    return fixRun(res, { run, userId: user.id, name, provider, model: q('model'), env });
  }
  if (p === '/workflow-run') {
    need(user, project, 'tester');
    const saved = readWorkflow(project, q('workflow'));
    const wf = { id: saved.id, ...validWorkflow(saved, { testExists: name => testExists(project, name) }) }; // its tests may be gone
    const given = JSON.parse(q('params') || '{}');
    const params = Object.fromEntries(wf.params.map(x => [x.name, String(given[x.name] ?? x.default).slice(0, 500)]));
    const session = q('session');
    if (session) pickSession(project, session);
    const env = pickEnv(q('env'));
    const provider = pickProvider();
    sse(res); await takeTurn(res);
    return workflowRun(res, { project, userId: user.id, wf, params, env, session, record: q('record') === '1', guide: q('guide') === '1', provider, model: q('model') });
  }
  if (p === '/run' || p === '/replay') {
    need(user, project, 'tester'); // every run belongs to a project
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
      sse(res); await takeTurn(res);
      return aiRun(res, { project, userId: user.id, url, task, provider, model: q('model'), record, guide, session, flow, env, expected: q('expected').trim() });
    }
    const names = q('tests').split(',').filter(Boolean);
    if (!names.length) throw new Error('Select at least one test');
    for (const n of names) if (!existsSync(testPath(project, n))) throw new Error(`Test "${n}" not found`); // also validates names
    const times = Number(q('repeat') || 1);
    if (![1, 3, 5].includes(times)) throw new Error('Repeat must be 1, 3 or 5');
    sse(res); await takeTurn(res); // only after every check
    return replayRun(res, { project, userId: user.id, names, record, guide, session, env, times, updateSnapshots: q('update') === '1' });
  }
  res.writeHead(404); res.end();
}

http.createServer((req, res) => {
  if (!sameOrigin(req)) { res.writeHead(403); return res.end('forbidden'); }
  route(req, res).catch(e => { if (!res.headersSent) fail(res, e); else res.end(); });
}).listen(PORT, HOST, () => {
  console.log(`AI Browser Runner → http://${HOST}:${PORT}${SERVER_MODE ? ` (server mode; hosts: ${APP_HOSTS.join(', ') || 'none set in APP_HOSTS'})` : ''}`);
  if (setupCode) console.log(`First start: create the admin account in the browser.${SERVER_MODE ? ` Setup code: ${setupCode}` : ` (from another computer it asks for this code: ${setupCode})`}`);
});
