// Projects and their saved tests. A project is a folder tests/<project>/ with a project.json; its tests are plain
// @playwright/test files in that folder (data sets in tests/<project>/data/), so they also run from the CLI.
// tests/support/ holds the helpers every project shares.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

export const testsDir = join(import.meta.dirname, '..', 'tests');
const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RESERVED = new Set(['support', 'data']);

export const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/* ---------- projects ---------- */
const metaOf = id => join(testsDir, id, 'project.json');
export function projectDir(id) {
  if (!PROJECT.test(id ?? '') || RESERVED.has(id) || !existsSync(metaOf(id))) throw new Error(`Project "${id}" not found`);
  return join(testsDir, id);
}
export const readProject = id => ({ id, ...JSON.parse(readFileSync(join(projectDir(id), 'project.json'), 'utf8')) });
export const listProjects = () => (existsSync(testsDir) ? readdirSync(testsDir, { withFileTypes: true }) : [])
  .filter(d => d.isDirectory() && !RESERVED.has(d.name) && PROJECT.test(d.name) && existsSync(metaOf(d.name)))
  .map(d => readProject(d.name))
  .sort((a, b) => a.name.localeCompare(b.name));

// id undefined = create (the id comes from the name and never changes, so renaming keeps the folder)
// db: the application's database per environment, already validated by the server (passwords live in .env)
// codebase: the application's source folders on this computer (e.g. frontend and backend; the AI may read them),
// a list or one path per line; never exported
export function saveProject(id, { name, description = '', url = '', env = '', app = '', guidePrompt = '', codebase = [], db } = {}) {
  name = String(name ?? '').trim(); description = String(description).trim(); url = String(url).trim(); app = String(app).trim(); guidePrompt = String(guidePrompt).trim();
  codebase = [...new Set((Array.isArray(codebase) ? codebase : String(codebase).split('\n')).map(f => String(f).trim()).filter(Boolean))];
  if (codebase.length > 10) throw new Error('Codebase folders: at most 10');
  for (const f of codebase) if (!isAbsolute(f) || !existsSync(f) || !statSync(f).isDirectory()) throw new Error(`Codebase folder "${f}": a full path to an existing folder`);
  if (!name || name.length > 60) throw new Error('Project name: 1 to 60 characters');
  if (app.length > 60) throw new Error('Application name: at most 60 characters');
  if (description.length > 300) throw new Error('Description: at most 300 characters');
  if (guidePrompt.length > 2000) throw new Error('Instructions for videos and PDF guides: at most 2000 characters');
  if (url && !/^(https?:\/\/|\{\{)\S+$/.test(url)) throw new Error('Start URL must start with http(s):// or {{');
  const meta = { name, description, url, env: String(env), app, guidePrompt, codebase, ...(db && { db }) };
  if (id) { const { id: _, ...old } = readProject(id); writeFileSync(metaOf(id), JSON.stringify({ ...old, ...meta }, null, 2) + '\n'); return id; }
  const newId = slug(name).slice(0, 40).replace(/-+$/, '');
  if (!newId || RESERVED.has(newId)) throw new Error('Choose another project name');
  if (existsSync(join(testsDir, newId))) throw new Error(`A project "${newId}" already exists`);
  mkdirSync(join(testsDir, newId), { recursive: true });
  writeFileSync(metaOf(newId), JSON.stringify({ ...meta, created: Date.now() }, null, 2) + '\n');
  return newId;
}
// The folder picker for codebase folders (the browser cannot tell the page a folder's full path): the
// subfolders of one folder, names only. Starts at the home folder.
export function listFolders(path = '') {
  const here = resolve(String(path).trim() || homedir());
  if (!existsSync(here) || !statSync(here).isDirectory()) throw new Error(`Not a folder: ${here}`);
  const dirs = readdirSync(here, { withFileTypes: true })
    .filter(d => d.isDirectory() || (d.isSymbolicLink() && (() => { try { return statSync(join(here, d.name)).isDirectory(); } catch { return false; } })()))
    .map(d => d.name).sort((a, b) => a.startsWith('.') - b.startsWith('.') || a.localeCompare(b))
    .map(name => ({ name, path: join(here, name) }));
  const parent = dirname(here);
  return { path: here, parent: parent === here ? null : parent, home: homedir(), dirs };
}
export const deleteProject = id => rmSync(projectDir(id), { recursive: true });

// The project's logo (video title card, PDF cover): tests/<id>/logo.png or logo.jpg, so it travels with an export
const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg' };
export const projectLogo = id => ['png', 'jpg'].map(ext => join(projectDir(id), `logo.${ext}`)).find(existsSync) ?? null;
export function saveProjectLogo(id, dataUrl) {
  const match = String(dataUrl ?? '').match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('The logo must be a PNG or JPG image');
  deleteProjectLogo(id);
  writeFileSync(join(projectDir(id), `logo.${LOGO_TYPES[match[1]]}`), Buffer.from(match[2], 'base64'));
}
export const deleteProjectLogo = id => { for (const ext of ['png', 'jpg']) rmSync(join(projectDir(id), `logo.${ext}`), { force: true }); };
export const projectLogoDataUrl = id => { const f = projectLogo(id); return f ? `data:image/${f.endsWith('png') ? 'png' : 'jpeg'};base64,${readFileSync(f).toString('base64')}` : ''; };

/* ---------- saved tests ---------- */
const fileOf = (project, name) => {
  if (!NAME.test(name ?? '')) throw new Error('Test names can only use lowercase letters, digits and "-"');
  return join(projectDir(project), `${name}.spec.ts`);
};

export function listTests(project) {
  const folder = projectDir(project);
  return readdirSync(folder).filter(f => f.endsWith('.spec.ts')).map(f => {
    const code = readFileSync(join(folder, f), 'utf8');
    const name = f.replace(/\.spec\.ts$/, '');
    return {
      name,
      titles: [...code.matchAll(/\btest\(\s*(['"`])(.+?)\1/g)].map(m => m[2]),
      modified: statSync(join(folder, f)).mtimeMs,
      dataRows: Math.max(0, readData(project, name).split('\n').filter(l => l.trim()).length - 1),
    };
  }).sort((a, b) => b.modified - a.modified);
}

export const readTest = (project, name) => readFileSync(fileOf(project, name), 'utf8');

// Script from the AI, a recording or the editor -> runnable test file:
// - addresses held by environment values become that value, e.g. {{appUrl}} (so a test runs on any stage)
// - every string with {{...}} is wrapped in fill() (tests/support/vars.ts resolves it when the test runs)
// - legacy process.env.SECRET_X! stays valid
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// urlVars: [{ name, url }], e.g. { name: 'appUrl', url: 'http://myapp.test' }
export function prepareScript(code, { urlVars = [], supportImport = '../support/vars' } = {}) {
  let out = code;
  const known = urlVars.map(v => ({ ...v, url: v.url.replace(/\/+$/, '') })).filter(v => v.url).sort((a, b) => b.url.length - a.url.length);
  for (const { name, url } of known)
    out = out.replace(new RegExp(`(['"\`])${escapeRe(url)}(?=[/'"\`?#])`, 'g'), `$1{{${name}}}`);
  out = out.replace(/(['"`])((?:(?!\1)[^\\\n]|\\.)*?\{\{[^{}\n]+\}\}(?:(?!\1)[^\\\n]|\\.)*?)\1/g, 'fill($1$2$1)')
    .replace(/(?<![.\w])fill\(fill\(((['"`]).*?\2)\)\)/g, 'fill($1)'); // already wrapped before: keep one
  if (/\bfill\(/.test(out.replace(/\.fill\(/g, '')) && !/from ['"][^'"]*support\/vars['"]/.test(out))
    out = out.replace(/(import[^\n]*@playwright\/test['"];?\n)/, `$1import { fill } from '${supportImport}';\n`);
  if (!/@playwright\/test/.test(out)) out = `import { test, expect } from '@playwright/test';\n${/\bfill\(/.test(out.replace(/\.fill\(/g, '')) ? `import { fill } from '${supportImport}';\n` : ''}\n${out}`;
  return out.endsWith('\n') ? out : out + '\n';
}
// The other way, for showing a test to the AI: fill('...') and process.env.SECRET_X become plain '{{...}}' strings
export const withPlaceholders = code => code
  .replace(/(?<!\.)\bfill\((['"`])(.*?)\1\)/g, '$1$2$1')
  .replace(/process\.env\.SECRET_(\w+)!?/g, "'{{$1}}'");

export function saveTest(project, name, code, overwrite = false, opts = {}) {
  const file = fileOf(project, name);
  if (existsSync(file) && !overwrite) throw new Error(`A test named "${name}" already exists. Choose another name.`);
  if (!/\btest\(/.test(code)) throw new Error('The script has no test()');
  if (code.length > 200_000) throw new Error('The script is too large');
  writeFileSync(file, prepareScript(code, opts));
  return name;
}

// the test, its data set, its upload files and its visual baselines (<name>.spec.ts-snapshots/)
export function deleteTest(project, name) {
  const file = fileOf(project, name);
  unlinkSync(file);
  rmSync(dataOf(project, name), { force: true });
  rmSync(join(dirname(file), 'files', name), { recursive: true, force: true }); // its upload files (test-files.mjs)
  rmSync(`${file}-snapshots`, { recursive: true, force: true });
}

// Data set for a test: tests/<project>/data/<name>.csv (header row + one row per run)
const dataOf = (project, name) => join(dirname(fileOf(project, name)), 'data', `${name}.csv`);
export const readData = (project, name) => (existsSync(dataOf(project, name)) ? readFileSync(dataOf(project, name), 'utf8') : '');
export function saveData(project, name, csv) {
  const f = dataOf(project, name);
  if (!csv.trim()) { if (existsSync(f)) unlinkSync(f); return; }
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, csv.endsWith('\n') ? csv : csv + '\n');
}
export const testPath = (project, name) => fileOf(project, name);

/* ---------- workflows: tests/<project>/workflows/<id>.json (validated by workflow.mjs) ---------- */
const wfDir = project => join(projectDir(project), 'workflows');
const wfFile = (project, id) => {
  if (!NAME.test(id ?? '')) throw new Error('Workflow not found');
  return join(wfDir(project), `${id}.json`);
};
export const listWorkflows = project => (existsSync(wfDir(project)) ? readdirSync(wfDir(project)) : [])
  .filter(f => f.endsWith('.json'))
  .map(f => {
    const wf = JSON.parse(readFileSync(join(wfDir(project), f), 'utf8'));
    const count = bs => bs.reduce((n, b) => n + 1 + count(b.blocks ?? []), 0);
    return { id: f.slice(0, -5), name: wf.name, description: wf.description, params: wf.params, blocks: count(wf.blocks), modified: statSync(join(wfDir(project), f)).mtimeMs };
  })
  .sort((a, b) => b.modified - a.modified);
export const readWorkflow = (project, id) => ({ id, ...JSON.parse(readFileSync(wfFile(project, id), 'utf8')) });
// id undefined = a new one, named after the workflow
export function saveWorkflow(project, id, wf) {
  if (!id) {
    const base = slug(wf.name).slice(0, 50) || 'workflow';
    id = base;
    for (let i = 2; existsSync(wfFile(project, id)); i++) id = `${base}-${i}`;
  }
  mkdirSync(wfDir(project), { recursive: true });
  writeFileSync(wfFile(project, id), JSON.stringify(wf, null, 2) + '\n');
  return id;
}
export const deleteWorkflow = (project, id) => unlinkSync(wfFile(project, id));
