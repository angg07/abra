// Run history: every AI run, replay and suite, newest first, in the app database (runs table).
import { db, dataDir } from './store.mjs';
import { isAppError, isA11y } from './shared.mjs';

export { dataDir };
const KEEP_PER_PROJECT = 500; // older runs are dropped; their videos/PDFs are pruned by count anyway

const save = r => db.prepare('INSERT OR REPLACE INTO runs (id, project, started, user_id, video, guide, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(r.id, r.project ?? null, r.started, r.userId ?? null, r.video ?? null, r.guide ?? null, JSON.stringify(r));

export function addRun(entry) {
  save(entry);
  db.prepare(`DELETE FROM runs WHERE project IS ? AND id NOT IN
    (SELECT id FROM runs WHERE project IS ? ORDER BY started DESC LIMIT ${KEEP_PER_PROJECT})`).run(entry.project ?? null, entry.project ?? null);
  return entry;
}

export function patchRun(id, patch) {
  const r = getRun(id);
  if (r) save(Object.assign(r, patch));
}

// the AI runs of a project that wrote a script, newest first (Edit in Run AI looks for the one a test came from)
export const aiScriptRuns = project => db.prepare("SELECT data FROM runs WHERE project = ? AND json_extract(data, '$.kind') = 'ai' AND json_extract(data, '$.script') IS NOT NULL ORDER BY started DESC")
  .all(project).map(({ data }) => JSON.parse(data));
export const getRun = id => { const row = db.prepare('SELECT data FROM runs WHERE id = ?').get(id); return row ? JSON.parse(row.data) : undefined; };

export const INTERRUPTED = 'The app closed during this run (for example, the computer ran out of memory).';
// Runs still marked running when the app starts were cut off (killed, crashed, out of memory): the process that ran
// them is gone. Returns their ids, so their scratch folders can go too.
export function markInterrupted() {
  const rows = db.prepare(`SELECT data FROM runs WHERE json_extract(data, '$.status') = 'running'`).all();
  return rows.map(({ data }) => { const r = JSON.parse(data); save({ ...r, status: 'interrupted', error: INTERRUPTED }); return r.id; });
}

// the run that produced a video or PDF: its project decides who may open the file
export const runOfFile = (column, file) => {
  const row = db.prepare(`SELECT data FROM runs WHERE ${column === 'video' ? 'video' : 'guide'} = ?`).get(file);
  return row ? JSON.parse(row.data) : undefined;
};

// A deleted project takes its runs along; returns them so their files can go too
export function removeRuns(project) {
  const gone = db.prepare('SELECT data FROM runs WHERE project = ?').all(project).map(r => JSON.parse(r.data));
  db.prepare('DELETE FROM runs WHERE project = ?').run(project);
  return gone;
}

// List view: every run (projects undefined), or those of the given project(s); none for an empty list.
// Drops the heavy fields, adds who ran it.
export function listRuns(projects) {
  const list = [].concat(projects ?? []);
  if (projects !== undefined && !list.length) return [];
  const rows = list.length
    ? db.prepare(`SELECT data FROM runs WHERE project IN (${list.map(() => '?').join(',')}) ORDER BY started DESC`).all(...list)
    : db.prepare('SELECT data FROM runs ORDER BY started DESC').all();
  return rows.map(({ data }) => {
    const { steps, replaySteps, log, text, script, issues, original, ...r } = JSON.parse(data);
    return {
      ...r, hasScript: Boolean(script),
      stepCount: (steps?.length ?? 0) + (replaySteps ?? []).filter(s => !s.section).length, // section headings are not steps
      issueCount: (issues ?? []).filter(isAppError).length, // problems from the app under test
      a11yCount: (issues ?? []).filter(isA11y).length,
    };
  }).filter(r => r.status !== 'running'); // a run in progress shows as a chip in the sidebar, not in History
}
