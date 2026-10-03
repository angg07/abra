// Files a saved test uploads (templates, PDFs): tests/<project>/files/<test>/<name>. Scripts refer to them as
// {{file.<name>}}; the real path is filled in when the action runs (tests/support/vars.ts, the MCP proxy).
// Run AI uploads wait in app/data/uploads/<id>/<name> until the run copies them (and Save as test keeps them).
import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { projectDir } from './library.mjs';

export const MAX_FILE = 20 * 1024 * 1024;
export const tooLarge = () => Object.assign(new Error('File too large: at most 20 MB'), { status: 413 });
const TEST = /^[a-z0-9][a-z0-9-]{0,59}$/; // a saved test's name (library.mjs)
const UPLOAD_ID = /^[0-9a-f]{16}$/;

// the last path part, only [A-Za-z0-9._-], no leading dot or dash (no hidden files), at most 100 characters
export function cleanFileName(name) {
  let n = String(name ?? '').split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+\./g, '.').replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.').replace(/^[.-]+/, '').replace(/-+$/, '');
  if (!/[A-Za-z0-9]/.test(n)) throw new Error('A file name needs letters or digits');
  // preserve extension when over 100 chars: an extension = final . + 1-10 letters/digits
  if (n.length > 100) {
    const ext = n.match(/\.([A-Za-z0-9]{1,10})$/) ? n.substring(n.lastIndexOf('.')) : '';
    if (ext) n = n.substring(0, 100 - ext.length) + ext; else n = n.slice(0, 100);
  }
  return n;
}

export function testFilesDir(project, test) {
  if (!TEST.test(test ?? '')) throw new Error(`Test "${test}" not found`);
  return join(projectDir(project), 'files', test);
}
const isFile = (dir, f) => statSync(join(dir, f)).isFile();
export const filesIn = dir => (existsSync(dir) ? Object.fromEntries(readdirSync(dir).filter(f => isFile(dir, f)).sort().map(f => [f, join(dir, f)])) : {});
export const listTestFiles = (project, test) => Object.entries(filesIn(testFilesDir(project, test))).map(([name, path]) => ({ name, size: statSync(path).size }));

export function saveTestFile(project, test, name, data) {
  if (data.length > MAX_FILE) throw tooLarge();
  const dir = testFilesDir(project, test), clean = cleanFileName(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, clean), data);
  return clean;
}
export const deleteTestFile = (project, test, name) => rmSync(join(testFilesDir(project, test), cleanFileName(name)), { force: true });

export function saveUpload(uploadsDir, name, data) {
  if (data.length > MAX_FILE) throw tooLarge();
  const id = randomBytes(8).toString('hex'), clean = cleanFileName(name);
  mkdirSync(join(uploadsDir, id), { recursive: true });
  writeFileSync(join(uploadsDir, id, clean), data);
  return { id, name: clean };
}
// the files a Run AI asked for (the files query parameter: JSON [{ id, name }]): each must be an upload that exists
export function pickUploads(uploadsDir, json) {
  if (!json) return [];
  const list = JSON.parse(json);
  if (!Array.isArray(list) || list.length > 20) throw new Error('At most 20 files per run');
  return list.map(({ id, name } = {}) => {
    if (!UPLOAD_ID.test(String(id)) || name !== cleanFileName(name) || !existsSync(join(uploadsDir, id, name))) throw new Error(`Uploaded file "${name}" not found: add it again`);
    return { id, name };
  });
}
export function copyUploads(uploadsDir, files, dest) {
  mkdirSync(dest, { recursive: true });
  const missing = [];
  for (const { id, name } of files) {
    const src = join(uploadsDir, id, name);
    if (existsSync(src)) copyFileSync(src, join(dest, name)); else missing.push(name);
  }
  return missing;
}
export function pruneUploads(uploadsDir, maxAgeMs = 86_400_000) {
  if (!existsSync(uploadsDir)) return;
  for (const d of readdirSync(uploadsDir))
    if (UPLOAD_ID.test(d) && Date.now() - statSync(join(uploadsDir, d)).mtimeMs > maxAgeMs) rmSync(join(uploadsDir, d), { recursive: true, force: true });
}
