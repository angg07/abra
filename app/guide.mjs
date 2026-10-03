// PDF step-by-step guide built from a run: one screenshot + one plain sentence per user-visible action.
// AI runs: steps come from Playwright MCP tool calls. Replays: from steps-reporter.cjs (Playwright test steps).
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

// videoAt: the recording's position in seconds (undefined while nothing records); steps keep it as `at`
export function guideCollector(currentFrame, videoAt = () => undefined) {
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
      const s = { ...step, frame: step.mode === 'before' ? now : null, at: videoAt() };
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

// A step that puts a value in (typing, picking, ticking, a file): the video holds on it so the value can be read
export const entersValue = what => /^(Fill in|Type into|Choose an option|Upload|Uncheck |Check (?!that ))/.test(what ?? '');

// The run's title, for the PDF cover and the video's title card (an AI run's own title, else its first line)
export const runTitle = (run, suite = 'Test suite') => run.kind === 'ai' ? run.title || (run.task ?? '').split('\n')[0]
  : run.tests?.length > 1 ? `${suite}: ${run.testNames.join(', ')}` : run.tests?.[0]?.title ?? run.task ?? '';

/* ---------- PDF ---------- */
// A guide is an editable document, kept next to its PDF: guides/<name>/doc.json + one JPEG per screenshot.
// The app's guide editor changes the document (step text, notes, warnings, sections, order) and renders it again.
// blocks: { type: 'step', text, detail?, frame? } | { type: 'section', text, level } | { type: 'tip' | 'alert', text }
export const GUIDE_BLOCKS = ['step', 'section', 'tip', 'alert'];
export const FRAME_FILE = /^\d{3}\.(jpg|png)$/; // screenshots from the run are JPEG; one put in by hand may be PNG
export const frameType = f => (f.endsWith('.png') ? 'image/png' : 'image/jpeg');
export const guideFrames = folder => (existsSync(folder) ? readdirSync(folder).filter(f => FRAME_FILE.test(f)) : []);

// A screenshot put in by hand (the editor's Replace image / paste): a PNG or JPEG data: URL, saved under the next
// free number. Returns its file name.
export function addGuideFrame(folder, dataUrl) {
  const m = String(dataUrl ?? '').match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('The image must be a PNG or JPG');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 10_000_000) throw new Error('The image is too large (at most 10 MB)');
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpeg) throw new Error('The image must be a PNG or JPG');
  const next = Math.max(0, ...guideFrames(folder).map(f => Number(f.slice(0, 3)))) + 1;
  if (next > 999) throw new Error('This guide has too many images');
  const name = `${String(next).padStart(3, '0')}.${png ? 'png' : 'jpg'}`;
  writeFileSync(join(folder, name), bytes);
  return name;
}
// after a save: screenshots no block uses any more (replaced or removed) are deleted
export function pruneGuideFrames(folder, doc) {
  const used = new Set(doc.blocks.map(b => b.frame).filter(Boolean));
  for (const f of guideFrames(folder)) if (!used.has(f)) rmSync(join(folder, f), { force: true });
}

// names of buttons, fields and menus (“Save”) come out bold, as a reader scans for them
const boldNames = text => String(text ?? '').replace(/“([^”\n]+)”/g, '**“$1”**');

/* ---------- the project's instructions for videos and PDF guides ---------- */
// The AI rewrites only the words: the title, a short description and each step (same count, same order).
// ask(prompt, system) → the AI's answer as text. Throws when the answer is unusable; the caller keeps the template texts.
const REWRITE_SYSTEM = `You rewrite the texts of a step-by-step user guide (a PDF and the captions of a tutorial video) recorded from a browser run.
Follow the project's instructions for wording, audience and terms. Keep the meaning, the order and the number of steps: one text per step.
Keep the names of buttons, links and fields in “curly quotes”. Each step is one short instruction (at most 10 words), without a full stop.
Answer with JSON only, in a \`\`\`json block: {"title": "...", "description": "one or two sentences", "steps": ["...", "..."]}`;

