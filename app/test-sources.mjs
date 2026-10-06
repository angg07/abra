// A saved test's source: the Run AI form that made it, kept in tests/<project>/sources/<test>.json so the test can be
// opened in Run AI again (Edit in Run AI) and rewritten (Update <test>). Its upload files stay in files/<test>/.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, withPlaceholders } from './library.mjs';
import { cleanInstructions } from './shared.mjs';

const TEST = /^[a-z0-9][a-z0-9-]{0,59}$/;
const fileOf = (project, test) => {
  if (!TEST.test(test ?? '')) throw Object.assign(new Error(`Test "${test}" not found`), { status: 404 });
  return join(projectDir(project), 'sources', `${test}.json`);
};

// only the form's fields, each of its own type: a file may come from an import or a hand edit
const text = v => (typeof v === 'string' ? v : '');
const clean = s => ({
  title: text(s?.title), url: text(s?.url), task: text(s?.task), expected: text(s?.expected), env: text(s?.env), session: text(s?.session),
  provider: text(s?.provider), model: text(s?.model), record: s?.record === true, guide: s?.guide === true, flow: text(s?.flow), ...(cleanInstructions(s?.instructions) && { instructions: cleanInstructions(s.instructions) }), saved: text(s?.saved),
});

export function readSource(project, test) {
  const f = fileOf(project, test);
  if (!existsSync(f)) return null;
  try { return clean(JSON.parse(readFileSync(f, 'utf8'))); } catch { return null; } // a broken file counts as none
}
export function saveSource(project, test, source) {
  const f = fileOf(project, test);
  mkdirSync(join(projectDir(project), 'sources'), { recursive: true });
  writeFileSync(f, JSON.stringify({ ...clean(source), saved: new Date().toISOString() }, null, 2) + '\n');
}
export const deleteSource = (project, test) => rmSync(fileOf(project, test), { force: true });

// a History entry of an AI run; entry.guide is the PDF's file name, so the asked-for options are recordAsked/guideAsked
export const sourceFromRun = run => clean({
  title: run.title, url: run.url, task: run.task, expected: run.expected, env: run.env, session: run.session,
  provider: run.providerId, model: run.model, record: run.recordAsked === true, guide: run.guideAsked === true, flow: run.flow, instructions: run.instructions,
});
// no run to go back to: the first goto() with a plain string, the test's name as title, no instructions
export function sourceFromCode(code, test) {
  const url = withPlaceholders(code).match(/\.goto\(\s*(['"`])((?:(?!\1).)*)\1\s*\)/)?.[2] ?? '';
  return clean({ title: test, url });
}
