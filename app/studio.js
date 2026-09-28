// Workflow Studio: blocks in a vertical chain on a canvas, the chosen block's settings in the side panel.
// Blocks can be dragged (or moved with the buttons) to reorder; loops hold their own chain. JSON view for bulk edits.

export const BLOCKS = {
  ai: { name: 'AI Task', hint: 'The AI does a task in the browser', summary: b => b.prompt },
  extract: { name: 'Extract', hint: 'Reads data from the page into fields', summary: b => Object.keys(b.schema ?? {}).join(', ') || 'no fields yet' },
  validate: { name: 'Validate', hint: 'Checks a condition on the page: pass or fail', summary: b => b.prompt },
  test: { name: 'Saved test', hint: 'Runs a saved Playwright test, no AI', summary: b => b.test || 'no test chosen' },
  loop: { name: 'Loop', hint: 'Runs the blocks inside once per row or item', summary: b => b.over === 'ref' ? `each item of ${b.ref || '…'}` : `each CSV row (${Math.max(0, (b.csv ?? '').trim().split('\n').length - 1)})` },
  http: { name: 'HTTP request', hint: 'Calls an API; its answer feeds later blocks', summary: b => `${b.method ?? 'GET'} ${b.url || '…'}` },
};
const TYPES = Object.keys(BLOCKS);
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