export async function rewriteGuide({ title, steps, lang, instructions }, ask) {
  const prompt = [
    `Project instructions:\n${instructions}`,
    `Language: ${lang === 'id' ? 'Indonesian' : 'English'}, unless the instructions say otherwise.`,
    `Title: ${title}`,
    `Steps (${steps.length}):\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
  ].join('\n\n');
  const answer = await ask(prompt, REWRITE_SYSTEM);
  let out;
  try { out = JSON.parse(answer.match(/```(?:json)?\s*\n([\s\S]*?)```/)?.[1] ?? answer); } catch { throw new Error('the AI did not answer with JSON'); }
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
  if (!Array.isArray(out?.steps) || out.steps.length !== steps.length) throw new Error(`the AI did not return ${steps.length} steps`);
  const rewritten = out.steps.map((s, i) => text(s, 300) || (() => { throw new Error(`the AI left step ${i + 1} empty`); })());
  return { title: text(out.title, 200) || title, description: text(out.description, 1000), steps: rewritten };
}

// The first draft of the document, from the run's steps. Screenshots come as base64 in `frame`.
// A step's `text` (rewritten from the project's instructions) replaces its template text; texts: { title, description }
export function guideDoc(run, steps, lang = 'en', texts = {}) {
  const L = guideLabels(lang);
  const blocks = steps.map(s => (s.section
    ? { type: 'section', text: s.section, level: s.level === 1 ? 1 : 2 }
    : { type: 'step', text: boldNames(s.text ?? translateStep(s.what, lang)), ...(s.detail && { detail: s.detail }), ...(s.frame && { frame: s.frame }) }));
  const appErrors = (run.issues ?? []).filter(isAppError);
  return {
    version: 1, lang, title: texts.title || runTitle(run, L.suite) || L.testRun, description: texts.description ?? '',
    run: { kind: run.kind, url: run.url, started: run.started, status: run.status, expected: run.expected, expectedMet: run.expectedMet,
      task: run.kind === 'ai' && run.task?.includes('\n') ? run.task : undefined, evidence: run.evidence, errors: appErrors },
    blocks,
  };
}

// Writes the document into its folder: screenshots become 001.jpg, 002.jpg, ... and the blocks point to them
export function saveGuideDoc(doc, folder) {
  mkdirSync(folder, { recursive: true });
  let i = 0;
  const blocks = doc.blocks.map(b => {
    if (b.type !== 'step' || !b.frame || FRAME_FILE.test(b.frame)) return b;
    const name = `${String(++i).padStart(3, '0')}.jpg`;
    writeFileSync(join(folder, name), Buffer.from(b.frame, 'base64'));
    return { ...b, frame: name };
  });
  const out = { ...doc, blocks };
  writeFileSync(join(folder, 'doc.json'), JSON.stringify(out, null, 1));
  return out;
}
export const readGuideDoc = folder => JSON.parse(readFileSync(join(folder, 'doc.json'), 'utf8'));

// An edited document from the editor: only known blocks and fields, text within limits, screenshots only from
// this guide's own folder. Throws on anything else.
// frames: the screenshot files in the guide's folder (saved ones and those just put in)
export function cleanGuideDoc(input, saved, frames = saved.blocks.map(b => b.frame).filter(Boolean)) {
  const str = (v, max, what) => { if (v === undefined || v === null) return ''; if (typeof v !== 'string' || v.length > max) throw new Error(`${what}: text of at most ${max} characters`); return v; };
  if (!input || !Array.isArray(input.blocks) || input.blocks.length > 1000) throw new Error('The guide has no blocks');
  frames = new Set(frames);
  return {
    ...saved,
    title: str(input.title, 200, 'Title').trim() || saved.title,
    description: str(input.description, 5000, 'Description'),
    blocks: input.blocks.map((b, i) => {
      if (!GUIDE_BLOCKS.includes(b?.type)) throw new Error(`Block ${i + 1}: unknown kind`);
      const text = str(b.text, 5000, `Block ${i + 1}`);
      if (b.type === 'section') return { type: 'section', text, level: b.level === 1 ? 1 : 2 };
      if (b.type !== 'step') return { type: b.type, text };
      if (b.frame && !frames.has(b.frame)) throw new Error(`Block ${i + 1}: unknown screenshot`);
      const detail = str(b.detail, 5000, `Block ${i + 1} detail`);
      return { type: 'step', text, ...(detail && { detail }), ...(b.frame && { frame: b.frame }) };
    }),
  };
}

// Old signature: the run's steps → doc (saved next to the PDF) → PDF
export async function buildGuidePdf(run, steps, file, branding = {}, texts = {}) {
  const doc = saveGuideDoc(guideDoc(run, steps, branding.lang ?? 'en', texts), guideFolder(file));
  await renderGuidePdf(doc, guideFolder(file), file, branding);
}
export const guideFolder = pdf => pdf.replace(/\.pdf$/, '');

// Renders the document as the PDF, Scribe-like: a card per step (number, text, screenshot), notes in green,
// warnings in red, section headings between them
export async function renderGuidePdf(doc, folder, file, branding = {}) {
  const lang = doc.lang ?? branding.lang ?? 'en';
  const L = guideLabels(lang);
  const accent = /^#[0-9a-f]{6}$/i.test(branding.accent ?? '') ? branding.accent : '#2B59C3';
  const run = doc.run ?? {};
  const statusColor = { pass: '#1E7F4F', fail: '#C2352B', stopped: '#5E6B78', error: '#C2352B' }[run.status] ?? '#5E6B78';
  const fmtTime = ms => (ms ? new Date(ms).toLocaleString(L.locale, { dateStyle: 'long', timeStyle: 'short' }) : '');
  const frame = f => (f && FRAME_FILE.test(f) && existsSync(join(folder, f)) ? `data:${frameType(f)};base64,${readFileSync(join(folder, f)).toString('base64')}` : '');
  const ICON_TIP = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-5M12 8h.01"/></svg>';
  const ICON_ALERT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
  let n = 0;
  const body = doc.blocks.map(b => {
    if (b.type === 'section') return b.level === 1 ? `<h2 class="section">${esc(b.text)}</h2>` : `<h3 class="sub">${esc(b.text)}</h3>`;
    if (b.type === 'tip') return `<aside class="note tip"><span class="ic">${ICON_TIP}</span><div>${md(b.text)}</div></aside>`;
    if (b.type === 'alert') return `<aside class="note alert"><span class="ic">${ICON_ALERT}</span><div><p class="lbl">${L.alert}</p>${md(b.text)}</div></aside>`;
    n++;
    const img = frame(b.frame);
    return `<article class="step">
      <div class="head"><span class="num">${n}</span><div class="text">${md(b.text)}${b.detail ? `<p class="detail">${esc(b.detail)}</p>` : ''}</div></div>
      ${img ? `<img src="${img}" alt="">` : ''}
    </article>`;
  }).join('');
  const status = L.status[run.status] ?? run.status;
  const meta = [
    [L.website, run.url ?? ''],
    [L.date, fmtTime(run.started)],
    status && [L.result, status],
    [L.steps, String(n)],
    run.expected && [L.expected, `${run.expected} (${run.expectedMet === true ? L.met : run.expectedMet === false ? L.notMet : L.unconfirmed})`],
  ].filter(x => x && x[1]);
  // the AI writes its evidence in English: an Indonesian guide leaves it out rather than mix languages
  const evidence = lang === 'en' && run.evidence ? `<section class="evidence"><h2>${L.resultTitle}</h2>${md(run.evidence)}</section>` : '';
  const errors = run.errors ?? [];
  const footerLeft = [branding.company, (doc.title || '').slice(0, 80)].filter(Boolean).join(' · ');

  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 16mm 14mm 18mm; }
    * { box-sizing: border-box; }
    body { font: 10.5pt/1.5 system-ui, 'Segoe UI', sans-serif; color: #17202A; margin: 0; }
    p { margin: 0 0 6px; } p:last-child { margin-bottom: 0; } ul { margin: 4px 0 6px; padding-left: 18px; } li { margin: 2px 0; }
    a { color: ${accent}; } strong { font-weight: 700; }
    .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 10px; }
    h1 { font-size: 20pt; line-height: 1.25; margin: 0; }
    .brand { flex: none; display: flex; align-items: center; gap: 10px; } .brand img { max-height: 12mm; max-width: 45mm; }
    .brand span { font-weight: 700; color: ${accent}; }
    .desc { color: #4A5866; font-size: 11pt; margin: 0 0 12px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 0 0 22px; font-size: 9.5pt; padding: 8px 12px; border-left: 4px solid ${statusColor}; background: #F7F9FA; }
    dt { color: #5E6B78; } dd { margin: 0; overflow-wrap: anywhere; } dd.result { color: ${statusColor}; font-weight: 600; }
    .task { white-space: pre-wrap; background: #F3F5F7; border-radius: 8px; padding: 10px 12px; margin: -10px 0 22px; font-size: 9.5pt; }
    h2.section { font-size: 15pt; margin: 26px 4px 12px; break-after: avoid; }
    h3.sub { font-size: 12pt; color: ${accent}; margin: 18px 4px 10px; break-after: avoid; }
    .step { break-inside: avoid; background: #F0F3F6; border-radius: 10px; padding: 14px 14px 14px; margin: 0 0 16px; }
    .head { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 10px; }
    .num { flex: none; width: 28px; height: 28px; border-radius: 50%; background: #fff; color: #17202A; font-weight: 700; font-size: 11pt; display: grid; place-items: center; }
    .text { padding-top: 3px; overflow-wrap: anywhere; }
    .detail { margin: 4px 0 0; color: #4A5866; font-size: 9.5pt; white-space: pre-wrap; }
    .step img { width: 100%; max-height: 95mm; object-fit: contain; object-position: left top; border-radius: 4px; display: block; background: #fff; }
    .note { break-inside: avoid; display: flex; gap: 14px; border-radius: 10px; padding: 14px 16px; margin: 0 0 16px; }
    .note .ic { flex: none; margin-top: 1px; } .note > div { flex: 1; overflow-wrap: anywhere; }
    .tip { background: #EDF8F1; color: #1E5A3A; } .tip strong { color: #174A30; }
    .alert { background: #FDEEEE; color: #8A1F1F; } .alert .lbl { font-weight: 700; margin-bottom: 8px; }
    .evidence { margin-top: 24px; break-inside: avoid; } .evidence h2 { font-size: 14pt; margin: 0 0 6px; }
    table.issues { width: 100%; border-collapse: collapse; font-size: 9.5pt; } table.issues td { padding: 4px 6px; border-top: 1px solid #E3E7EC; vertical-align: top; overflow-wrap: anywhere; }
    table.issues td.kind { color: #C2352B; font-weight: 600; white-space: nowrap; } table.issues td.at { color: #5E6B78; white-space: nowrap; }
    code { font-size: 9.5pt; background: rgba(0,0,0,.06); padding: 0 3px; border-radius: 3px; }
  </style></head><body>
  <div class="top"><h1>${esc(doc.title || L.testRun)}</h1>
    ${branding.logo || branding.company ? `<div class="brand">${branding.logo ? `<img src="${branding.logo}" alt="">` : `<span>${esc(branding.company)}</span>`}</div>` : ''}</div>
  ${doc.description ? `<div class="desc">${md(doc.description)}</div>` : ''}
  <dl>${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd${k === L.result ? ' class="result"' : ''}>${esc(v)}</dd>`).join('')}</dl>
  ${run.task ? `<p class="task">${esc(run.task)}</p>` : ''}
  ${body || `<p>${L.noSteps}</p>`}
  ${evidence}
  ${errors.length ? `<section class="evidence"><h2>${L.errorsTitle}</h2><p>${L.errorsIntro}</p>${issuesTable(errors, esc)}</section>` : ''}
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
