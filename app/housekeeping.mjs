// Disk housekeeping: keep only the newest output files of a kind
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Same for sub-folders (one per run, e.g. visual diffs)
export function pruneFolders(folder, keep) {
  if (!existsSync(folder)) return [];
  const dirs = readdirSync(folder, { withFileTypes: true }).filter(d => d.isDirectory())
    .map(d => ({ f: d.name, t: statSync(join(folder, d.name)).mtimeMs })).sort((a, b) => b.t - a.t);
  const old = dirs.slice(keep).map(x => x.f);
  for (const f of old) rmSync(join(folder, f), { recursive: true, force: true });
  return old;
}

// Deletes all but the `keep` newest files ending in `ext`; returns the deleted file names
export function pruneDir(folder, keep, ext) {
  if (!existsSync(folder)) return [];
  const files = readdirSync(folder)
    .filter(f => f.endsWith(ext))
    .map(f => ({ f, t: statSync(join(folder, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const old = files.slice(keep).map(x => x.f);
  for (const f of old) rmSync(join(folder, f), { force: true });
  return old;
}
