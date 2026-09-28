// Scheduled suites: run saved tests at a set time on chosen days, then notify.
// The app must be running at that time (it is a local tool, not a cloud service).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const dayIndex = d => (d.getDay() + 6) % 7; // Monday = 0
const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Which enabled schedules should start now: their time has come today, on one of their days, and they have
// not run yet today. A schedule missed by up to `graceMin` minutes (app restarted, laptop asleep) still runs.
export function dueSchedules(schedules, now, lastRuns, graceMin = 30) {
  const today = localDate(now);
  const minutes = now.getHours() * 60 + now.getMinutes();
  return schedules.filter(s => {
    if (!s.enabled || !s.tests?.length) return false;
    if (!(s.days ?? []).includes(DAYS[dayIndex(now)])) return false;
    const [h, m] = String(s.time).split(':').map(Number);
    const at = h * 60 + m;
    return minutes >= at && minutes - at <= graceMin && lastRuns[s.id] !== today;
  });
}

export function validSchedules(list = [], testExists) {
  const ids = new Set();
  return list.map(s => {
    const id = String(s.id || s.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!id || ids.has(id)) throw new Error(`Schedule name empty or duplicated: "${s.name}"`);
    ids.add(id);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time ?? '')) throw new Error(`Time of "${s.name}" must be HH:MM (24h)`);
    const days = (s.days ?? []).filter(d => DAYS.includes(d));
    if (!days.length) throw new Error(`Pick at least one day for "${s.name}"`);
    const project = String(s.project ?? '');
    if (!project) throw new Error(`Pick a project for "${s.name}"`);
    const tests = (s.tests ?? []).filter(Boolean);
    if (!tests.length) throw new Error(`Pick at least one test for "${s.name}"`);
    for (const t of tests) if (!testExists(project, t)) throw new Error(`Test "${t}" in "${s.name}" does not exist in project "${project}"`);
    const repeat = Number(s.repeat ?? 1);
    if (![1, 3, 5].includes(repeat)) throw new Error(`Repeat of "${s.name}" must be 1, 3 or 5`);
    return {
      id, name: String(s.name || id), time: s.time, days, project, tests,
      env: String(s.env ?? ''), session: String(s.session ?? ''), repeat,
      record: Boolean(s.record), guide: Boolean(s.guide), enabled: s.enabled !== false,
    };
  });
}

// Last run date per schedule, on disk so a restart does not run the same schedule twice in a day
export function scheduleState(file) {
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  return {
    load,
    markRun(id, now = new Date()) {
      const s = load(); s[id] = localDate(now);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(s));
    },
  };
}
