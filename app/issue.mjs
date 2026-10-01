// "Report a problem": a link to a new GitHub issue, filled in with what helps to find the cause. The repository
// is public, so secret values and the home folder are taken out first; the user still reads it before sending.
import { homedir } from 'node:os';

export const ISSUES = 'https://github.com/angg07/abra/issues/new';
const SECRET_KEY = /SECRET|PASS|KEY|TOKEN|WEBHOOK/i;
const MAX_URL = 7500; // GitHub refuses much longer links

export function cleaner(env = process.env, home = homedir()) {
  const values = Object.entries(env).filter(([k, v]) => SECRET_KEY.test(k) && v && v.length >= 4).map(([, v]) => v)
    .sort((a, b) => b.length - a.length); // longest first: a secret that contains another is masked whole
  return text => {
    let t = values.reduce((s, v) => s.split(v).join('***'), String(text));
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
