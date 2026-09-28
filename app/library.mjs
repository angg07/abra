// Projects and their saved tests. A project is a folder tests/<project>/ with a project.json; its tests are plain
// @playwright/test files in that folder (data sets in tests/<project>/data/), so they also run from the CLI.
// tests/support/ holds the helpers every project shares.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

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
export function saveProject(id, { name, description = '', url = '', env = '', db } = {}) {
  name = String(name ?? '').trim(); description = String(description).trim(); url = String(url).trim();
  if (!name || name.length > 60) throw new Error('Project name: 1 to 60 characters');
  if (description.length > 300) throw new Error('Description: at most 300 characters');
  if (url && !/^(https?:\/\/|\{\{)\S+$/.test(url)) throw new Error('Start URL must start with http(s):// or {{');
  const meta = { name, description, url, env: String(env), ...(db && { db }) };
  if (id) { const { id: _, ...old } = readProject(id); writeFileSync(metaOf(id), JSON.stringify({ ...old, ...meta }, null, 2) + '\n'); return id; }
  const newId = slug(name).slice(0, 40).replace(/-+$/, '');
  if (!newId || RESERVED.has(newId)) throw new Error('Choose another project name');
  if (existsSync(join(testsDir, newId))) throw new Error(`A project "${newId}" already exists`);
  mkdirSync(join(testsDir, newId), { recursive: true });
  writeFileSync(metaOf(newId), JSON.stringify({ ...meta, created: Date.now() }, null, 2) + '\n');
  return newId;
}
export const deleteProject = id => rmSync(projectDir(id), { recursive: true });

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

// the test, its data set and its visual baselines (<name>.spec.ts-snapshots/)
export function deleteTest(project, name) {
  const file = fileOf(project, name);
  unlinkSync(file);
  rmSync(dataOf(project, name), { force: true });
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
