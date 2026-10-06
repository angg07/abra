// Workflow Studio, a page like the others: the block palette on the left, the chain on the canvas, the chosen
// block's settings in the inspector. Loops hold their own chain; Up/Down reorder; ⋯ has the JSON and Delete.

export const BLOCKS = {
  ai: { name: 'AI task', hint: 'The AI does a task in the browser', summary: b => b.prompt },
  extract: { name: 'Extract', hint: 'Reads data from the page into fields', summary: b => Object.keys(b.schema ?? {}).join(', ') || 'no fields yet' },
  validate: { name: 'Check', hint: 'Checks a condition on the page: pass or fail', summary: b => b.prompt },
  test: { name: 'Saved test', hint: 'Runs a saved Playwright test, no AI', summary: b => b.test || 'no test chosen' },
  loop: { name: 'Loop', hint: 'Runs the blocks inside once per row or item', summary: b => b.over === 'ref' ? `each item of ${b.ref || '…'}` : `each CSV row (${Math.max(0, (b.csv ?? '').trim().split('\n').length - 1)})` },
  http: { name: 'API call', hint: 'Calls an API; its answer feeds later blocks', summary: b => `${b.method ?? 'GET'} ${b.url || '…'}` },
};
const keyOf = label => String(label).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'b_$1').slice(0, 40) || 'block';
const newBlock = type => ({
  type, label: BLOCKS[type].name,
  ...(type === 'ai' && { url: '', prompt: '' }),
  ...(type === 'extract' && { prompt: '', schema: { value: 'string' } }),
  ...(type === 'validate' && { prompt: '' }),
  ...(type === 'test' && { test: '' }),
  ...(type === 'loop' && { over: 'csv', csv: 'name\n', blocks: [] }),
  ...(type === 'http' && { method: 'GET', url: '', headers: {}, body: '' }),
});
const icon = id => `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;

export function createStudio({ $, api, esc, askDialog, askLeave, project, onRun, onClose, toast, show, onSaved = () => {} }) {
  let wf, id, sel = null, tests = [], dirty = false;

  // path: [i] or [i, j] (block j inside loop i)
  const listAt = path => (path.length > 1 ? wf.blocks[path[0]].blocks : wf.blocks);
  const blockAt = path => (path ? listAt(path)[path.at(-1)] : null);
  const allBlocks = () => wf.blocks.flatMap(b => [b, ...(b.blocks ?? [])]);
  const syncDirty = () => { $('wfDirty').hidden = !dirty; };
  const touch = () => { dirty = true; syncDirty(); };
  const uniqueKey = (base, except) => { let k = base, i = 2; while (allBlocks().some(b => b !== except && (b.key ?? keyOf(b.label)) === k)) k = `${base}_${i++}`; return k; };
  const withProject = path => `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(project().id)}`;

  async function open(workflowId) {
    id = workflowId; sel = null;
    [wf, tests] = await Promise.all([
      id ? api(withProject(`/workflows/${id}`)) : Promise.resolve({ name: '', description: '', params: [], blocks: [newBlock('ai'), newBlock('validate')] }),
      api(withProject('/tests')).then(ts => ts.map(t => t.name)),
    ]);
    delete wf.id;
    wf.params ??= []; wf.blocks ??= [];
    for (const b of wf.blocks) if (b.type === 'loop') b.blocks ??= [];
    for (const b of allBlocks()) b.key ??= uniqueKey(keyOf(b.label ?? b.type), b);
    dirty = !id; // a new workflow is not saved yet
    $('wfName').value = wf.name; $('wfNameErr').hidden = true; syncDirty();
    if (show('studio', { id: id ?? 'new' }) === false) return;
    if (!id) sel = [0];
    render();
  }
  // back to Workflows; unsaved changes ask first (the app's one leave question: Back pressed meanwhile does not ask again)
  async function close() {
    if (dirty && !await askLeave()) return false;
    dirty = false; onClose(); return true;
  }

  /* ---------- canvas ---------- */
  const num = path => path.map(i => i + 1).join('.');
  const summary = b => String(BLOCKS[b.type].summary(b) ?? '').trim().slice(0, 140) || 'Not set up yet';
  const blk = (b, path) => `<button type="button" class="blk" data-path="${path.join('.')}" aria-pressed="${sel?.join('.') === path.join('.')}">
      <span class="blk-n">${num(path)}</span><span class="sw" style="background:var(--t-${b.type})"></span>
      <span class="blk-text"><span class="blk-type">${BLOCKS[b.type].name}</span><span class="blk-sum">${esc(summary(b))}</span></span>
    </button>`;
  function render() {
    const start = `<span class="canvas-start">Start · ${esc(project().url || 'the open page')}${wf.params.length ? ` · ${wf.params.map(p => `{{params.${esc(p.name)}}}`).join(' ')}` : ''}</span>`;
    $('canvas').innerHTML = start + (wf.blocks.length
      ? wf.blocks.map((b, i) => `<span class="link-line"></span><div class="blk-wrap">${blk(b, [i])}${b.type === 'loop'
        ? `<div class="blk-children">${b.blocks.map((c, j) => `<span class="link-line"></span><div class="blk-wrap">${blk(c, [i, j])}</div>`).join('') || '<p class="hint">Empty loop: select it, then pick a block on the left.</p>'}</div>` : ''}</div>`).join('')
      : '<span class="link-line"></span><div class="empty"><b>No blocks yet</b><span>Pick a block on the left to start the chain.</span></div>');
    renderInspector();
  }
  function select(path, focus = false) {
    sel = path; render();
    if (focus && path) $('canvas').querySelector(`.blk[data-path="${path.join('.')}"]`)?.focus();
  }
  $('canvas').addEventListener('click', e => {
    const c = e.target.closest('.blk');
    if (c) return select(c.dataset.path.split('.').map(Number));
    if (e.target === $('canvas')) select(null); // empty canvas: the workflow's own settings
  });

  // the palette adds below the selected block; with a loop (or a block in it) selected, inside that loop
  function add(type) {
    const b = newBlock(type); b.key = uniqueKey(keyOf(b.label));
    let path;
    if (sel && type !== 'loop' && (sel.length > 1 || blockAt(sel).type === 'loop')) {
      const loop = wf.blocks[sel[0]];
      path = [sel[0], sel.length > 1 ? sel[1] + 1 : loop.blocks.length];
    } else path = [sel ? sel[0] + 1 : wf.blocks.length]; // a loop never goes inside a loop
    listAt(path).splice(path.at(-1), 0, b);
    touch(); select(path, true);
  }
  for (const b of document.querySelectorAll('.palette [data-add]')) b.onclick = () => add(b.dataset.add);

  /* ---------- inspector ---------- */
  // references a block may use: parameters, and the blocks before it (and before it inside its loop)
  const refsHelp = at => {
    const before = [...wf.blocks.slice(0, at[0]), ...(at.length > 1 ? wf.blocks[at[0]].blocks.slice(0, at[1]) : [])];
    const out = [
      ...wf.params.map(x => `{{params.${x.name}}}`),
      ...before.flatMap(b => b.type === 'extract' ? Object.keys(b.schema).map(f => `{{blocks.${b.key}.${f}}}`) : b.type === 'http' ? [`{{blocks.${b.key}.status}}`, `{{blocks.${b.key}.body}}`] : []),
      ...(at.length > 1 ? ['{{item}}', '{{item.<column>}}'] : []),
    ];
    return out.length ? `<p class="hint">You can use: ${out.map(r => `<code>${esc(r)}</code>`).join(' ')}</p>` : '';
  };
  const field = (label, name, value, { area = false, hint = '', placeholder = '', rows = 4 } = {}) => `<label>${label}${hint ? ` <span class="hint">${hint}</span>` : ''}${area
    ? `<textarea class="field" name="${name}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value ?? '')}</textarea>`
    : `<input class="field" name="${name}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}">`}</label>`;

  function renderInspector() {
    const p = $('insp');
    if (!sel) { // the workflow's own settings
      p.innerHTML = `<div class="card-head"><h2>Workflow</h2></div>
        <p class="hint">Select a block to set it up.</p>
        ${field('Description', 'wdesc', wf.description, { area: true, rows: 3, placeholder: 'What this workflow does' })}
        <span class="lbl">Parameters</span>
        <p class="hint">Values asked for when the workflow runs (with a default), used as <code>{{params.name}}</code>.</p>
        <div class="st-params">${wf.params.map((x, i) => `<div class="row" data-i="${i}"><label>Name <input class="field" name="pname" value="${esc(x.name)}"></label><label>Default <input class="field" name="pdefault" value="${esc(x.default)}"></label><button type="button" class="link danger" data-act="pdel">Remove</button></div>`).join('')}</div>
        <button type="button" class="btn ghost small" data-act="padd">Add parameter</button>`;
      return;
    }
    const b = blockAt(sel), t = b.type, list = listAt(sel), i = sel.at(-1);
    p.innerHTML = `<div class="card-head"><span class="sw" style="background:var(--t-${t})"></span><h2>${num(sel)}. ${BLOCKS[t].name}</h2></div>
      ${t === 'ai' ? field('Instruction for the AI', 'prompt', b.prompt, { area: true, rows: 4, placeholder: 'Log in with {{appUser}} and {{APP_PASS}}, open Orders, …' }) : ''}
      ${t === 'extract' ? field('What to extract', 'prompt', b.prompt, { area: true, rows: 3, placeholder: 'The order number and status in the success message' }) + `<span class="lbl">Save as fields</span>
        <div class="st-fields">${Object.entries(b.schema).map(([f, ty]) => `<div class="row" data-f="${esc(f)}"><label>Name <input class="field" name="fname" value="${esc(f)}"></label><label class="narrow-col">Type <select class="field" name="ftype">${['string', 'number', 'boolean', 'list'].map(o => `<option${o === ty ? ' selected' : ''}>${o}</option>`).join('')}</select></label><button type="button" class="link danger" data-act="fdel">Remove</button></div>`).join('')}</div>
        <button type="button" class="btn ghost small" data-act="fadd">Add field</button>` : ''}
      ${t === 'validate' ? field('Expected result', 'prompt', b.prompt, { area: true, rows: 4, placeholder: 'A success message with an order number is shown' }) : ''}
      ${t === 'test' ? `<label>Saved test <select class="field" name="test"><option value="">Choose…</option>${tests.map(n => `<option${n === b.test ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label><p class="hint">It starts with the browser's login from the blocks before it.</p>` : ''}
      ${t === 'loop' ? `<label>Repeat for <select class="field" name="over"><option value="csv"${b.over !== 'ref' ? ' selected' : ''}>each row of this table (CSV)</option><option value="ref"${b.over === 'ref' ? ' selected' : ''}>each item of an earlier list</option></select></label>
        ${b.over === 'ref' ? field('List', 'ref', b.ref, { placeholder: '{{blocks.orders.items}}', hint: 'a list field of an Extract block, or an API answer' }) : field('Rows', 'csv', b.csv, { area: true, rows: 6, hint: 'first line = column names; use {{item.column}} inside', placeholder: 'customer,amount\nJane Doe,500000' })}` : ''}
      ${t === 'http' ? `<label>Method <select class="field" name="method">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => `<option${m === b.method ? ' selected' : ''}>${m}</option>`).join('')}</select></label>${field('URL', 'url', b.url, { placeholder: '{{appUrl}}/api/orders/{{blocks.order.orderNo}}' })}
        ${field('Headers', 'headers', Object.entries(b.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'), { area: true, rows: 3, hint: 'one per line, Name: value', placeholder: 'Authorization: Bearer {{API_TOKEN}}' })}
        ${b.method !== 'GET' ? field('Body', 'body', b.body, { area: true, rows: 5, placeholder: '{"order": "{{blocks.order.orderNo}}"}' }) : ''}` : ''}
      ${refsHelp(sel)}
      <details class="disclose more"><summary><span class="lbl">More options</span>${icon('chevron').replace('class="i"', 'class="i chev"')}</summary><div class="disclose-body">
        ${field('Name', 'label', b.label)}
        ${field('Key', 'key', b.key, { hint: `later blocks use {{blocks.${b.key}…}}` })}
        ${t === 'ai' ? field('Open this URL first', 'url', b.url, { hint: 'optional: otherwise it continues on the open page', placeholder: '{{appUrl}}/orders' }) : ''}
        <label class="check"><input type="checkbox" name="cont"${b.continueOnFailure ? ' checked' : ''}> Continue with the next block if this one fails</label>
      </div></details>
      <div class="insp-acts">
        <button type="button" class="btn ghost small" id="bUp"${i === 0 ? ' disabled' : ''}>↑ Up</button>
        <button type="button" class="btn ghost small" id="bDown"${i === list.length - 1 ? ' disabled' : ''}>↓ Down</button>
        <span class="grow"></span>
        <button type="button" class="btn danger small" id="bDel">${icon('x')}Remove</button>
      </div>`;
  }

  const fieldIn = name => $('insp').querySelector(`[name=${name}]`);
  $('insp').addEventListener('input', e => {
    const n = e.target.name; if (!n) return;
    const v = e.target.value;
    if (!sel) {
      if (n === 'wdesc') wf.description = v;
      const row = e.target.closest('[data-i]');
      if (row) wf.params[row.dataset.i][n === 'pname' ? 'name' : 'default'] = v;
      return touch();
    }
    const b = blockAt(sel);
    if (n === 'label') { const auto = b.key === uniqueKey(keyOf(b.label), b) || b.key === keyOf(b.label); b.label = v; if (auto) { b.key = uniqueKey(keyOf(v), b); fieldIn('key').value = b.key; } }
    else if (n === 'key') b.key = v.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    else if (n === 'headers') b.headers = Object.fromEntries(v.split('\n').map(l => l.split(/:(.*)/s)).filter(([k]) => k?.trim()).map(([k, x]) => [k.trim(), (x ?? '').trim()]));
    else if (n === 'fname' || n === 'ftype') b.schema = Object.fromEntries([...$('insp').querySelectorAll('[data-f]')].map(r => [r.querySelector('[name=fname]').value.trim(), r.querySelector('[name=ftype]').value]));
    else if (n === 'cont') b.continueOnFailure = e.target.checked;
    else if (['url', 'prompt', 'test', 'csv', 'ref', 'body', 'method', 'over'].includes(n)) b[n] = v;
    touch();
    // redraw just this block's summary; the inspector keeps focus
    const sum = $('canvas').querySelector(`.blk[data-path="${sel.join('.')}"] .blk-sum`);
    if (sum) sum.textContent = summary(b);
    if (['over', 'method'].includes(n)) renderInspector(); // shows other fields
  });
  $('insp').addEventListener('change', e => { if (e.target.name === 'cont' && sel) { blockAt(sel).continueOnFailure = e.target.checked; touch(); } });
  $('insp').addEventListener('click', async e => {
    const el = e.target.closest('button'); if (!el) return;
    const act = el.dataset.act;
    if (act === 'padd') { wf.params.push({ name: `param${wf.params.length + 1}`, default: '' }); touch(); return render(); }
    if (act === 'pdel') { wf.params.splice(el.closest('[data-i]').dataset.i, 1); touch(); return render(); }
    if (!sel) return;
    const b = blockAt(sel), list = listAt(sel), i = sel.at(-1);
    if (act === 'fadd') { b.schema[`field${Object.keys(b.schema).length + 1}`] = 'string'; touch(); return render(); }
    if (act === 'fdel') { delete b.schema[el.closest('[data-f]').dataset.f]; touch(); return render(); }
    if (el.id === 'bUp' || el.id === 'bDown') {
      const j = el.id === 'bUp' ? i - 1 : i + 1;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      touch(); return select([...sel.slice(0, -1), j], true);
    }
    if (el.id === 'bDel') {
      if (!await askDialog({ title: 'Remove block?', text: `Block ${num(sel)} (${BLOCKS[b.type].name})${b.type === 'loop' ? ' with the blocks inside it' : ''} and its settings will be removed from this workflow.`, confirm: 'Remove', danger: true })) return;
      list.splice(i, 1); touch(); toast('Block removed');
      select(list.length ? [...sel.slice(0, -1), Math.max(0, i - 1)] : sel.length > 1 ? [sel[0]] : null); // the block before it (or its loop) stays chosen
    }
  });

  /* ---------- head ---------- */
  $('wfName').oninput = () => { wf.name = $('wfName').value; $('wfNameErr').hidden = true; touch(); };
  async function save() {
    wf.name = $('wfName').value.trim();
    if (!wf.name) { $('wfNameErr').textContent = 'Name the workflow before saving, e.g. "Checkout with voucher".'; $('wfNameErr').hidden = false; $('wfName').focus(); return null; }
    if (!wf.blocks.length) { toast('Add at least one block first'); return null; }
    try {
      const r = await api(withProject(id ? `/workflows/${id}` : '/workflows'), { method: id ? 'PUT' : 'POST', body: JSON.stringify(wf) });
      id = r.id; dirty = false; syncDirty(); onSaved(id);
      toast(`Saved "${wf.name}"`);
      return id;
    } catch (err) { toast(err.message); return null; }
  }
  $('wfSave').onclick = save;
  $('wfRun').onclick = async () => { if (await save()) onRun(id, wf); };
  $('wfBack').onclick = close;

  // ⋯: the workflow as JSON, and Delete
  const closeMore = () => { $('wfMoreMenu').hidden = true; $('wfMore').setAttribute('aria-expanded', 'false'); };
  $('wfMore').onclick = e => { e.stopPropagation(); const open = $('wfMoreMenu').hidden; $('wfMoreMenu').hidden = !open; $('wfMore').setAttribute('aria-expanded', String(open)); if (open) $('wfMoreMenu').querySelector('button').focus(); };
  document.addEventListener('click', e => { if (!$('wfMoreMenu').hidden && !e.target.closest('#wfMoreWrap')) closeMore(); });
  $('wfMoreMenu').onclick = async e => {
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    closeMore();
    if (act === 'json') { $('wfJsonText').value = JSON.stringify(wf, null, 2); $('wfJsonErr').textContent = ''; $('wfJsonDlg').showModal(); }
    if (act === 'delete') {
      if (!await askDialog({ title: `Delete the workflow "${wf.name || 'New workflow'}"?`, text: id ? `The file tests/${project().id}/workflows/${id}.json will be removed.` : '', confirm: 'Delete', danger: true })) return;
      if (id) { try { await api(withProject(`/workflows/${id}`), { method: 'DELETE' }); } catch (err) { return toast(err.message); } }
      dirty = false; onClose();
    }
  };
  $('wfJsonApply').onclick = () => {
    try {
      const next = JSON.parse($('wfJsonText').value);
      // checked whole before it replaces anything: a bad edit must not cost the workflow on screen
      const okBlock = (b, inLoop) => {
        if (!b || typeof b !== 'object' || !BLOCKS[b.type]) throw new Error(`each block needs a "type": one of ${Object.keys(BLOCKS).join(', ')}`);
        if (b.type === 'loop') { if (inLoop) throw new Error('a loop cannot be inside a loop'); if (!Array.isArray(b.blocks ?? [])) throw new Error('a loop\'s "blocks" must be a list'); (b.blocks ?? []).forEach(c => okBlock(c, true)); }
      };
      if (!next || typeof next !== 'object' || !Array.isArray(next.blocks)) throw new Error('"blocks" must be a list');
      if (next.params !== undefined && !Array.isArray(next.params)) throw new Error('"params" must be a list');
      next.blocks.forEach(b => okBlock(b, false));
      wf = { ...next, params: next.params ?? [] }; delete wf.id;
      for (const b of wf.blocks) if (b.type === 'loop') b.blocks ??= [];
      for (const b of allBlocks()) b.key ??= uniqueKey(keyOf(b.label ?? b.type), b);
      $('wfName').value = wf.name ?? ''; sel = null;
      $('wfJsonDlg').close(); touch(); render();
    } catch (err) { $('wfJsonErr').textContent = `JSON: ${err.message}`; }
  };
  $('wfJsonCancel').onclick = () => $('wfJsonDlg').close();

  document.addEventListener('keydown', e => {
    if ($('view-studio').hidden) return;
    if (e.key === 'Escape') {
      if (!$('wfMoreMenu').hidden) { closeMore(); return $('wfMore').focus(); }
      if (!document.querySelector('dialog[open]') && !e.target.closest?.('input, textarea, select')) close();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  });
  return { open, isDirty: () => dirty, discard: () => { dirty = false; } };
}
