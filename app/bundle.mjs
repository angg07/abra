// A project as one JSON file (<id>.abr.json) to hand to someone else, and the checks an imported file must
// pass. An imported file comes from another person: nothing in it is trusted until unpackBundle accepts it.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const BUNDLE_FORMAT = 'ai-browser-runner-project';
export const BUNDLE_VERSION = 1;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/; // same rule as app/library.mjs
const RESERVED = new Set(['support', 'data']); // tests/support holds every project's helpers: never a project
const SEG = '[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}';
// the only files a project folder holds; anything else (scripts, other folders) is refused
const ALLOWED = [
  { re: new RegExp(`^${SEG}\\.spec\\.ts$`), kind: 'text' },
  { re: new RegExp(`^data/${SEG}\\.csv$`), kind: 'text' },
  { re: new RegExp(`^workflows/${SEG}\\.json$`), kind: 'text' },
  { re: new RegExp(`^${SEG}\\.spec\\.ts-snapshots/${SEG}\\.png$`), kind: 'base64' },
];
const kindOf = path => (path.includes('..') ? undefined : ALLOWED.find(a => a.re.test(path))?.kind);

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));

export function packProject(dir, project, secretNames) {
  const files = {};
  for (const abs of walk(dir)) {
    const path = relative(dir, abs).split(sep).join('/');
    const kind = kindOf(path);
    if (!kind) continue; // project.json and anything the app does not share
    const data = readFileSync(abs);
    files[path] = kind === 'base64' ? { base64: data.toString('base64') } : { text: data.toString('utf8') };
  }
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exported: new Date().toISOString(), project, secrets: [...secretNames], files };
}

export function unpackBundle(b) {
  if (!b || typeof b !== 'object' || b.format !== BUNDLE_FORMAT) throw new Error('This is not an AI Browser Runner project file');
  if (b.version !== BUNDLE_VERSION) throw new Error(`This project file is version ${b.version}; this app reads version ${BUNDLE_VERSION}. Update the app.`);
  const project = b.project;
  if (!project || typeof project !== 'object' || !PROJECT_ID.test(String(project.id ?? ''))) throw new Error('The file has no valid project id');
  if (RESERVED.has(project.id)) throw new Error(`"${project.id}" is a reserved folder name, not a project id`);
  // same rules as the project form (library.mjs saveProject), so the Projects page can always list it
  if (typeof project.name !== 'string' || !project.name.trim() || project.name.trim().length > 60) throw new Error('The project name must be 1 to 60 characters');
  if (project.description !== undefined && (typeof project.description !== 'string' || project.description.length > 300)) throw new Error('The project description must be text of at most 300 characters');
  if (project.url && (typeof project.url !== 'string' || !/^(https?:\/\/|\{\{)\S+$/.test(project.url))) throw new Error('The project start URL must start with http(s):// or {{');
  const secrets = Array.isArray(b.secrets) ? b.secrets.filter(n => /^[A-Z][A-Z0-9_]{0,59}$/.test(n)) : [];
  if (!b.files || typeof b.files !== 'object') throw new Error('The file lists no files');
  const files = Object.entries(b.files).map(([path, entry]) => {
    const kind = kindOf(path);
    if (!kind) throw new Error(`File "${path}" is not allowed in a project`);
    const has = ['text', 'base64'].filter(k => typeof entry?.[k] === 'string');
    if (has.length !== 1) throw new Error(`File "${path}" must have exactly one of text or base64`);
    if (has[0] !== kind) throw new Error(`File "${path}" must be stored as ${kind}`);
    return { path, data: kind === 'base64' ? Buffer.from(entry.base64, 'base64') : Buffer.from(entry.text, 'utf8') };
  });
  return { project, secrets, files };
}

// {{name}} values the imported files use that no environment on this laptop defines. Built-ins (vars-core)
// and workflow/data references are filled in by the app itself; UPPERCASE names are secrets.
const BUILT_IN = /^(today(\s*[+-]\s*\d+)?|now|random|runId|data\..+|params\..+|blocks\..+|item(\..+)?)$/;
export function missingVars(files, envs) {
  const defined = new Set(envs.flatMap(e => Object.keys(e.vars ?? {})));
  const used = new Set();
  for (const f of files) {
    if (f.path.endsWith('.png')) continue;
    for (const [, raw] of f.data.toString('utf8').matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
      const name = raw.split('|')[0].trim(); // {{value|DD/MM/YYYY}}: the format is not part of the name
      if (BUILT_IN.test(name) || /^[A-Z][A-Z0-9_]*$/.test(name)) continue;
      if (!defined.has(name)) used.add(name);
    }
  }
  return [...used].sort();
}
