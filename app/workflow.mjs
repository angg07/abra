// Workflows: a chain of blocks run in one browser, so a login or an open page carries over from block to block.
// Stored per project as tests/<project>/workflows/<id>.json. This module is the pure part: validation, the
// {{params.x}} / {{blocks.key.field}} / {{item.x}} references, the AI prompts and reading the AI's answers.
//
//   ai        the AI does a task in the browser (optionally opening a URL first)
//   extract   the AI reads the page and returns data shaped by a schema ({ orderNo: 'string', ... })
//   validate  the AI checks a condition on the page without changing anything: pass or fail
//   test      a saved Playwright test, no AI, starting with the browser's login
//   loop      the blocks inside run once per CSV row, or per item of an earlier block's list
//   http      an HTTP request; its JSON answer can feed later blocks

export const BLOCK_TYPES = ['ai', 'extract', 'validate', 'test', 'loop', 'http'];
export const FIELD_TYPES = ['string', 'number', 'boolean', 'list'];
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const MAX_BLOCKS = 50, MAX_ITEMS = 50;

const text = (v, max, what) => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw new Error(`${what}: at most ${max} characters`);
  return s;
};
export const keyOf = label => String(label).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'b_$1').slice(0, 40) || 'block';

// Normalizes a workflow from the editor; throws a message the user can act on.
export function validWorkflow(wf, { testExists = () => true } = {}) {
  const name = text(wf?.name, 80, 'Workflow name');
  if (!name) throw new Error('Give the workflow a name');
  const params = (wf.params ?? []).map(p => {
    const n = String(p?.name ?? '').trim();
    if (!FIELD.test(n)) throw new Error(`Parameter "${n}": letters, digits and _ only, starting with a letter`);
    return { name: n, default: text(p.default, 500, `Parameter ${n}`) };
  });
  if (new Set(params.map(p => p.name)).size !== params.length) throw new Error('Two parameters have the same name');
  const keys = new Set();
  let count = 0;
  const block = (b, depth) => {
    if (++count > MAX_BLOCKS) throw new Error(`A workflow has at most ${MAX_BLOCKS} blocks`);
    if (!BLOCK_TYPES.includes(b?.type)) throw new Error(`Unknown block type "${b?.type}"`);
    const label = text(b.label, 80, 'Block name') || b.type;
    const key = String(b.key ?? keyOf(label));
    if (!KEY.test(key)) throw new Error(`Block key "${key}": lowercase letters, digits and _, starting with a letter`);
    if (keys.has(key)) throw new Error(`Two blocks use the key "${key}": rename one`);
    keys.add(key);
    const where = `Block "${label}"`;
    const out = { type: b.type, key, label, ...(b.continueOnFailure && { continueOnFailure: true }) };
    if (b.type === 'ai') {
      Object.assign(out, { url: text(b.url, 500, `${where}: URL`), prompt: text(b.prompt, 4000, `${where}: instructions`) });
      if (!out.prompt) throw new Error(`${where}: what should the AI do?`);
    }
    if (b.type === 'extract') {
      out.prompt = text(b.prompt, 2000, `${where}: what to extract`);
      const schema = Object.entries(b.schema ?? {});
      if (!schema.length) throw new Error(`${where}: add at least one field to extract`);
      for (const [f, t] of schema) {
        if (!FIELD.test(f)) throw new Error(`${where}: field "${f}" must be letters, digits and _`);
        if (!FIELD_TYPES.includes(t)) throw new Error(`${where}: field "${f}" has an unknown type "${t}"`);
      }
      out.schema = Object.fromEntries(schema);
    }
    if (b.type === 'validate') {
      out.prompt = text(b.prompt, 2000, `${where}: condition`);
      if (!out.prompt) throw new Error(`${where}: what must be true on the page?`);
    }
    if (b.type === 'test') {
      out.test = String(b.test ?? '');
      if (!testExists(out.test)) throw new Error(`${where}: choose a saved test of this project`);
    }
    if (b.type === 'http') {
      const method = String(b.method ?? 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`${where}: unknown method ${method}`);
      const url = text(b.url, 1000, `${where}: URL`);
      if (!/^(https?:\/\/|\{\{)/.test(url)) throw new Error(`${where}: the URL must start with http(s):// or {{`);
      const headers = {};
      for (const [h, v] of Object.entries(b.headers ?? {})) {
        if (!/^[A-Za-z0-9-]{1,60}$/.test(h)) throw new Error(`${where}: invalid header name "${h}"`);
        headers[h] = text(v, 2000, `${where}: header ${h}`);
      }
      Object.assign(out, { method, url, headers, body: text(b.body, 20000, `${where}: body`) });
    }
    if (b.type === 'loop') {
      if (depth) throw new Error(`${where}: a loop cannot be inside another loop`);
      const over = b.over === 'ref' ? 'ref' : 'csv';
      out.over = over;
      if (over === 'csv') { out.csv = text(b.csv, 20000, `${where}: rows`); if (!out.csv) throw new Error(`${where}: add rows (CSV with a header line)`); }
      else { out.ref = text(b.ref, 200, `${where}: list`); if (!/^\{\{\s*(blocks|params)\.[\w.]+\s*\}\}$/.test(out.ref)) throw new Error(`${where}: the list must be a reference like {{blocks.orders.items}}`); }
      out.blocks = (b.blocks ?? []).map(x => block(x, depth + 1));
      if (!out.blocks.length) throw new Error(`${where}: add blocks inside the loop`);
    }
    return out;
  };
  const blocks = (wf.blocks ?? []).map(b => block(b, 0));
  if (!blocks.length) throw new Error('Add at least one block');
  return { name, description: text(wf.description, 500, 'Description'), params, blocks };
}

// {{params.x}}, {{blocks.key}}, {{blocks.key.field}}, {{item}}, {{item.x}}: filled here, before the AI or a request
// sees the text. Everything else ({{appUrl}}, {{today}}, secrets) is left for the usual resolver.
export function lookup(path, ctx) {
  const [root, ...rest] = path.split('.');
  let v = root === 'params' ? ctx.params : root === 'blocks' ? ctx.outputs : root === 'item' ? ctx.item : undefined;
  if (v === undefined) return undefined;
  for (const k of rest) { if (v == null || typeof v !== 'object') return undefined; v = v[k]; }
  return v;
}
export function fillRefs(str, ctx) {
  return String(str ?? '').replace(/\{\{\s*((?:params|blocks|item)(?:\.[\w-]+)*)\s*\}\}/g, (m, path) => {
    const v = lookup(path, ctx);
    if (v === undefined) throw new Error(`${m} has no value yet: check the name, or that the block before it ran`);
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// Loop items: CSV rows, or the list an earlier block produced
export function loopItems(block, ctx, parseCsv) {
  let items;
  if (block.over === 'csv') items = parseCsv(fillRefs(block.csv, ctx));
  else {
    items = lookup(block.ref.replace(/^\{\{\s*|\s*\}\}$/g, ''), ctx);
    if (!Array.isArray(items)) throw new Error(`${block.ref} is not a list`);
  }
  if (items.length > MAX_ITEMS) throw new Error(`A loop runs at most ${MAX_ITEMS} times (this list has ${items.length})`);
  return items;
}

/* ---------- the AI's part ---------- */
export const SYSTEM = `You are a web automation agent working through one block of a workflow. The user watches the browser live.
The browser is already open and may already be logged in or on the right page from earlier blocks: look at it first (take a snapshot) and do not start over unless you have to.
Use the Playwright browser tools only. Whenever a browser tool takes an "element" description, fill it with the element's visible label and type, e.g. "Login button"; it is shown to the user as the step name.
Values in double braces, like {{APP_PASS}}, {{today}} or {{appUrl}}, are filled in by the system when a browser tool runs: type them exactly as written, braces included. Uppercase ones are secrets you will never see.
Answer in English, even if the instructions are in another language, in the exact format the block asks for.`;

const schemaText = schema => JSON.stringify(Object.fromEntries(Object.entries(schema).map(([f, t]) => [f, t === 'list' ? ['...'] : `<${t}>`])));

export function blockPrompt(block, { url = '', secrets = [], envVars = [] } = {}) {
  const common = [
    envVars.length && `Environment values you can use: ${envVars.map(n => `{{${n}}}`).join(', ')}.`,
    secrets.length && `Secrets you can use: ${secrets.map(n => `{{${n}}}`).join(', ')}.`,
  ];
  if (block.type === 'ai') return [
    url ? `First open: ${url}` : 'Continue in the page that is open now.',
    ...common,
    `Task:\n${block.prompt}`,
    'When done, answer with a first line exactly "RESULT: SUCCESS" or "RESULT: FAILED", then one or two sentences of evidence (what is on screen).',
  ].filter(Boolean).join('\n\n');
  if (block.type === 'extract') return [
    'Read the page that is open now (take a snapshot). Do not click or type unless the data is hidden behind a tab or "show more".',
    ...common,
    block.prompt && `What to extract:\n${block.prompt}`,
    `Answer with a first line exactly "RESULT: SUCCESS" (or "RESULT: FAILED" if the data is not there), then one \`\`\`json block with exactly this shape:\n${schemaText(block.schema)}\nA list field is a JSON array (of strings, or of objects when there are several columns). Copy values exactly as shown on the page.`,
  ].filter(Boolean).join('\n\n');
  if (block.type === 'validate') return [
    'Check the page that is open now (take a snapshot). Do not change anything: no clicking, typing or navigating, except scrolling to see more.',
    `Condition that must be true:\n${block.prompt}`,
    'Answer with a first line exactly "VALID: YES" or "VALID: NO", then what you actually see that decides it.',
  ].join('\n\n');
  throw new Error(`No AI prompt for a ${block.type} block`);
}

// "Rp 1.250.000,50" and "$1,250,000.50" -> 1250000.5. A separator followed by exactly 3 digits is a thousands
// separator (Indonesian 500.000 = 500000). ponytail: so "1.500" means 1500 too; use a string field if that is wrong.
export function toNumber(s) {
  let t = String(s).replace(/[^\d.,-]/g, '');
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, '');
  else if (t.includes('.') && t.includes(',')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else t = t.replace(',', '.');
  const n = Number(t);
  return t && !Number.isNaN(n) ? n : null;
}

// The AI's final answer for a block -> { ok, output?, evidence }
export function readAnswer(block, answer = '') {
  const evidence = answer.replace(/```[\s\S]*?```/g, '').replace(/^\s*\**(RESULT|VALID):\s*\w+\**\s*/i, '').trim();
  if (block.type === 'validate') {
    const v = answer.match(/VALID:\s*(YES|NO)/i)?.[1]?.toUpperCase();
    return { ok: v === 'YES', evidence: v ? evidence : `The AI did not answer VALID: YES or NO. ${evidence}` };
  }
  const ok = /RESULT:\s*SUCCESS/i.test(answer);
  if (block.type !== 'extract') return { ok, evidence };
  const raw = answer.match(/```(?:json)?\s*\n([\s\S]*?)```/)?.[1];
  let output;
  try { output = JSON.parse(raw ?? ''); } catch { return { ok: false, evidence: `The AI's data was not valid JSON. ${evidence}` }; }
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { ok: false, evidence: `The AI's data was not an object. ${evidence}` };
  const missing = Object.keys(block.schema).filter(f => output[f] === undefined || output[f] === null || output[f] === '');
  for (const [f, t] of Object.entries(block.schema)) {
    if (t === 'number' && typeof output[f] === 'string') output[f] = toNumber(output[f]) ?? output[f];
    if (t === 'list' && output[f] !== undefined && !Array.isArray(output[f])) output[f] = [output[f]];
  }
  return { ok: ok && !missing.length, output, evidence: missing.length ? `Not found: ${missing.join(', ')}. ${evidence}` : evidence };
}
