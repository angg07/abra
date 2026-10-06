// "Report a problem": a link to a new GitHub issue, filled in with what helps to find the cause. The repository
// is public, so secret values and the home folder are taken out first; the user still reads it before sending.
import { homedir } from 'node:os';

export const ISSUES = 'https://github.com/angg07/abra/issues/new';
const SECRET_KEY = /SECRET|PASS|KEY|TOKEN|WEBHOOK/i;
const MAX_URL = 7500; // GitHub refuses much longer links

// mark: what stands in for a secret ('***' in what leaves the computer, a readable note in the preview)
export function cleaner(env = process.env, home = homedir(), mark = '***') {
  const values = Object.entries(env).filter(([k, v]) => SECRET_KEY.test(k) && v && v.length >= 4).map(([, v]) => v)
    .sort((a, b) => b.length - a.length); // longest first: a secret that contains another is masked whole
  return text => {
    let t = values.reduce((s, v) => s.split(v).join(mark), String(text));
    if (home && home.length > 1) t = t.split(home).join('~');
    return t;
  };
}

export function issueUrl({ version, os, mode, log }, clean = cleaner()) {
  const head = `**What happened?**\n\n\n**What did you expect?**\n\n\n---\nABRA ${version} · ${os} · ${mode}\n`;
  let lines = clean(log).split('\n').filter(Boolean).slice(-40).map(l => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
  const url = () => `${ISSUES}?${new URLSearchParams({ title: '', body: `${head}\n<details><summary>Last lines of the app log</summary>\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n</details>\n` })}`;
  while (lines.length && url().length > MAX_URL) lines = lines.slice(1); // drop the oldest lines until it fits
  return url();
}

// The Report a problem page: the user's title and text, the linked run, the environment, as much of the log as
// fits the link, and the attachments to drag in (they are in a folder; a link cannot carry files)
export function reportUrl({ title, text, run, env, project, version, os, mode, log = '', files = [] }, clean = cleaner()) {
  let what = clean(text);
  const head = () => [
    `## What happened\n\n${what}`,
    `## Run\n\n${run ? `${clean(run.title ?? '')} (${run.id}) · ${run.status ?? ''}${run.when ? ` · ${run.when}` : ''}` : 'No run linked'}`,
    `## Environment\n\nABRA ${version} · ${os} · ${mode}${project ? `\nProject: ${clean(project)}${env ? ` · ${clean(env)}` : ''}` : ''}`,
  ].join('\n\n');
  const tail = `## Attachments\n\n${files.length ? `${files.map(f => `- ${f}`).join('\n')}\n\nThey are in a folder on the reporter's computer: drag them into this issue.` : 'None'}`;
  let lines = clean(log).split('\n').filter(Boolean).slice(-200).map(l => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
  const body = () => `${head()}\n\n${lines.length ? `<details><summary>## App log (last ${lines.length} lines)</summary>\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n</details>\n\n` : '## App log\n\nNot included\n\n'}${tail}\n`;
  const url = () => `${ISSUES}?${new URLSearchParams({ title: clean(title), body: body() })}`;
  while (lines.length && url().length > MAX_URL) lines = lines.slice(Math.max(1, Math.ceil(lines.length / 10))); // drop the oldest lines until it fits
  // still too long: the description itself is cut (report.txt in the folder keeps all of it)
  const full = what, note = '\n\n…(truncated, the full text is in report.txt)';
  for (let keep = full.length; url().length > MAX_URL && keep > 0; keep = Math.floor(keep * 0.8)) what = full.slice(0, keep) + note;
  return url();
}
