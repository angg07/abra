// PDF step-by-step guide built from a run: one screenshot + one plain sentence per user-visible action.
// AI runs: steps come from Playwright MCP tool calls. Replays: from steps-reporter.cjs (Playwright test steps).
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';
import { esc, md, issuesTable, isAppError } from './shared.mjs';
import { translateStep, guideLabels } from './guide-i18n.mjs';

// Mask anything that looks like a stored secret: SECRET_* values and *PASS*/*TOKEN*/*KEY* env values
// Masks the secrets a run can type (its project's). Only those: masking another value that also happens to be an
// ordinary word on the page ("password") would tell the reader that some secret equals that word.
export function secretMasker(names = [], env = process.env) {
  const values = names.map(n => [env[`SECRET_${n}`], `{{${n}}}`]).filter(([v]) => v && v.length >= 4);
  return text => values.reduce((t, [v, r]) => t.split(v).join(r), String(text));
}

/* ---------- step text ---------- */
// "before": the screen where you act (click here); "after": the result of the action (what was typed, the loaded page)
const AI_STEPS = {
  browser_navigate: ['after', i => ['Open the page', i.url]],
  browser_navigate_back: ['after', () => ['Go back to the previous page', '']],
  browser_click: ['before', i => [`Click ${quote(i.element)}`, ''], 'Click'],
  browser_hover: ['before', i => [`Hover over ${quote(i.element)}`, ''], 'Hover over'],
  browser_type: ['after', i => [`Type into ${quote(i.element)}`, i.text]],
  browser_fill_form: ['after', i => ['Fill in the form', (i.fields ?? []).map(f => `${f.name}: ${f.value}`).join('\n')]],
  browser_select_option: ['after', i => [`Choose an option in ${quote(i.element)}`, [].concat(i.values ?? []).join(', ')]],
  browser_press_key: ['before', i => [`Press ${i.key}`, '']],
  browser_file_upload: ['after', i => ['Upload the file', (i.paths ?? []).join(', ')]],
  browser_handle_dialog: ['before', i => [i.accept ? 'Confirm the dialog' : 'Dismiss the dialog', '']],
  browser_drag: ['before', i => [`Drag ${quote(i.startElement)} to ${quote(i.endElement)}`, '']],
  browser_wait_for: ['after', i => [i.text ? `Wait until “${i.text}” appears` : i.textGone ? `Wait until “${i.textGone}” disappears` : 'Wait a moment', '']],
};
const quote = s => (s ? `“${s}”` : 'the element');

export function aiStep({ name, input = {} }) {
  const def = AI_STEPS[name];
  if (!def) return null; // snapshots, console checks, scripts: not something a person does
  const [what, detail] = def[1](input);
  const wantsBox = ['browser_click', 'browser_hover', 'browser_drag'].includes(name);
  return { mode: def[0], what, detail, wantsBox, verb: def[2], generic: wantsBox && !input.element };
}