export function createStudio({ $, api, esc, project, onRun, onClose }) {
  let wf, id, sel = null, tests = [], dirty = false, drag = null, mode = 'blocks';
  const el = $('studio');

  // path: [i] or [i, j] (block j inside loop i)
  const listAt = path => (path.length > 1 ? wf.blocks[path[0]].blocks : wf.blocks);
  const blockAt = path => (path ? listAt(path)[path.at(-1)] : null);
  const allBlocks = () => wf.blocks.flatMap(b => [b, ...(b.blocks ?? [])]);
  const touch = () => { dirty = true; $('stSave').textContent = 'Save*'; };
  const uniqueKey = (base, except) => { let k = base, i = 2; while (allBlocks().some(b => b !== except && (b.key ?? keyOf(b.label)) === k)) k = `${base}_${i++}`; return k; };

  async function open(workflowId) {
    id = workflowId; sel = null; dirty = false; mode = 'blocks';
    [wf, tests] = await Promise.all([
      id ? api(`/workflows/${id}?project=${project().id}`) : Promise.resolve({ name: 'New workflow', description: '', params: [], blocks: [newBlock('ai')] }),
      api(`/tests?project=${project().id}`).then(ts => ts.map(t => t.name)),
    ]);
    delete wf.id;
    for (const b of allBlocks()) b.key ??= uniqueKey(keyOf(b.label), b);
    $('stName').value = wf.name; $('stErr').textContent = ''; $('stSave').textContent = 'Save';
    $('stSave').hidden = $('stRun').hidden = false; $('stName').readOnly = false;
    el.hidden = false; document.body.classList.add('studio-open');
    render();
    if (!id) select([0]);
  }
  function close() {
    if (dirty && !confirm('Leave without saving your changes?')) return;
    el.hidden = true; document.body.classList.remove('studio-open'); onClose();
  }

  /* ---------- canvas ---------- */
  const gap = (path, inLoop) => `<div class="st-gap" data-gap="${path.join('.')}"><button type="button" class="st-add" data-add="${path.join('.')}" data-inloop="${inLoop ? 1 : ''}" aria-label="Add a block here">+</button></div>`;
  function card(b, path) {
    const on = sel && sel.join('.') === path.join('.');
    const inner = b.type === 'loop'
      ? `<div class="st-loop">${b.blocks.map((c, j) => gap([path[0], j], true) + card(c, [path[0], j])).join('')}${gap([path[0], b.blocks.length], true)}</div>` : '';
    return `<div class="st-card t-${b.type}${on ? ' on' : ''}" data-path="${path.join('.')}" draggable="true" tabindex="0" role="button" aria-label="${esc(`${BLOCKS[b.type].name}: ${b.label}`)}">
        <div class="st-card-head"><span class="st-n">${path.map(i => i + 1).join('.')}</span><span class="st-type">${BLOCKS[b.type].name}</span><code class="st-key">${esc(b.key)}</code></div>
        <div class="st-label">${esc(b.label)}</div>
        <div class="st-sum">${esc(String(BLOCKS[b.type].summary(b) ?? '').slice(0, 110))}</div>
        ${inner}
      </div>`;
  }
  function render() {
    $('stModeBlocks').setAttribute('aria-pressed', String(mode === 'blocks'));
    $('stModeJson').setAttribute('aria-pressed', String(mode === 'json'));
    $('stCanvas').hidden = mode !== 'blocks'; $('stJson').hidden = mode !== 'json';
    if (mode === 'json') { $('stJsonText').value = JSON.stringify(wf, null, 2); $('stPanel').innerHTML = '<p class="hint">Edit the whole workflow as JSON, then switch back to Blocks. Keys: type, label, key, and the fields of each block type.</p>'; return; }
    $('stChain').innerHTML = `<div class="st-start">Start${wf.params.length ? `: ${wf.params.map(p => `<code>${esc(p.name)}</code>`).join(' ')}` : ''}</div>`
      + wf.blocks.map((b, i) => gap([i]) + card(b, [i])).join('') + gap([wf.blocks.length]) + '<div class="st-end">End</div>';
    renderPanel();
  }
  function select(path) { sel = path; render(); }

  el.addEventListener('click', e => {
    const add = e.target.closest('[data-add]');
    if (add) return palette(add, add.dataset.add.split('.').map(Number), Boolean(add.dataset.inloop));
    const c = e.target.closest('.st-card');
    if (c && $('stChain').contains(c)) { e.stopPropagation(); select(c.dataset.path.split('.').map(Number)); return; }
    if (e.target.closest('#stChain') && !e.target.closest('.st-pal')) select(null); // empty canvas: workflow settings
  });
  el.addEventListener('keydown', e => { const c = e.target.closest?.('.st-card'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(c.dataset.path.split('.').map(Number)); } });

  // "+": choose a block type
  function palette(anchor, path, inLoop) {
    document.querySelector('.st-pal')?.remove();
    const pal = document.createElement('div');
    pal.className = 'st-pal';
    pal.innerHTML = TYPES.filter(t => !(inLoop && t === 'loop')).map(t => `<button type="button" data-type="${t}" class="t-${t}"><b>${BLOCKS[t].name}</b><span>${BLOCKS[t].hint}</span></button>`).join('');
    anchor.parentElement.append(pal);
    pal.querySelector('button').focus();
    pal.onclick = e => {
      const t = e.target.closest('[data-type]')?.dataset.type; if (!t) return;
      const b = newBlock(t); b.key = uniqueKey(keyOf(b.label));
      listAt(path).splice(path.at(-1), 0, b);
      touch(); select(path);
    };
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!pal.contains(ev.target)) { pal.remove(); document.removeEventListener('click', off); } }), 0);
  }

  // drag a card onto a gap to move it (a loop cannot go inside a loop)
  el.addEventListener('dragstart', e => { const c = e.target.closest('.st-card'); if (!c) return; drag = c.dataset.path.split('.').map(Number); e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); });
  el.addEventListener('dragover', e => { const g = e.target.closest('.st-gap'); if (g && drag) { e.preventDefault(); g.classList.add('over'); } });
  el.addEventListener('dragleave', e => e.target.closest('.st-gap')?.classList.remove('over'));
  el.addEventListener('drop', e => {
    const g = e.target.closest('.st-gap'); if (!g || !drag) return;
    e.preventDefault();
    const to = g.dataset.gap.split('.').map(Number);
    move(drag, to); drag = null;
  });
  function move(from, to) {
    const b = blockAt(from);
    if (b.type === 'loop' && to.length > 1) return;
    if (to.length > 1 && from.length === 1 && to[0] === from[0]) return; // into itself
    const src = listAt(from);
    src.splice(from.at(-1), 1);
    // removing from the same list before the target shifts the target up
    if (from.length === to.length && (from.length === 1 || from[0] === to[0]) && from.at(-1) < to.at(-1)) to[to.length - 1]--;
    if (to.length > 1 && from.length === 1 && from[0] < to[0]) to[0]--;
    listAt(to).splice(to.at(-1), 0, b);
    touch(); select(to);
  }

  /* ---------- side panel ---------- */
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

  function renderPanel() {
    const p = $('stPanel');
    if (!sel) { // workflow settings
      p.innerHTML = `<h3>Workflow</h3>
        ${field('Description', 'wdesc', wf.description, { area: true, rows: 3, placeholder: 'What this workflow does' })}
        <h3>Parameters</h3>
        <p class="hint">Values asked for when the workflow runs (with a default), used as <code>{{params.name}}</code>.</p>
        <div class="st-params">${wf.params.map((x, i) => `<div class="row" data-i="${i}"><label>Name <input class="field" name="pname" value="${esc(x.name)}"></label><label>Default <input class="field" name="pdefault" value="${esc(x.default)}"></label><button type="button" class="link danger" data-act="pdel" style="margin-bottom:10px">Remove</button></div>`).join('')}</div>
        <button type="button" class="btn ghost small" data-act="padd">Add parameter</button>
        <p class="hint">Click a block to change it, or + to add one. Drag blocks to reorder.</p>`;
    } else {
      const b = blockAt(sel), t = b.type;
      p.innerHTML = `<div class="st-panel-head t-${t}"><span class="st-type">${BLOCKS[t].name}</span><span class="hint">${BLOCKS[t].hint}</span></div>
        ${field('Name', 'label', b.label)}
        ${field('Key', 'key', b.key, { hint: `later blocks use {{blocks.${b.key}…}}` })}
        ${t === 'ai' ? field('Open this URL first', 'url', b.url, { hint: 'optional: otherwise it continues on the open page', placeholder: '{{appUrl}}/orders' }) + field('What should the AI do?', 'prompt', b.prompt, { area: true, rows: 7, placeholder: 'Log in with {{appUser}} and {{APP_PASS}}, open Orders, …' }) : ''}
        ${t === 'extract' ? field('What to extract', 'prompt', b.prompt, { area: true, rows: 3, placeholder: 'The order number and status in the success message' }) + `<label>Fields</label>
          <div class="st-fields">${Object.entries(b.schema).map(([f, ty]) => `<div class="row" data-f="${esc(f)}"><label>Name <input class="field" name="fname" value="${esc(f)}"></label><label style="flex:0 0 120px">Type <select class="field" name="ftype">${['string', 'number', 'boolean', 'list'].map(o => `<option${o === ty ? ' selected' : ''}>${o}</option>`).join('')}</select></label><button type="button" class="link danger" data-act="fdel" style="margin-bottom:10px">Remove</button></div>`).join('')}</div>
          <button type="button" class="btn ghost small" data-act="fadd">Add field</button>` : ''}
        ${t === 'validate' ? field('What must be true on the page?', 'prompt', b.prompt, { area: true, rows: 4, placeholder: 'A success message with an order number is shown, and the status is Paid' }) : ''}
        ${t === 'test' ? `<label>Saved test <select class="field" name="test"><option value="">Choose…</option>${tests.map(n => `<option${n === b.test ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label><p class="hint">It starts with the browser's login from the blocks before it.</p>` : ''}
        ${t === 'loop' ? `<label>Repeat for <select class="field" name="over"><option value="csv"${b.over !== 'ref' ? ' selected' : ''}>each row of this table (CSV)</option><option value="ref"${b.over === 'ref' ? ' selected' : ''}>each item of an earlier list</option></select></label>
          ${b.over === 'ref' ? field('List', 'ref', b.ref, { placeholder: '{{blocks.orders.items}}', hint: 'a list field of an Extract block, or an HTTP answer' }) : field('Rows', 'csv', b.csv, { area: true, rows: 6, hint: 'first line = column names; use {{item.column}} inside', placeholder: 'customer,amount\nJane Doe,500000' })}` : ''}
        ${t === 'http' ? `<div class="row"><label style="flex:0 0 110px">Method <select class="field" name="method">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => `<option${m === b.method ? ' selected' : ''}>${m}</option>`).join('')}</select></label>${field('URL', 'url', b.url, { placeholder: '{{appUrl}}/api/orders/{{blocks.order.orderNo}}' })}</div>
          ${field('Headers', 'headers', Object.entries(b.headers).map(([k, v]) => `${k}: ${v}`).join('\n'), { area: true, rows: 3, hint: 'one per line, Name: value', placeholder: 'Authorization: Bearer {{API_TOKEN}}' })}
          ${b.method !== 'GET' ? field('Body', 'body', b.body, { area: true, rows: 5, placeholder: '{"order": "{{blocks.order.orderNo}}"}' }) : ''}` : ''}
        ${refsHelp(sel)}
        <label class="check"><input type="checkbox" name="cont"${b.continueOnFailure ? ' checked' : ''}> Continue with the next block if this one fails</label>
        <div class="foot"><button type="button" class="btn ghost small" data-act="up">Move up</button><button type="button" class="btn ghost small" data-act="down">Move down</button><button type="button" class="link danger" data-act="del">Delete block</button></div>`;
    }
  }

  $('stPanel').addEventListener('input', e => {
    const n = e.target.name; if (!n) return;
    const v = e.target.value;
    if (!sel) {
      if (n === 'wdesc') wf.description = v;
      const row = e.target.closest('[data-i]');
      if (row) wf.params[row.dataset.i][n === 'pname' ? 'name' : 'default'] = v;
      touch(); if (n === 'pname') $('stChain').querySelector('.st-start').innerHTML = `Start${wf.params.length ? `: ${wf.params.map(p => `<code>${esc(p.name)}</code>`).join(' ')}` : ''}`;
      return;
    }
    const b = blockAt(sel);
    if (n === 'label') { const auto = b.key === uniqueKey(keyOf(b.label), b) || b.key === keyOf(b.label); b.label = v; if (auto) { b.key = uniqueKey(keyOf(v), b); p('key').value = b.key; } }
    else if (n === 'key') b.key = v.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    else if (n === 'headers') b.headers = Object.fromEntries(v.split('\n').map(l => l.split(/:(.*)/s)).filter(([k]) => k?.trim()).map(([k, x]) => [k.trim(), (x ?? '').trim()]));
    else if (n === 'fname' || n === 'ftype') {
      const rows = [...$('stPanel').querySelectorAll('[data-f]')];
      b.schema = Object.fromEntries(rows.map(r => [r.querySelector('[name=fname]').value.trim(), r.querySelector('[name=ftype]').value]));
    } else if (n === 'cont') b.continueOnFailure = e.target.checked;
    else if (['url', 'prompt', 'test', 'csv', 'ref', 'body', 'method', 'over'].includes(n)) b[n] = v;
    touch();
    // redraw just this card's text; the panel keeps focus
    const c = $('stChain').querySelector(`.st-card[data-path="${sel.join('.')}"]`);
    if (c) { c.querySelector(':scope > .st-label').textContent = b.label; c.querySelector(':scope > .st-card-head .st-key').textContent = b.key; c.querySelector(':scope > .st-sum').textContent = String(BLOCKS[b.type].summary(b) ?? '').slice(0, 110); }
    if (['over', 'method'].includes(n)) renderPanel(); // shows other fields
  });
  const p = name => $('stPanel').querySelector(`[name=${name}]`);
  $('stPanel').addEventListener('change', e => { if (e.target.name === 'cont') { blockAt(sel).continueOnFailure = e.target.checked; touch(); } });
  $('stPanel').addEventListener('click', e => {
    const act = e.target.dataset?.act; if (!act) return;
    if (act === 'padd') { wf.params.push({ name: `param${wf.params.length + 1}`, default: '' }); touch(); return render(); }
    if (act === 'pdel') { wf.params.splice(e.target.closest('[data-i]').dataset.i, 1); touch(); return render(); }
    const b = blockAt(sel);
    if (act === 'fadd') { b.schema[`field${Object.keys(b.schema).length + 1}`] = 'string'; touch(); return render(); }
    if (act === 'fdel') { delete b.schema[e.target.closest('[data-f]').dataset.f]; touch(); return render(); }
    if (act === 'del') { if (!confirm(`Delete the block "${b.label}"${b.type === 'loop' ? ' and the blocks inside it' : ''}?`)) return; listAt(sel).splice(sel.at(-1), 1); touch(); return select(null); }
    if (act === 'up' || act === 'down') {
      const list = listAt(sel), i = sel.at(-1), j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      touch(); select([...sel.slice(0, -1), j]);
    }
  });

  /* ---------- header ---------- */
  $('stName').oninput = () => { wf.name = $('stName').value; touch(); };
  const fromJson = () => { if (mode !== 'json') return true; try { wf = JSON.parse($('stJsonText').value); wf.params ??= []; wf.blocks ??= []; return true; } catch (e) { $('stErr').textContent = `JSON: ${e.message}`; return false; } };
  $('stModeBlocks').onclick = () => { if (fromJson()) { mode = 'blocks'; sel = null; $('stErr').textContent = ''; render(); } };
  $('stModeJson').onclick = () => { mode = 'json'; render(); };
  $('stJsonText').oninput = touch;
  async function save() {
    if (!fromJson()) return null;
    wf.name = $('stName').value;
    try {
      const r = await api(id ? `/workflows/${id}?project=${project().id}` : `/workflows?project=${project().id}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(wf) });
      id = r.id; dirty = false; $('stSave').textContent = 'Saved'; $('stErr').textContent = '';
      return id;
    } catch (err) { $('stErr').textContent = err.message; return null; }
  }
  $('stSave').onclick = save;
  $('stRun').onclick = async () => { if (await save()) { el.hidden = true; document.body.classList.remove('studio-open'); onRun(id, wf); } };
  $('stBack').onclick = close;
  document.addEventListener('keydown', e => {
    if (el.hidden) return;
    if (e.key === 'Escape' && !document.querySelector('.st-pal')) close();
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  });
  return { open };
}
