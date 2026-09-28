// One self-contained HTML file per run (AI run, replay or suite): shareable by email/chat, video embedded.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { esc, md, describe, issuesTable, isAppError, isThirdParty, isA11y } from './shared.mjs';

const MAX_EMBED = 40 * 1024 * 1024; // larger videos are left out to keep the report openable

const STATUS = { pass: ['Passed', '#1E7F4F'], fail: ['Failed', '#C2352B'], stopped: ['Stopped', '#5E6B78'], error: ['Error', '#C2352B'] };
const fmtTime = ms => new Date(ms).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
const secs = ms => `${Math.round(ms / 100) / 10} s`;

function issuesSection(issues = []) {
  const own = issues.filter(isAppError), other = issues.filter(isThirdParty), a11y = issues.filter(isA11y);
  if (!issues.length) return '';
  const a11ySection = a11y.length ? `<h2>Accessibility (${a11y.length})</h2><section><p class="muted">Serious and critical WCAG 2 A/AA problems found by axe-core, once per page.</p>${issuesTable(a11y, esc)}</section>` : '';
  if (!own.length && !other.length) return a11ySection;
  return `<h2>Errors during the run (${own.length})</h2>
    ${own.length ? `<section>${issuesTable(own, esc)}</section>` : '<section><p class="muted">No errors from the application itself.</p></section>'}
    ${other.length ? `<details><summary class="muted">${other.length} from third-party sites (analytics, fonts, ...)</summary><section>${issuesTable(other, esc)}</section></details>` : ''}
    ${a11ySection}`;
}

export function buildReport(run, recordingsDir) {
  const [label, color] = STATUS[run.status] ?? STATUS.error;
  const title = run.kind === 'ai' ? 'AI run' : run.tests?.length > 1 ? 'Test suite' : 'Test replay';

  let video = '';
  const file = run.video && join(recordingsDir, run.video);
  if (file && existsSync(file)) {
    video = statSync(file).size <= MAX_EMBED
      ? `<h2>Recording</h2><video controls src="data:video/mp4;base64,${readFileSync(file).toString('base64')}"></video>`
      : `<h2>Recording</h2><p class="muted">Video too large to include (${run.video}).</p>`;
  }

  const meta = [
    ['Time', fmtTime(run.started)],
    ['Duration', `${run.secs ?? 0} seconds`],
    run.url && ['Website', run.url],
    run.provider && ['AI', `${run.provider}${run.model ? ` (${run.model})` : ''}`],
    run.session && ['Login session', run.session],
    run.expected && ['Expected result', `${run.expected} (${run.expectedMet === true ? 'met' : run.expectedMet === false ? 'NOT met' : 'not confirmed'})`],
    run.device && ['Device', `${run.device} (emulated in Chromium)`],
    run.env && ['Environment', run.env],
  ].filter(Boolean);

  const tests = run.tests?.length ? `<h2>Results per test</h2><table><thead><tr><th>Test</th><th>File</th><th>Status</th><th>Time</th></tr></thead><tbody>${
    run.tests.map(t => `<tr><td>${esc(t.title)}${t.error ? `<pre>${esc(t.error)}</pre>` : ''}</td><td>${esc(t.file)}</td><td class="st ${t.status === 'passed' ? 'ok' : 'bad'}">${t.status === 'passed' ? 'Passed' : t.status === 'skipped' ? 'Skipped' : 'Failed'}</td><td>${secs(t.ms)}</td></tr>`).join('')
  }</tbody></table>` : '';

  const steps = run.steps?.length ? `<h2>AI steps (${run.steps.length})</h2><ol class="steps">${
    run.steps.map(s => { const d = describe(s); return `<li><b>${esc(d.what)}</b> <span class="muted">${esc(d.detail)}</span></li>`; }).join('')
  }</ol>` : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}: ${esc(label)}</title>
<style>
  body { margin:0; background:#EDF0F3; color:#17202A; font:15px/1.55 system-ui, sans-serif; }
  main { max-width:860px; margin:0 auto; padding:32px 16px 64px; }
  header { border-left:5px solid ${color}; background:#fff; border-radius:12px; padding:20px 24px; }
  h1 { margin:0 0 4px; font-size:24px; color:${color}; } h2 { font-size:17px; margin:32px 0 10px; }
  .task { margin:8px 0 0; white-space:pre-wrap; }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; margin:16px 0 0; font-size:14px; } dt { color:#5E6B78; } dd { margin:0; overflow-wrap:anywhere; }
  section, table { background:#fff; border-radius:12px; } section { padding:16px 20px; }
  table { width:100%; border-collapse:collapse; overflow:hidden; font-size:14px; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid #E3E7EC; vertical-align:top; } th { color:#5E6B78; font-weight:600; }
  .st.ok { color:#1E7F4F; font-weight:600; } .st.bad { color:#C2352B; font-weight:600; }
  pre { white-space:pre-wrap; overflow-wrap:anywhere; font:12.5px/1.5 ui-monospace, monospace; background:#F5F7F9; border-radius:8px; padding:10px; margin:8px 0 0; }
  code { font:12.5px ui-monospace, monospace; background:#F5F7F9; padding:1px 4px; border-radius:4px; }
  .steps { background:#fff; border-radius:12px; padding:16px 20px 16px 44px; margin:0; } .steps li { margin:2px 0; }
  .muted { color:#5E6B78; } video { width:100%; border-radius:12px; background:#000; }
  footer { margin-top:40px; color:#5E6B78; font-size:13px; }
  table.issues td.kind { white-space:nowrap; color:#C2352B; font-weight:600; } table.issues td.at { color:#5E6B78; white-space:nowrap; }
  table.issues td { overflow-wrap:anywhere; } details summary { cursor:pointer; margin:10px 0; }
</style></head><body><main>
<header>
  <h1>${esc(title)}: ${esc(label)}</h1>
  ${run.task ? `<p class="task">${esc(run.task)}</p>` : ''}
  <dl>${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
</header>
${run.error ? `<h2>Error</h2><section><pre>${esc(run.error)}</pre></section>` : ''}
${run.evidence ? `<h2>Evidence from the AI</h2><section>${md(run.evidence)}</section>` : ''}
${issuesSection(run.issues)}
${run.flaky?.length ? `<h2>Flaky tests</h2><section><p class="muted">These passed on some repeats and failed on others: usually a timing problem, not a real break.</p><ul>${run.flaky.map(f => `<li>${esc(f.title)}${f.row ? ` (row ${f.row})` : ''}: passed ${f.passed} of ${f.total}</li>`).join('')}</ul></section>` : ''}
${tests}
${video}
${steps}
${run.script ? `<h2>Test script</h2><section><pre>${esc(run.script)}</pre></section>` : ''}
<footer>Generated by AI Browser Runner on ${esc(fmtTime(Date.now()))}</footer>
</main></body></html>`;
}