// Replays: turn "Click" + the source line into "Click the “Login” button"
const lines = new Map();
const sourceLine = (file, line) => {
  try {
    if (!lines.has(file)) lines.set(file, readFileSync(file, 'utf8').split('\n'));
    return lines.get(file)[line - 1] ?? '';
  } catch { return ''; }
};
// a regex name like /^List Orders/ or /Jane Doe .*Employee/ read as plain text: "List Orders", "Jane Doe … Employee"
const regexText = r => r.replace(/^\^|\$$/g, '').replace(/\.[*+]\??/g, '…').replace(/\\(.)/g, '$1').replace(/\s*…\s*/g, ' … ').trim();
function target(code) {
  const byRole = [...code.matchAll(/getByRole\(\s*(['"`])(.*?)\1(?:\s*,\s*\{[^}]*name:\s*(?:(['"`])(.*?)\3|\/((?:\\\/|[^/])+)\/[a-z]*))?/g)].at(-1);
  if (byRole && byRole[5] !== undefined) byRole[4] = regexText(byRole[5]);
  const by = [...code.matchAll(/getBy(Placeholder|Label|Text|TestId|AltText|Title)\(\s*(['"`])(.*?)\2/g)].at(-1);
  const loc = [...code.matchAll(/locator\(\s*(['"`])(.*?)\1/g)].at(-1);
  // the last locator call on the line is the one acted on
  const pos = m => m?.index ?? -1;
  const last = [byRole, by, loc].sort((a, b) => pos(b) - pos(a))[0];
  if (!last) return 'the element';
  if (last === byRole) return byRole[4] ? `the “${byRole[4]}” ${byRole[2]}` : `the ${byRole[2]}`;
  if (last === by) return { Placeholder: `the “${by[3]}” field`, Label: `the “${by[3]}” field`, Text: `“${by[3]}”`, TestId: `the “${by[3]}” element`, AltText: `the “${by[3]}” image`, Title: `“${by[3]}”` }[by[1]];
  return `the element ${loc[2]}`;
}
const MATCHERS = {
  toBeVisible: 'is visible', toBeHidden: 'is hidden', toHaveText: 'has the expected text', toContainText: 'contains the expected text',
  toHaveURL: 'the page address is correct', toHaveTitle: 'the page title is correct', toHaveValue: 'has the expected value',
  toBeEnabled: 'is enabled', toBeDisabled: 'is disabled', toBeChecked: 'is checked', toHaveCount: 'has the expected count',
};

export function replayStep({ title, category, file, line }, mask) {
  if (category === 'test') return { section: title, level: 1 };
  if (category === 'test.step') return { section: title, level: 2 };
  const code = sourceLine(file, line);
  const t = target(code);
  if (category === 'expect') {
    const matcher = title.match(/"(\w+)"/)?.[1] ?? '';
    if (matcher === 'toHaveURL' || matcher === 'toHaveTitle') return { mode: 'before', what: `Check that ${MATCHERS[matcher]}`, detail: '' };
    return { mode: 'before', what: `Check that ${t} ${MATCHERS[matcher] ?? `passes ${matcher}`}`, detail: '' };
  }
  const value = title.match(/"(.*)"/)?.[1];
  const verb = title.replace(/\s*".*$/, '');
  const generic = t.startsWith('the element');
  if (verb === 'Navigate') return { mode: 'after', what: 'Open the page', detail: code.match(/goto\(\s*(['"`])(.*?)\1/)?.[2] ?? '' };
  if (verb === 'Fill' || verb === 'Type' || verb === 'Press sequentially') return { mode: 'after', what: `Fill in ${generic ? 'the highlighted field' : t}`, detail: mask(value ?? '') };
  if (verb.startsWith('Select')) return { mode: 'after', what: `Choose an option in ${t}`, detail: mask(value ?? '') };
  if (verb === 'Set input files') return { mode: 'after', what: `Upload a file to ${t}`, detail: '' };
  if (/^(Wait|Screenshot|Evaluate|Query|Get|Is|Count|Text content|Inner|Bounding)/i.test(verb)) return null;
  return { mode: 'before', what: `${verb} ${t}`, detail: value ? mask(value) : '', verb, generic, wantsBox: /^(Click|Double click|Hover|Check|Uncheck|Tap|Drag)/.test(verb) };
}

/* ---------- collecting screenshots during a run ---------- */
// A step's "after" frame is whatever is on screen when the next step starts (or when the run ends)
// Click-like steps use the frame where the in-page highlight box is drawn (see stage.mjs highlighter).
// Box signals and click steps arrive in the same order but with different delays (replay steps pass
// through the runner's stdout), so they are paired in order; anything unpaired for 2 s is dropped.
const PAIR_MS = 2000;
// Steps with no usable name (CSS selectors, bare icons) take the name and kind the page reported for the box
const KINDS = new Set(['button', 'link', 'icon', 'menu item', 'tab', 'option', 'checkbox', 'dropdown', 'field']);
function nameFromBox(verb, box) {
  if (!box?.name) return `${verb} the highlighted ${KINDS.has(box?.kind) ? box.kind : 'element'}`;
  return KINDS.has(box.kind) ? `${verb} the “${box.name}” ${box.kind}` : `${verb} “${box.name}”`;
}

export function guideCollector(currentFrame) {
  const steps = [];
  let waiting = null, boxes = [], needBox = [];
  const prune = now => { boxes = boxes.filter(b => now - b.at < PAIR_MS); needBox = needBox.filter(n => now - n.at < PAIR_MS); };
  const attach = (step, box) => { step.frame = box.frame; step.box = box.info; };
  return {
    add(step) {
      const now = currentFrame();
      if (waiting) { waiting.frame = now ?? waiting.frame; waiting = null; }
      if (!step) return;
      if (step.section) { steps.push(step); return; }
      const s = { ...step, frame: step.mode === 'before' ? now : null };
      steps.push(s);
      if (s.wantsBox) {
        prune(Date.now());
        const b = boxes.shift();
        if (b) attach(s, b); else needBox.push({ step: s, at: Date.now() });
      }
      if (step.mode === 'after') waiting = s;
    },
    highlight(frame, info) {
      if (!frame) return;
      prune(Date.now());
      const box = { frame, info, at: Date.now() };
      const n = needBox.shift();
      if (n) attach(n.step, box); else boxes.push(box);
    },
    finish() {
      if (waiting) waiting.frame = currentFrame() ?? waiting.frame;
      for (const s of steps) if (s.generic && s.verb) s.what = nameFromBox(s.verb, s.box);
      // one test: its heading just repeats the title
      const out = steps.filter(s => s.level !== 1).length && steps.filter(s => s.level === 1).length === 1 ? steps.filter(s => s.level !== 1) : steps;
      // drop headings with no steps under them
      const hasSteps = i => { for (const x of out.slice(i + 1)) { if (!x.section) return true; if (x.level <= out[i].level) return false; } return false; };
      return out.filter((s, i) => !s.section || hasSteps(i));
    },
  };
}

/* ---------- PDF ---------- */
// branding: { lang: 'en' | 'id', company, accent (#RRGGBB), logo (data: URL) } from Settings > PDF guide
export async function buildGuidePdf(run, steps, file, branding = {}) {
  const lang = branding.lang ?? 'en';
  const L = guideLabels(lang);
  const accent = /^#[0-9a-f]{6}$/i.test(branding.accent ?? '') ? branding.accent : '#2B59C3';
  const statusColor = { pass: '#1E7F4F', fail: '#C2352B', stopped: '#5E6B78', error: '#C2352B' }[run.status] ?? '#5E6B78';
  const status = [L.status[run.status] ?? run.status ?? '-', statusColor];
  const fmtTime = ms => new Date(ms).toLocaleString(L.locale, { dateStyle: 'long', timeStyle: 'short' });
  const title = run.kind === 'ai' ? (run.task ?? '').split('\n')[0]
    : run.tests?.length > 1 ? `${L.suite}: ${run.testNames.join(', ')}` : run.tests?.[0]?.title ?? run.task;
  let n = 0;
  const body = steps.map(s => {
    if (s.section) return s.level === 1 ? `<h2 class="section">${esc(s.section)}</h2>` : `<h3 class="sub">${esc(s.section)}</h3>`;
    n++;
    return `<article class="step">
      <div class="head"><span class="num">${n}</span><div><h3>${esc(translateStep(s.what, lang))}</h3>${s.detail ? `<p class="detail">${esc(s.detail)}</p>` : ''}</div></div>
      ${s.frame ? `<img src="data:image/jpeg;base64,${s.frame}" alt="">` : ''}
    </article>`;
  }).join('');
  const meta = [
    [L.website, run.url ?? ''],
    [L.date, fmtTime(run.started)],
    [L.result, status[0]],
    [L.steps, String(n)],
    run.expected && [L.expected, `${run.expected} (${run.expectedMet === true ? L.met : run.expectedMet === false ? L.notMet : L.unconfirmed})`],
  ].filter(x => x && x[1]);
  const appErrors = (run.issues ?? []).filter(isAppError);
  // the AI writes its evidence in English: an Indonesian guide leaves it out rather than mix languages
  const evidence = lang === 'en' && run.evidence ? `<section class="evidence"><h2>${L.resultTitle}</h2>${md(run.evidence)}</section>` : '';
  const footerLeft = [branding.company, (title || '').slice(0, 80)].filter(Boolean).join(' · ');

  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 16mm 14mm 18mm; }
    * { box-sizing: border-box; }
    body { font: 11pt/1.5 system-ui, 'Segoe UI', sans-serif; color: #17202A; margin: 0; }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    .brand img { max-height: 14mm; max-width: 50mm; border: 0; border-radius: 0; }
    .brand span { font-weight: 700; font-size: 12pt; color: ${accent}; }
    .cover { border-left: 5px solid ${status[1]}; padding: 4px 0 4px 16px; margin-bottom: 18px; }
    .kicker { color: #5E6B78; font-size: 10pt; margin: 0 0 4px; }
    h1 { font-size: 20pt; line-height: 1.25; margin: 0 0 12px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 0; font-size: 10pt; }
    dt { color: #5E6B78; } dd { margin: 0; overflow-wrap: anywhere; } dd.result { color: ${status[1]}; font-weight: 600; }
    .task { white-space: pre-wrap; background: #F3F5F7; border-radius: 8px; padding: 10px 12px; margin: 14px 0 0; font-size: 10pt; }
    h2.section { font-size: 14pt; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #D5DBE1; break-after: avoid; }
    h3.sub { font-size: 11pt; color: ${accent}; margin: 14px 0 8px; break-after: avoid; }
    .step { break-inside: avoid; margin: 0 0 18px; }
    .head { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 8px; }
    .num { flex: none; width: 24px; height: 24px; border-radius: 50%; background: ${accent}; color: #fff; font-weight: 700; font-size: 10pt; display: grid; place-items: center; }
    h3 { font-size: 12pt; margin: 1px 0 0; }
    .detail { margin: 2px 0 0; color: #3D4853; font-size: 10pt; white-space: pre-wrap; overflow-wrap: anywhere; }
    img { max-width: 100%; max-height: 75mm; border: 1px solid #D5DBE1; border-radius: 6px; display: block; } /* ~3 steps per page */
    .evidence { margin-top: 24px; break-inside: avoid; } .evidence h2 { font-size: 14pt; margin: 0 0 6px; }
    table.issues { width: 100%; border-collapse: collapse; font-size: 9.5pt; } table.issues td { padding: 4px 6px; border-top: 1px solid #E3E7EC; vertical-align: top; overflow-wrap: anywhere; }
    table.issues td.kind { color: #C2352B; font-weight: 600; white-space: nowrap; } table.issues td.at { color: #5E6B78; white-space: nowrap; }
    .evidence p { margin: 0 0 6px; } code { font-size: 9.5pt; background: #F3F5F7; padding: 0 3px; border-radius: 3px; }
  </style></head><body>
  ${branding.logo || branding.company ? `<div class="brand">${branding.logo ? `<img src="${branding.logo}" alt="">` : ''}${branding.company ? `<span>${esc(branding.company)}</span>` : ''}</div>` : ''}
  <section class="cover">
    <p class="kicker">${L.kicker}</p>
    <h1>${esc(title || L.testRun)}</h1>
    <dl>${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd${k === L.result ? ' class="result"' : ''}>${esc(v)}</dd>`).join('')}</dl>
    ${run.kind === 'ai' && run.task && run.task.includes('\n') ? `<p class="task">${esc(run.task)}</p>` : ''}
  </section>
  ${body || `<p>${L.noSteps}</p>`}
  ${evidence}
  ${appErrors.length ? `<section class="evidence"><h2>${L.errorsTitle}</h2><p>${L.errorsIntro}</p>${issuesTable(appErrors, esc)}</section>` : ''}
  </body></html>`;

  mkdirSync(dirname(file), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: file, format: 'A4', printBackground: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: `<div style="font:8pt system-ui;color:#5E6B78;width:100%;padding:0 14mm;display:flex;justify-content:space-between"><span>${esc(footerLeft)}</span><span>${L.page} <span class="pageNumber"></span> ${L.of} <span class="totalPages"></span></span></div>`,
      margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' },
    });
  } finally { await browser.close(); }
}
