// Saved prompts: Run AI forms kept to run later, one file per prompt in tests/<project>/prompts/<id>.json;
// the files they upload in tests/<project>/prompt-files/<id>/<name>. Opening one copies its files into fresh
// Run AI uploads (test-files.mjs), so a run from a saved prompt goes the usual way.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, slug } from './library.mjs';
import { cleanFileName, filesIn, saveUpload } from './test-files.mjs';
import { cleanInstructions } from './shared.mjs';

const ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const UPLOAD_ID = /^[0-9a-f]{16}$/;
const notFound = () => Object.assign(new Error('Prompt not found'), { status: 404 });
const dirOf = project => join(projectDir(project), 'prompts');
const fileOf = (project, id) => { if (!ID.test(id ?? '')) throw notFound(); return join(dirOf(project), `${id}.json`); };
const filesDir = (project, id) => { fileOf(project, id); return join(projectDir(project), 'prompt-files', id); };

// the fields of the Run AI form; anything else is dropped
export function validPrompt(b = {}) {
  const text = (v, max, label) => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string' || v.length > max) throw new Error(`${label} must be text of at most ${max} characters`);
    return v;
  };
  const task = text(b.task, 10_000, 'The instructions');
  if (!task.trim()) throw new Error('The instructions are required');
  const instructions = cleanInstructions(b.instructions);
  if (b.instructions && !instructions) throw new Error('The attached instructions must be a text file of at most 100 KB');
  const url = text(b.url, 2000, 'The URL').trim();
  if (url && !/^(https?:\/\/|\{\{)\S*$/.test(url)) throw new Error('The URL must start with http(s):// or {{');
  return {
    title: text(b.title, 100, 'The title').trim(), url, task, expected: text(b.expected, 2000, 'The expected result').trim(),
    env: text(b.env, 60, 'The environment'), provider: text(b.provider, 60, 'The AI'), model: text(b.model, 100, 'The model').trim(),
    session: text(b.session, 100, 'The login session'), record: b.record === true, guide: b.guide === true, flow: text(b.flow, 100, 'The flow'), instructions,
  };
}

// a prompt file may come from an import or a hand edit: only known fields of the right type, only clean file names
// (no path out of its folder), and the id is always the file's own name
const cleanName = n => { try { return typeof n === 'string' && n === cleanFileName(n); } catch { return false; } };
export function readPrompt(project, id) {
  const f = fileOf(project, id);
  if (!existsSync(f)) throw notFound();
  let raw;
  try { raw = JSON.parse(readFileSync(f, 'utf8')); } catch { throw new Error(`Saved prompt "${id}" cannot be read: its file is not valid JSON`); }
  const text = v => (typeof v === 'string' ? v : '');
  return {
    title: text(raw?.title), url: text(raw?.url), task: text(raw?.task), expected: text(raw?.expected), env: text(raw?.env),
    provider: text(raw?.provider), model: text(raw?.model), session: text(raw?.session), record: raw?.record === true, guide: raw?.guide === true,
    flow: text(raw?.flow), instructions: cleanInstructions(raw?.instructions), saved: text(raw?.saved), files: (Array.isArray(raw?.files) ? raw.files : []).filter(cleanName), id,
  };
}
export const promptExists = (project, id) => { try { return existsSync(fileOf(project, id)); } catch { return false; } };

export const listPrompts = project => (existsSync(dirOf(project)) ? readdirSync(dirOf(project)) : [])
  .filter(f => f.endsWith('.json') && ID.test(f.slice(0, -5)))
  .flatMap(f => { // one unreadable file does not hide the others
    try { const p = readPrompt(project, f.slice(0, -5)); return [{ id: p.id, title: p.title, url: p.url, task: p.task.slice(0, 200), files: p.files, saved: p.saved }]; } catch { return []; }
  })
  .sort((a, b) => String(b.saved).localeCompare(String(a.saved)));

// id undefined = a new prompt, named after its title (or the start of its instructions).
// body.files: [{ id, name }] = a Run AI upload to keep, [{ name }] = a file the prompt already has; any other file goes.
export function savePrompt(project, id, body, uploadsDir) {
  const p = validPrompt(body);
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length > 20) throw new Error('At most 20 files per prompt');
  if (id) readPrompt(project, id); // it must exist
  else {
    const base = slug(p.title || p.task.slice(0, 40)).slice(0, 50) || 'prompt';
    id = base;
    for (let i = 2; existsSync(fileOf(project, id)); i++) id = `${base}-${i}`;
  }
  const dir = filesDir(project, id);
  // every file is checked before anything is written
  const keep = files.map(f => {
    const name = cleanFileName(f?.name);
    if (name !== f.name) throw new Error(`File name "${f?.name}" is not allowed`);
    if (f.id === undefined) {
      if (!existsSync(join(dir, name))) throw new Error(`File "${name}" is not in this saved prompt: add it again`);
      return { name };
    }
    if (!UPLOAD_ID.test(String(f.id)) || !existsSync(join(uploadsDir, String(f.id), name))) throw new Error(`Uploaded file "${name}" not found: add it again`);
    return { name, src: join(uploadsDir, String(f.id), name) };
  });
  mkdirSync(dir, { recursive: true });
  for (const f of keep) if (f.src) copyFileSync(f.src, join(dir, f.name));
  const names = new Set(keep.map(f => f.name));
  for (const old of Object.keys(filesIn(dir))) if (!names.has(old)) rmSync(join(dir, old));
  if (!names.size) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirOf(project), { recursive: true });
  writeFileSync(fileOf(project, id), JSON.stringify({ ...p, files: [...names].sort(), saved: new Date().toISOString() }, null, 2) + '\n');
  return id;
}

export function deletePrompt(project, id) {
  readPrompt(project, id); // 404 when it is not there
  rmSync(fileOf(project, id));
  rmSync(filesDir(project, id), { recursive: true, force: true });
}

// the prompt's files as fresh uploads, ready for the Run AI form
export function usePromptFiles(project, id, uploadsDir) {
  const p = readPrompt(project, id), dir = filesDir(project, id);
  return p.files.filter(n => existsSync(join(dir, n)))
    .map(name => ({ ...saveUpload(uploadsDir, name, readFileSync(join(dir, name))), size: statSync(join(dir, name)).size }));
}
