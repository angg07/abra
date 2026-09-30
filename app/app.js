// ABRA UI
import { esc, md, describe, issueLabel, issueDetail, lineDiff, isAppError, isThirdParty, isA11y } from '/shared.mjs';
import { createStudio, BLOCKS } from '/studio.js';

const $ = id => document.getElementById(id);
const store = {
  get() { try { return JSON.parse(localStorage.getItem('last') || '{}'); } catch { return {}; } },
  set(v) { try { localStorage.setItem('last', JSON.stringify({ ...store.get(), ...v })); } catch {} },
};
const saved = store.get();
$('record').checked = saved.record ?? true; $('replayRecord').checked = saved.replayRecord ?? true;
$('guide').checked = saved.guide ?? false; $('wfRecord').checked = saved.wfRecord ?? true; $('wfGuide').checked = saved.wfGuide ?? false; $('replayGuide').checked = saved.replayGuide ?? false; $('replayRepeat').value = saved.replayRepeat ?? '1';

const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: opts.body ? { 'content-type': 'application/json' } : undefined })
    .catch(() => { throw new Error('Cannot reach the app server: it is not running. Start it with "npm run app", then try again.'); }); // instead of the browser's bare "Failed to fetch"
  if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
  return r.status === 204 ? null : (r.headers.get('content-type') ?? '').includes('json') ? r.json() : r.text();
};
const ago = t => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
};
const STATUS = { pass: 'Passed', fail: 'Failed', stopped: 'Stopped', error: 'Error', blocked: 'Blocked' };
const icon = name => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
// environments a run may use: production ones only feed the block list
const testEnvs = () => (settings.environments ?? []).filter(e => !e.production);

// elements marked data-proj show only inside a project (the sidebar's sections)
function applyRoles() {
  for (const el of document.querySelectorAll('[data-proj]')) el.hidden = !project;
}

// start: never a blank page
window.__appStarted = true; // index.html shows a message when this never gets set
async function boot() {
  try {
    await loadSettings();
    $('model').value = saved.model || '';
    // first start on this computer: the requirements first. Later starts open right away and check in the
    // background; something required gone missing (e.g. Chromium deleted) brings the screen back.
    const setupStatus = () => api('/setup/status').catch(() => null);
    if (!store.get().setupSeen) { const setup = await setupStatus(); if (setup) { renderSetup(setup); show('setup'); return; } }
    await route(); // Projects first: the check loads a second Playwright once, which holds the server up briefly
    setupStatus().then(setup => { if (setup?.items.some(i => i.status === 'bad') && !document.body.classList.contains('running')) { renderSetup(setup); show('setup'); } });
  } catch (err) {
    $('projectList').innerHTML = `<div class="emptybox"><strong>The app could not load</strong>${esc(err.message)}. Check that the server is running (npm run app), then reload this page.</div>`;
  }
}

/* ---------- projects: start screen, then one project at a time (#/p/<id>) ---------- */
let project = null, projects = [];
const withProject = path => `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(project.id)}`;
// form fields (URL, instructions, ...) are remembered per project
const projectState = () => store.get().projects?.[project.id] ?? {};
const storeProject = v => store.set({ projects: { ...store.get().projects, [project.id]: { ...projectState(), ...v } } });

async function route() {
  const id = location.hash.match(/^#\/p\/([a-z0-9-]+)$/)?.[1] ?? null;
  if (document.body.classList.contains('running')) { if (id !== project?.id) history.replaceState(null, '', `#/p/${project.id}`); return; }
  try { projects = await api('/projects'); }
  catch (err) { // never a blank page: say what failed
    show('home');
    $('projectList').innerHTML = `<div class="emptybox"><strong>Projects could not be loaded</strong>${esc(err.message)}. Restart the app (npm run app) and reload this page.</div>`;
    return;
  }
  project = projects.find(p => p.id === id) ?? null;
  if (id && !project) { location.hash = ''; return; }
  $('projName').textContent = project?.name ?? 'All projects';
  applyRoles();
  if (project) enterProject(); else { renderHome(); show('home'); }
}
window.addEventListener('hashchange', route);

function renderHome() {
  document.title = 'ABRA';
  const card = p => `<article class="project">
      <button type="button" class="open" data-open="${esc(p.id)}">
        <span class="name">${icon('folder')}${esc(p.name)}</span>
        <span class="desc">${esc(p.description || 'No description')}</span>
        ${p.url ? `<span class="url">${esc(p.url)}</span>` : ''}
        <span class="facts">
          <span><b>${p.tests.length}</b> test${p.tests.length === 1 ? '' : 's'}, <b>${p.runs}</b> run${p.runs === 1 ? '' : 's'}<br>${p.last ? `Last run ${esc(ago(p.last.started))}: ${esc(STATUS[p.last.status] ?? p.last.status)}` : 'Not run yet'}</span>
          <span class="strip" aria-label="Last ${p.recent.length} runs">${[...p.recent].reverse().map(st => `<i class="${esc(st)}" title="${esc(STATUS[st] ?? st)}"></i>`).join('')}</span>
        </span>
      </button>
      ${`<button type="button" class="icon-btn edit" data-edit="${esc(p.id)}" aria-label="Edit ${esc(p.name)}" title="Edit project">${icon('edit')}</button>`}
    </article>`;
  const demo = projects.length ? '' : `<article class="project new"><button type="button" class="open" data-demo>${icon('sparkles')}<strong>Try the demo</strong><span>A practice shop with 2 saved tests: press Run and watch</span></button></article>`;
  $('projectList').innerHTML = projects.map(card).join('') + demo + `<article class="project new"><button type="button" class="open" data-new>${icon('plus')}<strong>New project</strong><span>For another application you test</span></button></article>`;
  applyRoles();
}
$('projectList').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.open) location.hash = `#/p/${b.dataset.open}`;
  if (b.dataset.edit) editProject(projects.find(p => p.id === b.dataset.edit));
  if ('new' in b.dataset) editProject(null);
  if ('demo' in b.dataset) api('/projects/demo', { method: 'POST' }).then(r => { toast('Demo ready: open Saved tests and press Run on a test'); location.hash = `#/p/${r.id}`; }, err => toast(`The demo could not be added: ${err.message}`));
};
$('newProject').onclick = () => editProject(null);

// sidebar project switcher
const closeMenu = () => { $('projMenu').hidden = true; $('projSwitch').setAttribute('aria-expanded', 'false'); };
$('projSwitch').onclick = e => {
  e.stopPropagation();
  if (!$('projMenu').hidden) return closeMenu();
  $('projMenu').innerHTML = [
    `<button type="button" role="menuitem" data-go="" aria-current="${!project}">${icon('grid')}All projects</button>`, '<hr>',
    ...projects.map(p => `<button type="button" role="menuitem" data-go="${esc(p.id)}" aria-current="${p.id === project?.id}">${icon('folder')}${esc(p.name)}</button>`),
    '<hr>', `<button type="button" role="menuitem" data-new>${icon('plus')}New project</button>`,
  ].join('');
  $('projMenu').hidden = false; $('projSwitch').setAttribute('aria-expanded', 'true');
  $('projMenu').querySelector('[aria-current="true"]')?.focus();
};
$('projMenu').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  closeMenu();
  if ('new' in b.dataset) return editProject(null);
  location.hash = b.dataset.go ? `#/p/${b.dataset.go}` : '';
};
document.addEventListener('click', e => { if (!$('projMenu').hidden && !e.target.closest('.switch-wrap')) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('projMenu').hidden) { closeMenu(); $('projSwitch').focus(); } });
$('sideToggle').onclick = () => { const open = $('side').classList.toggle('open'); $('sideToggle').setAttribute('aria-expanded', String(open)); };
$('liveChip').onclick = () => show('run');

async function enterProject() {
  document.title = `${project.name} · ABRA`;
  $('projName').textContent = project.name;
  const ps = projectState();
  $('url').value = ps.url ?? project.url ?? ''; $('task').value = ps.task ?? ''; $('taskTitle').value = ps.title ?? ''; $('expected').value = ps.expected ?? '';
  $('recUrl').value = ps.recUrl ?? project.url ?? '';
  attachFlow(null);
  applyRoles();
  await loadSettings();
  for (const sel of document.querySelectorAll('.envSel')) { // the project's environment unless one was picked here before
    const want = ps[sel.id] ?? project.env;
    sel.value = want && [...sel.options].some(o => o.value === want) ? want : settings.activeEnv || '';
  }
  show('ai');
}

// New / edit project dialog
let editingProject = null;
function editProject(p) {
  editingProject = p;
  $('projTitle').textContent = p ? `Edit ${p.name}` : 'New project';
  $('projSave').textContent = p ? 'Save project' : 'Create project';
  $('projNameIn').value = p?.name ?? ''; $('projDesc').value = p?.description ?? ''; $('projUrl').value = p?.url ?? '';
  $('projApp').value = p?.app ?? '';
  $('projCodebase').value = [].concat(p?.codebase ?? []).join('\n');
  $('projLogoField').hidden = !p; // the logo is a file in the project's folder: it needs the project to exist
  $('projLogoMsg').textContent = '';
  if (p) showProjLogo(p.hasLogo);
  $('projEnv').replaceChildren(new Option('The default environment', ''), ...testEnvs().map(e => new Option(e.name, e.name)));
  $('projEnv').value = p?.env ?? '';
  $('projDb').replaceChildren(...testEnvs().map(e => dbRow(e.name, p?.db?.[e.name], p?.dbPassSet?.[e.name])));
  if (!testEnvs().length) $('projDb').innerHTML = '<p class="muted">Add an environment first (Settings > Environments).</p>';
  $('projDelete').hidden = $('projExport').hidden = !p; $('projErr').textContent = '';
  $('projPeople').hidden = !p; // saved sessions exist once the project does
  if (p) renderProjSessions();
  $('projDlg').showModal();
}


/* ---------- share a project as a file ---------- */
$('projExport').onclick = () => { location.href = `/projects/${encodeURIComponent(editingProject.id)}/export`; };
$('importProject').onclick = () => $('importFile').click();
$('exportAll').onclick = () => {
  if (!projects.length) { toast('There are no projects to export yet'); return; }
  location.href = '/projects/export';
};
// A question with more than OK/Cancel: resolves with the value of the button picked, or null (Cancel, Esc)
function choose(title, text, options) {
  return new Promise(resolve => {
    $('chooseTitle').textContent = title; $('chooseText').textContent = text;
    const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'btn ghost', textContent: 'Cancel' });
    cancel.onclick = () => $('chooseDlg').close();
    $('chooseBtns').replaceChildren(cancel, ...options.map(([value, label], i) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: i === 0 ? 'btn' : 'btn ghost', textContent: label });
      b.onclick = () => { $('chooseDlg').returnValue = value; $('chooseDlg').close(); };
      return b;
    }));
    $('chooseDlg').returnValue = '';
    $('chooseDlg').addEventListener('close', () => resolve($('chooseDlg').returnValue || null), { once: true });
    $('chooseDlg').showModal();
  });
}
// what an imported project still needs on this computer
const importTodo = results => {
  const all = key => [...new Set(results.flatMap(r => r[key] ?? []))];
  return [
    all('missingSecrets').length && `Secrets to add (Settings → Secrets): ${all('missingSecrets').join(', ')}`,
    all('unboundSecrets').length && `Secrets to give the imported projects, if you trust them (Settings → Secrets): ${all('unboundSecrets').join(', ')}`,
    all('missingVars').length && `Environment values to add (Settings → Environments): ${all('missingVars').join(', ')}`,
    all('skippedDb').length && `Database settings skipped for environments you do not have: ${all('skippedDb').join(', ')}`,
  ].filter(Boolean);
};
$('importFile').onchange = async () => {
  const f = $('importFile').files[0]; $('importFile').value = '';
  if (!f) return;
  try {
    const bundle = JSON.parse(await f.text());
    const send = mode => fetch('/projects/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bundle, mode }) });
    const warning = 'Test files are code that runs on this computer: import only files from people you trust.';
    if (bundle.format === 'ai-browser-runner-projects') { // every project of another computer
      const list = (bundle.projects ?? []).map(b => `• ${b.project?.name ?? '?'} (${Object.keys(b.files ?? {}).length} files)`);
      if (!confirm(`Import ${list.length} projects?\n\n${list.slice(0, 25).join('\n')}${list.length > 25 ? '\n…' : ''}\n\n${warning}`)) return;
      let r = await send();
      if (r.status === 409) {
        const { conflicts } = await r.json();
        const mode = await choose('Some projects are already here', `${conflicts.length} of them already exist on this computer:\n${conflicts.join(', ')}\n\nWhat should happen to those?`,
          [['skip', 'Skip them'], ['new', 'Import as new copies'], ['overwrite', 'Overwrite their tests']]);
        if (!mode) return;
        r = await send(mode);
      }
      if (!r.ok) throw new Error(await r.text());
      const { results } = await r.json();
      const done = results.filter(x => x.id), skipped = results.filter(x => x.skipped);
      const todo = importTodo(done);
      toast(`Imported ${done.length} project${done.length === 1 ? '' : 's'}${skipped.length ? `, skipped ${skipped.length}` : ''}.${todo.length ? ' ' + todo.join('. ') + '.' : ''}`);
      location.hash = ''; route();
      return;
    }
    const names = Object.keys(bundle.files ?? {});
    if (!confirm(`Import "${bundle.project?.name ?? f.name}" (${names.length} files)?\n\n${names.slice(0, 20).join('\n')}${names.length > 20 ? '\n…' : ''}\n\n${warning}`)) return;
    let r = await send();
    if (r.status === 409) {
      const { conflict, suggestion } = await r.json();
      const overwrite = confirm(`A project "${conflict}" already exists.\n\nOK: overwrite its tests (history and sessions stay)\nCancel: import as a new project "${suggestion}"`);
      r = await send(overwrite ? 'overwrite' : 'new');
    }
    if (!r.ok) throw new Error(await r.text());
    const s = await r.json();
    const todo = importTodo([s]);
    toast(`Imported ${s.files} files into "${s.id}".${todo.length ? ' ' + todo.join('. ') + '.' : ''}`);
    location.hash = `#/p/${s.id}`; route();
  } catch (err) { toast(`Import failed: ${err.message}`); }
};

// project logo: uploaded right away (a file in tests/<project>/, so it is exported with the project)
function showProjLogo(has) {
  $('projLogo').hidden = !has; $('projLogoRemove').hidden = !has; $('projLogoNone').hidden = has;
  if (has) $('projLogo').src = `/projects/${editingProject.id}/logo?${Date.now()}`;
}
$('projLogoFile').onchange = () => {
  const f = $('projLogoFile').files[0]; if (!f) return;
  if (f.size > 350_000) { $('projLogoMsg').textContent = 'That image is too large: use one under ~350 KB.'; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try { await api(`/projects/${editingProject.id}/logo`, { method: 'POST', body: JSON.stringify({ dataUrl: reader.result }) }); editingProject.hasLogo = true; $('projLogoMsg').textContent = 'Logo saved.'; showProjLogo(true); }
    catch (err) { $('projLogoMsg').textContent = err.message; }
  };
  reader.readAsDataURL(f);
};
$('projLogoRemove').onclick = async () => { await api(`/projects/${editingProject.id}/logo`, { method: 'DELETE' }); editingProject.hasLogo = false; $('projLogoFile').value = ''; $('projLogoMsg').textContent = 'Logo removed.'; showProjLogo(false); };

function renderProjSessions() {
  const list = editingProject.sessions ?? [];
  $('projSessions').innerHTML = list.length ? list.map(x => `<div class="item" data-name="${esc(x.name)}" style="grid-template-columns:1fr auto">
      <div><div class="title">${esc(x.name)}</div><div class="sub">${esc(x.sites.join(', ') || 'no cookies')}, saved ${esc(ago(x.saved))}</div></div>
      <button type="button" class="link danger">Delete</button></div>`).join('')
    : '<p class="muted" style="padding:10px 14px; margin:0">None saved yet.</p>';
}
$('projSessions').onclick = async e => {
  const item = e.target.closest('[data-name]'); if (!item || e.target.tagName !== 'BUTTON') return;
  if (!confirm(`Delete login session "${item.dataset.name}"?`)) return;
  await api(`/projects/${editingProject.id}/sessions/${item.dataset.name}`, { method: 'DELETE' });
  editingProject.sessions = editingProject.sessions.filter(x => x.name !== item.dataset.name);
  renderProjSessions();
};

// after saving a login session: the project's lists come from the server
async function refreshProject() {
  projects = await api('/projects');
  project = projects.find(p => p.id === project.id) ?? project;
  await loadSettings();
}
// One collapsible row per test environment: where that environment's database is
function dbRow(envName, cfg, passSet) {
  const d = document.createElement('details');
  d.className = 'prov'; d.dataset.env = envName;
  d.innerHTML = `
    <summary><span class="name"></span><span class="badge"></span></summary>
    <div class="prov-body">
      <div class="grid3">
        <label>Type <select class="field" name="dtype"><option value="">No database</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option></select></label>
        <label data-db>Host <input class="field" name="dhost" placeholder="localhost"></label>
        <label data-db>Port <input class="field" name="dport" type="number" min="1" max="65535"></label>
      </div>
      <div class="grid3" data-db>
        <label>Database <input class="field" name="ddb" placeholder="myapp_e2e"></label>
        <label>User <input class="field" name="duser" autocomplete="off"></label>
        <label>Password <input class="field" name="dpass" type="password" autocomplete="new-password" placeholder="${passSet ? 'Saved. Fill in to replace it.' : ''}"></label>
      </div>
      <label class="check" data-db><input type="checkbox" name="dreset"> Reset it before every run from a clean copy <span class="hint">(PostgreSQL; only databases named with e2e or test)</span></label>
      <label data-reset>Clean copy to reset from (template database) <input class="field" name="dtemplate" placeholder="myapp_e2e_base"></label>
      <div class="foot" data-db><button type="button" class="btn ghost small" data-act="dbtest">Test connection</button><span class="msg" role="status"></span></div>
    </div>`;
  const q = n => d.querySelector(`[name=${n}]`);
  d.querySelector('.name').textContent = envName;
  q('dtype').value = cfg?.type ?? ''; q('dhost').value = cfg?.host ?? 'localhost'; q('dport').value = cfg?.port ?? '';
  q('ddb').value = cfg?.database ?? ''; q('duser').value = cfg?.user ?? ''; q('dreset').checked = Boolean(cfg?.reset); q('dtemplate').value = cfg?.template ?? '';
  const sync = () => {
    const on = Boolean(q('dtype').value);
    for (const el of d.querySelectorAll('[data-db]')) el.hidden = !on;
    d.querySelector('[data-reset]').hidden = !on || !q('dreset').checked;
    const b = d.querySelector('.badge');
    b.textContent = on ? `${q('dtype').selectedOptions[0].text}${q('ddb').value ? `: ${q('ddb').value}` : ''}${q('dreset').checked ? ', reset each run' : ''}` : 'No database';
    b.className = `badge ${on ? 'ok' : ''}`;
  };
  q('dtype').onchange = () => { if (!q('dport').value) q('dport').value = q('dtype').value === 'mysql' ? 3306 : 5432; sync(); };
  q('dreset').onchange = q('ddb').oninput = sync; sync();
  d.querySelector('[data-act=dbtest]').onclick = async () => {
    const msg = d.querySelector('.msg'); msg.className = 'msg'; msg.textContent = 'Connecting…';
    try {
      const r = await api('/db/test', { method: 'POST', body: JSON.stringify({ project: editingProject?.id, env: envName, config: dbConfigOf(d), password: q('dpass').value }) });
      msg.textContent = `Connected (${r.server})`; msg.classList.add('ok');
    } catch (err) { msg.textContent = err.message; msg.classList.add('err'); }
  };
  return d;
}
const dbConfigOf = d => {
  const v = n => d.querySelector(`[name=${n}]`);
  if (!v('dtype').value) return null;
  return { type: v('dtype').value, host: v('dhost').value.trim(), port: +v('dport').value, database: v('ddb').value.trim(), user: v('duser').value.trim(), reset: v('dreset').checked, template: v('dtemplate').value.trim() };
};
$('projCancel').onclick = $('projClose').onclick = () => $('projDlg').close();
/* codebase folder picker: the server lists folders (a browser cannot give a page a folder's full path) */
let folderAt = '';
async function openFolder(path) {
  try {
    const r = await api(`/folders?${new URLSearchParams({ path })}`);
    folderAt = r.path;
    $('folderPath').textContent = r.path;
    $('folderUp').disabled = !r.parent;
    $('folderUp').dataset.path = r.parent ?? '';
    $('folderHome').dataset.path = r.home;
    $('folderList').replaceChildren(...(r.dirs.length ? r.dirs.map(d => {
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.className = `folder-item${d.name.startsWith('.') ? ' dot' : ''}`; b.textContent = d.name;
      b.onclick = () => openFolder(d.path);
      li.append(b); return li;
    }) : [Object.assign(document.createElement('li'), { className: 'muted', textContent: 'No subfolders' })]));
    $('folderErr').textContent = '';
  } catch (e) { $('folderErr').textContent = e.message; }
}
$('projCodebasePick').onclick = async () => {
  const last = $('projCodebase').value.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '';
  await openFolder(last);
  if (last && $('folderErr').textContent) await openFolder(''); // the typed path is gone: start at home
  $('folderDlg').showModal();
};
$('folderUp').onclick = () => openFolder($('folderUp').dataset.path);
$('folderHome').onclick = () => openFolder($('folderHome').dataset.path);
$('folderForm').onsubmit = e => {
  e.preventDefault();
  const lines = $('projCodebase').value.split('\n').map(l => l.trim()).filter(Boolean);
  if (folderAt && !lines.includes(folderAt)) lines.push(folderAt);
  $('projCodebase').value = lines.join('\n');
  $('folderDlg').close();
};
$('folderCancel').onclick = $('folderClose').onclick = () => $('folderDlg').close();

$('projForm').onsubmit = async e => {
  e.preventDefault();
  const rows = [...$('projDb').querySelectorAll('details[data-env]')];
  const body = JSON.stringify({
    name: $('projNameIn').value, description: $('projDesc').value, url: $('projUrl').value, env: $('projEnv').value, app: $('projApp').value, codebase: $('projCodebase').value,
    db: Object.fromEntries(rows.map(d => [d.dataset.env, dbConfigOf(d)])),
    dbPasswords: Object.fromEntries(rows.map(d => [d.dataset.env, d.querySelector('[name=dpass]').value])),
  });
  try {
    const { id } = editingProject
      ? await api(`/projects/${editingProject.id}`, { method: 'PUT', body })
      : await api('/projects', { method: 'POST', body });
    $('projDlg').close();
    if (editingProject) route(); else location.hash = `#/p/${id}`;
  } catch (err) { $('projErr').textContent = err.message; }
};
$('projDelete').onclick = async () => {
  const p = editingProject;
  const typed = prompt(`This deletes "${p.name}" with its ${p.tests.length} saved test${p.tests.length === 1 ? '' : 's'} (the files in tests/${p.id}/), ${p.runs} run${p.runs === 1 ? '' : 's'} of history, and their videos and PDFs.\n\nType the project name to confirm:`);
  if (typed?.trim() !== p.name) { if (typed !== null) $('projErr').textContent = 'The name did not match; nothing was deleted.'; return; }
  try { await api(`/projects/${p.id}`, { method: 'DELETE' }); $('projDlg').close(); route(); }
  catch (err) { $('projErr').textContent = err.message; }
};
// the run's status pill; while a run goes on in the background, the sidebar chip; otherwise a short toast
function setStatus(text, kind = '') {
  $('status').textContent = text; $('status').className = 'pill ' + kind;
  if (document.body.classList.contains('running')) $('liveText').textContent = text;
  else if ($('view-run').hidden) toast(text);
}
let toastTimer;
function toast(text) {
  $('toast').textContent = text; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
}

/* ---------- views ---------- */
let origin = 'ai'; // where the current run page was opened from
let lastPage = 'home'; // where Settings returns to
function show(view) {
  // leaving Settings with unsaved changes: ask first
  if (view !== 'settings' && !$('view-settings').hidden && settingsDirty().length
    && !confirm(`You have unsaved changes in ${settingsDirty().join(', ')}. Leave without saving?`)) return;
  for (const v of ['home', 'setup', 'guide', 'ai', 'record', 'tests', 'workflows', 'history', 'settings', 'run']) (v === 'home' ? $('home') : $(`view-${v}`)).hidden = v !== view;
  const navView = view === 'run' ? origin : view;
  for (const b of document.querySelectorAll('nav.views button')) b.setAttribute('aria-current', b.dataset.view === navView ? 'page' : 'false');
  $('liveChip').hidden = !document.body.classList.contains('running') || view === 'run';
  for (const b of document.querySelectorAll('.openSettings')) b.setAttribute('aria-current', view === 'settings' ? 'page' : 'false');
  if (!['settings', 'run', 'setup', 'guide'].includes(view)) lastPage = view;
  $('openSetup').setAttribute('aria-current', view === 'setup' ? 'page' : 'false');
  if (view === 'tests') loadTests();
  if (view === 'history') loadHistory();
  if (view === 'workflows') loadWorkflows();
  $('scroll').scrollTop = 0; $('side').classList.remove('open');
}
// a run may go on while you look elsewhere; switching project waits for it
// Projects: the hash may already be empty (no project open), then there is no hashchange to route on
for (const b of document.querySelectorAll('nav.views button')) b.onclick = () => (b.dataset.view !== 'home' ? show(b.dataset.view) : location.hash ? (location.hash = '') : route());

// closing the app window (or the tab) during a run stops the run: ask first
window.addEventListener('beforeunload', e => { if (document.body.classList.contains('running')) e.preventDefault(); });

/* ---------- guide editor: the document behind a run's PDF guide ---------- */
let guideEdit = null; // { pdf, doc, dirty }
const GUIDE_KINDS = { step: 'Step', section: 'Section heading', tip: 'Note', alert: 'Warning' };
async function openGuideEditor(pdf) {
  try { guideEdit = { pdf, doc: await api(`/guides/${encodeURIComponent(pdf)}/doc`), dirty: false }; }
  catch (err) { toast(err.message); return; }
  $('guideOpen').href = `/guides/${encodeURIComponent(pdf)}`;
  renderGuideEditor();
  show('guide');
}
function renderGuideEditor() {
  const { doc, pdf } = guideEdit;
  const root = $('guideDoc');
  const changed = () => { guideEdit.dirty = true; };
  const field = (tag, value, onInput, cls = '', attrs = {}) => {
    const f = document.createElement(tag);
    f.className = `field ${cls}`.trim(); f.value = value ?? '';
    if (tag === 'textarea') { f.rows = Math.min(8, Math.max(2, String(value ?? '').split('\n').length + 1)); }
    for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v);
    f.oninput = () => { onInput(f.value); changed(); };
    return f;
  };
  const addRow = at => {
    const row = document.createElement('div'); row.className = 'gadd';
    for (const [type, label] of [['section', '+ Section heading'], ['tip', '+ Note'], ['alert', '+ Warning']]) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost small'; b.textContent = label;
      b.onclick = () => { doc.blocks.splice(at, 0, type === 'section' ? { type, text: '', level: 1 } : { type, text: '' }); changed(); renderGuideEditor(); root.querySelectorAll('.gblock')[at + 1]?.querySelector('input, textarea')?.focus(); };
      row.append(b);
    }
    return row;
  };
  const tools = i => {
    const wrap = document.createElement('span');
    for (const [label, act, dis] of [['↑', 'up', i === 0], ['↓', 'down', i === doc.blocks.length - 1], ['✕', 'del', false]]) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'icon-btn'; b.textContent = label; b.disabled = dis;
      b.setAttribute('aria-label', { up: 'Move up', down: 'Move down', del: 'Delete' }[act]);
      b.onclick = () => {
        if (act === 'del' && doc.blocks[i].type === 'step' && !confirm('Delete this step and its screenshot from the guide?')) return;
        if (act === 'del') doc.blocks.splice(i, 1);
        else { const j = act === 'up' ? i - 1 : i + 1; [doc.blocks[i], doc.blocks[j]] = [doc.blocks[j], doc.blocks[i]]; }
        changed(); renderGuideEditor();
      };
      wrap.append(b);
    }
    return wrap;
  };
  const head = document.createElement('div'); head.className = 'gblock';
  const title = field('input', doc.title, v => { doc.title = v; }, 'g-title', { 'aria-label': 'Title', maxlength: '200' });
  const desc = field('textarea', doc.description, v => { doc.description = v; }, '', { 'aria-label': 'Description', placeholder: 'Description under the title (optional): what this guide covers, who it is for' });
  head.append(title, desc);
  const parts = [head, addRow(0)];
  let n = 0;
  doc.blocks.forEach((b, i) => {
    const card = document.createElement('div'); card.className = `gblock g-${b.type}`;
    const h = document.createElement('div'); h.className = 'gblock-head';
    if (b.type === 'step') { const num = document.createElement('span'); num.className = 'gnum'; num.textContent = ++n; h.append(num); }
    const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = GUIDE_KINDS[b.type]; h.append(kind, tools(i));
    card.append(h);
    if (b.type === 'section') {
      const lvl = document.createElement('select'); lvl.className = 'field small';
      lvl.innerHTML = '<option value="1">Heading</option><option value="2">Sub-heading</option>'; lvl.value = String(b.level ?? 1);
      lvl.onchange = () => { b.level = Number(lvl.value); changed(); };
      card.append(field('input', b.text, v => { b.text = v; }, '', { 'aria-label': 'Section heading', placeholder: 'e.g. Upload data from Excel' }), lvl);
    } else {
      card.append(field('textarea', b.text, v => { b.text = v; }, '', { 'aria-label': GUIDE_KINDS[b.type], placeholder: b.type === 'step' ? 'What the reader does' : b.type === 'tip' ? 'Something useful to know here, e.g.\n- Dates in dd/mm/yyyy\n- Fields with a red header are required' : 'Something to watch out for' }));
      if (b.type === 'step') {
        card.append(field('textarea', b.detail, v => { b.detail = v; }, 'small', { 'aria-label': 'Detail', placeholder: 'Detail (optional): the value typed, what appears afterwards' }));
        if (b.frame) { const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.src = `/guides/${encodeURIComponent(pdf)}/${b.frame}`; card.append(img); }
        card.append(guideImageTools(b));
        card.addEventListener('paste', e => { // a screenshot pasted into the step replaces its image
          const file = [...(e.clipboardData?.files ?? [])].find(f => /^image\/(png|jpeg)$/.test(f.type));
          if (file) { e.preventDefault(); putGuideImage(b, file); }
        });
      }
    }
    parts.push(card, addRow(i + 1));
  });
  root.replaceChildren(...parts);
}
// Replace image / Add image / Remove image under a step (a file, or a screenshot pasted into the card)
function guideImageTools(b) {
  const row = document.createElement('div'); row.className = 'gimg-tools';
  const pick = document.createElement('label'); pick.className = 'btn ghost small';
  pick.textContent = b.frame ? 'Replace image' : 'Add image';
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg'; input.className = 'visually-hidden';
  input.onchange = () => { if (input.files[0]) putGuideImage(b, input.files[0]); };
  pick.append(input);
  row.append(pick);
  if (b.frame) {
    const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'link danger'; rm.textContent = 'Remove image';
    rm.onclick = () => { delete b.frame; guideEdit.dirty = true; renderGuideEditor(); };
    row.append(rm);
  }
  const hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = 'or paste a screenshot here (Ctrl+V)';
  row.append(hint);
  return row;
}
async function putGuideImage(b, file) {
  if (file.size > 10_000_000) { toast('The image is too large (at most 10 MB)'); return; }
  const dataUrl = await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(file); });
  try {
    const { frame } = await api(`/guides/${encodeURIComponent(guideEdit.pdf)}/frame`, { method: 'POST', body: JSON.stringify({ dataUrl }) });
    b.frame = frame; guideEdit.dirty = true;
    renderGuideEditor();
    toast('Image replaced: save to make the PDF again');
  } catch (err) { toast(err.message); }
}
$('guideSave').onclick = async () => {
  if (!guideEdit) return;
  $('guideSave').disabled = true;
  try {
    await api(`/guides/${encodeURIComponent(guideEdit.pdf)}/doc`, { method: 'PUT', body: JSON.stringify({ doc: guideEdit.doc }) });
    guideEdit.dirty = false;
    $('guideOpen').href = `/guides/${encodeURIComponent(guideEdit.pdf)}?v=${Date.now()}`; // the browser's copy is old
    toast('Guide saved: the PDF is made again');
  } catch (err) { toast(err.message); }
  finally { $('guideSave').disabled = false; }
};
$('guideBack').onclick = () => { if (guideEdit?.dirty && !confirm('Leave without saving your changes to the guide?')) return; show('run'); };

/* ---------- first run: what this computer needs (Requirements) ---------- */
const SETUP_PILL = { ok: ['pass', 'Ready'], warn: ['run', 'Optional'], bad: ['fail', 'Required'] };
function renderSetup(setup) {
  $('setupOs').textContent = setup.osName;
  $('setupList').replaceChildren(...setup.items.map(i => {
    const el = document.createElement('div');
    el.className = 'setup-item';
    const [cls, word] = SETUP_PILL[i.status];
    el.innerHTML = `<span class="pill ${cls}">${word}</span><h3>${esc(i.label)}</h3><p class="detail">${esc(i.detail)}</p>`;
    if (i.status !== 'ok' && (i.action || i.fix.length)) {
      if (i.action === 'browsers') el.insertAdjacentHTML('beforeend', `<div class="actions"><button type="button" class="btn small" data-browsers>Download Chromium</button></div>`);
      if (i.fix.length) {
        const fix = document.createElement('div');
        fix.className = 'fix';
        fix.innerHTML = `<span class="hint">How to install on ${esc(setup.osName)}:</span>` + i.fix.map(f => (f.cmd
          ? `${f.note ? `<span class="hint">${esc(f.note)}</span>` : ''}<div class="row"><code>${esc(f.cmd)}</code><button type="button" class="btn ghost small" data-copy="${esc(f.cmd)}">Copy</button></div>`
          : `<span class="hint">${esc(f.note)}</span>`)).join('');
        el.append(fix);
      }
    }
    return el;
  }));
  const blocked = setup.items.some(i => i.status === 'bad');
  $('setupContinue').disabled = blocked;
  $('setupContinue').title = blocked ? 'Get the Required items ready first' : '';
  for (const b of $('setupList').querySelectorAll('[data-copy]')) b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied'), () => toast('Select the text and copy it'));
  for (const b of $('setupList').querySelectorAll('[data-browsers]')) b.onclick = downloadBrowsers;
}
async function recheckSetup() { renderSetup(await api('/setup/status')); }
function downloadBrowsers() {
  for (const b of $('setupList').querySelectorAll('[data-browsers]')) { b.disabled = true; b.textContent = 'Downloading…'; }
  const log = $('setupLog');
  log.hidden = false; log.textContent = '';
  const es = new EventSource('/setup/browsers');
  es.addEventListener('log', e => {
    const line = JSON.parse(e.data);
    if (line.startsWith('↓') && /(^|\n)↓[^\n]*\n$/.test(log.textContent)) log.textContent = log.textContent.replace(/↓[^\n]*\n$/, ''); // one progress line
    log.textContent += `${line}\n`; log.scrollTop = log.scrollHeight;
  });
  es.addEventListener('done', async e => {
    es.close();
    const { ok } = JSON.parse(e.data);
    log.textContent += ok ? 'Done.\n' : 'The download failed: see the lines above.\n';
    await recheckSetup();
  });
  es.onerror = async () => { if (es.readyState === EventSource.CLOSED) return; es.close(); log.textContent += 'The connection to the app was lost.\n'; await recheckSetup(); };
}
$('setupRecheck').onclick = () => recheckSetup().then(() => toast('Checked'), err => toast(err.message));
$('setupContinue').onclick = () => { store.set({ setupSeen: true }); route(); };
$('openSetup').onclick = async () => { try { renderSetup(await api('/setup/status')); show('setup'); } catch (err) { toast(err.message); } };

/* ---------- live view ---------- */
let live;
function startLive(runId) { // the browser of one run; the server checks the run is in your projects
  live?.close();
  live = new EventSource('/screen?' + new URLSearchParams({ run: runId }));
  live.addEventListener('frame', e => { $('frame').src = 'data:image/jpeg;base64,' + JSON.parse(e.data); $('stage').classList.add('has-frame'); });
  live.addEventListener('url', e => { $('addr').textContent = JSON.parse(e.data); });
}

/* ---------- settings data (providers, sessions, secrets) ---------- */
let settings = {};
async function loadSettings() {
  settings = await api('/settings');
  const current = $('provider').value || saved.provider;
  $('provider').replaceChildren(...settings.providers.map(p => {
    const o = new Option(p.ready ? p.label : `${p.label} (API key missing)`, p.id);
    o.disabled = !p.ready; o.dataset.model = p.model;
    return o;
  }));
  if (settings.providers.find(p => p.id === current && p.ready)) $('provider').value = current;
  $('model').placeholder = $('provider').selectedOptions[0]?.dataset.model || 'default';
  const sessions = project?.sessions ?? []; // saved logins belong to a project
  for (const sel of document.querySelectorAll('.sessionSel')) {
    const cur = sel.value || saved[sel.id];
    sel.replaceChildren(new Option('None (start fresh)', ''), ...sessions.map(s => new Option(`${s.name} (${s.sites.join(', ') || 'empty'})`, s.name)));
    if (sessions.some(s => s.name === cur)) sel.value = cur;
  }
  for (const sel of document.querySelectorAll('.envSel')) {
    const cur = sel.value || saved[sel.id] || settings.activeEnv;
    sel.replaceChildren(new Option('None', ''), ...testEnvs().map(e => new Option(e.name + (e.name === settings.activeEnv ? ' (default)' : ''), e.name)));
    sel.value = testEnvs().some(e => e.name === cur) ? cur : settings.activeEnv || '';
    sel.closest('label').hidden = !testEnvs().length;
  }
  const envVars = Object.keys(settings.environments.find(e => e.name === $('aiEnv').value)?.vars ?? {});
  $('secretHint').innerHTML = [
    project?.secrets?.length ? `Secrets: ${project.secrets.map(n => `<code>{{${esc(n)}}}</code>`).join(' ')}` : '',
    envVars.length ? `Environment: ${envVars.map(n => `<code>{{${esc(n)}}}</code>`).join(' ')}` : '',
    'Values: <code>{{today}}</code> <code>{{today+3}}</code> <code>{{random}}</code>',
  ].filter(Boolean).join('<br>');
}
boot();
$('provider').onchange = () => { $('model').value = ''; $('model').placeholder = $('provider').selectedOptions[0].dataset.model || 'default'; };

/* ---------- running (AI or replay), shared ---------- */
let es, timer, started, current; // current = { kind, params, id, doneMsg }
const clock = () => { const s = Math.round((Date.now() - started) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function addStep(t) {
  const { what, detail } = describe(t);
  const li = document.createElement('li');
  const n = $('steps').querySelectorAll('.step').length + 1;
  li.innerHTML = `<details class="step"><summary><span class="n">${n}</span><span><span class="what">${esc(what)}</span><span class="detail">${esc(detail)}</span></span></summary><pre>${esc(JSON.stringify(t.input, null, 2))}</pre></details>`;
  $('steps').append(li);
  $('stepCount').textContent = `${n} steps`;
  return { li, what, detail };
}
function addNote(text, cls = 'note') {
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = cls === 'note' ? md(text) : esc(text);
  $('steps').append(li);
  return li;
}
// Replay steps: already in plain language, no raw tool input to show
function addPlainStep(s) {
  const li = document.createElement('li');
  if (s.section) { li.className = 'section'; li.textContent = s.section; $('steps').append(li); return li; }
  const n = $('steps').querySelectorAll('.step').length + 1;
  li.innerHTML = `<div class="step plainstep"><span class="n">${n}</span><span><span class="what">${esc(s.what)}</span>${s.detail ? `<span class="detail">${esc(s.detail)}</span>` : ''}</span></div>`;
  $('steps').append(li);
  $('stepCount').textContent = `${n} steps`;
  return li;
}
function caption(what, detail) {
  $('capWhat').textContent = what; $('capDetail').textContent = detail; $('caption').hidden = false;
  $('caption').classList.remove('pop'); void $('caption').offsetWidth; $('caption').classList.add('pop');
}

function openRunPage({ task, who, kind }) {
  $('runTask').textContent = task; $('runWho').textContent = who;
  $('steps').replaceChildren(); $('log').textContent = ''; $('result').hidden = true;
  $('logWrap').hidden = kind === 'ai'; $('logWrap').open = false; $('issuesBox').hidden = true;
  $('trailTitle').textContent = kind === 'replay' ? 'Test steps' : kind === 'workflow' ? 'Blocks' : 'AI steps'; $('stepCount').textContent = '';
  show('run'); $('runScroll').scrollTop = 0;
}
function setRunButtons(state) { // running | done | history
  $('stop').hidden = state !== 'running'; $('stop').disabled = false;
  $('back').hidden = state === 'running'; $('again').hidden = state === 'running';
}

// the stage: the live browser during a run, or the video of a finished run opened from History
function stageMode(mode, run) {
  const past = mode === 'past';
  $('stage').classList.toggle('past', past);
  $('stageVideo').pause(); $('stageVideo').hidden = !(past && run.video); $('stageDone').hidden = !(past && !run.video);
  if (past && run.video) $('stageVideo').src = `/recordings/${run.video}`;
  if (!past) $('stageVideo').removeAttribute('src');
  $('addr').textContent = past ? run.url ?? '' : 'about:blank';
}

function start(kind, params) {
  if (document.body.classList.contains('running')) { show('run'); toast('A run is going: wait for it, or stop it first'); return; }
  current = { kind, params, doneMsg: null };
  stageMode('live');
  started = Date.now();
  document.body.classList.add('running');
  $('toProjects').disabled = $('projSwitch').disabled = true; // the run belongs to this project
  setRunButtons('running');
  $('rec').hidden = params.record !== '1';
  setStatus('Running 0:00', 'run');
  timer = setInterval(() => setStatus(`Running ${clock()}`, 'run'), 1000);

  $('stage').classList.remove('has-frame'); $('addr').textContent = 'about:blank'; // this run's own browser comes next
  es = new EventSource(`/${{ ai: 'run', replay: 'replay', fix: 'fix', workflow: 'workflow-run' }[kind]}?` + new URLSearchParams({ ...params, project: project.id }));
  current.issues = []; renderIssues([]);
  let lastNote;
  es.addEventListener('queued', e => { current.queued = true; clearInterval(timer); setStatus(`Waiting for a free run slot (#${JSON.parse(e.data).position} in line)`, 'run'); });
  es.addEventListener('run', e => {
    current.id = JSON.parse(e.data).id;
    startLive(current.id);
    if (current.queued) { current.queued = false; started = Date.now(); timer = setInterval(() => setStatus(`Running ${clock()}`, 'run'), 1000); }
  });
  es.addEventListener('text', e => { const t = JSON.parse(e.data); lastNote = { el: addNote(t), text: t }; lastNote.el.scrollIntoView({ block: 'nearest' }); });
  es.addEventListener('tool', e => { const { li, what, detail } = addStep(JSON.parse(e.data)); caption(what, detail); li.scrollIntoView({ block: 'nearest' }); });
  es.addEventListener('log', e => { $('log').textContent += JSON.parse(e.data) + '\n'; $('log').scrollTop = $('log').scrollHeight; });
  es.addEventListener('issue', e => { current.issues.push(JSON.parse(e.data)); renderIssues(current.issues); });
  // workflows: a heading when a block starts, its result when it ends
  es.addEventListener('block', e => {
    const b = JSON.parse(e.data);
    if (b.status === 'running') { addPlainStep({ section: blockTitle(b) }).scrollIntoView({ block: 'nearest' }); caption(blockTitle(b), BLOCKS[b.type]?.name ?? ''); }
    else addBlockResult(b).scrollIntoView({ block: 'nearest' });
  });
  es.addEventListener('step', e => { const s = JSON.parse(e.data); if (current.kind === 'fix' && !current.verifyHeading) { current.verifyHeading = true; addPlainStep({ section: 'Verifying the corrected test (no AI)' }); } const li = addPlainStep(s); if (!s.section) caption(s.what, s.detail); li.scrollIntoView({ block: 'nearest' }); });
  es.addEventListener('fail', e => { const msg = JSON.parse(e.data); addNote(msg, 'error'); if (!msg.startsWith('Recording failed')) current.doneMsg = 'Error'; });
  es.addEventListener('stopped', () => { current.doneMsg = 'Stopped'; });
  es.addEventListener('done', e => {
    const d = JSON.parse(e.data);
    if (lastNote && lastNote.text === d.text) lastNote.el.remove(); // the final answer is shown in the result card
    current.doneMsg = d.ok ? 'Passed' : 'Failed';
    setStatus('Saving results', 'run');
  });
  es.addEventListener('saved', async e => {
    const { id } = JSON.parse(e.data);
    finish();
    const run = await api(`/history/${id}`);
    renderResult(run, { live: true });
  });
  es.onerror = () => { if (document.body.classList.contains('running')) { finish(); setStatus(current.doneMsg ?? 'Connection lost', 'fail'); } };
}

function finish() {
  es?.close(); clearInterval(timer);
  document.body.classList.remove('running');
  $('toProjects').disabled = $('projSwitch').disabled = false;
  $('liveChip').hidden = true;
  $('rec').hidden = true; $('caption').hidden = true;
  setRunButtons('done');
}

// Stop asks the server, so the stream stays open and the partial recording + history entry still arrive
$('stop').onclick = () => {
  if (current?.queued) { finish(); setStatus('Removed from the queue'); return; } // not ours to stop: someone else's run is going
  $('stop').disabled = true; setStatus('Stopping…', 'run');
  fetch(`/stop?${new URLSearchParams({ run: current.id })}`, { method: 'POST' }).catch(() => finish());
};
$('back').onclick = () => show(origin);
$('again').onclick = () => { if (current) start(current.kind, current.params); };

/* ---------- result card (live run or history item) ---------- */
function inlineForm(label, placeholder, value, onSubmit) {
  const f = document.createElement('form');
  f.className = 'inline-form';
  f.innerHTML = `<input class="field" required placeholder="${esc(placeholder)}" aria-label="${esc(label)}" value="${esc(value)}"><button class="btn small">${esc(label)}</button><span class="msg" role="status"></span>`;
  f.onsubmit = async e => {
    e.preventDefault();
    const msg = f.querySelector('.msg'); msg.className = 'msg'; msg.textContent = '';
    try { msg.textContent = await onSubmit(f.querySelector('input').value.trim()); msg.classList.add('ok'); }
    catch (err) { msg.textContent = err.message; msg.classList.add('err'); }
  };
  return f;
}
const slugify = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

function renderResult(run, { live = false } = {}) {
  const r = $('result');
  const status = run.status ?? 'error';
  setStatus(STATUS[status] ?? status, status === 'pass' ? 'pass' : status === 'stopped' ? '' : 'fail');
  const total = run.tests?.length ?? 0, passed = run.tests?.filter(t => t.status === 'passed').length ?? 0;
  const blocksDone = run.blocks ?? [], blocksOk = blocksDone.filter(b => b.status === 'pass').length;
  const sub = run.kind === 'workflow' ? `${blocksOk} of ${blocksDone.length} blocks passed in ${run.secs} s`
    : run.kind === 'ai' ? `${run.steps?.length ?? 0} steps in ${run.secs} s`
    : run.kind === 'fix' ? `${run.steps?.length ?? 0} AI steps${total ? `, then ${passed} of ${total} passed without AI` : ''}, ${run.secs} s`
    : `${passed} of ${total} tests passed in ${run.secs} s`;
  const title = run.kind === 'fix'
    ? { pass: '✓ Fixed and verified', fail: run.script ? '✗ The corrected test still fails' : '✗ Could not fix this test', stopped: 'Stopped', error: 'The fix could not complete', blocked: '⛔ Blocked: production address' }[status]
    : { pass: '✓ Passed', fail: '✗ Failed', stopped: 'Stopped', error: 'The run could not complete', blocked: '⛔ Blocked: production address' }[status];
  r.className = 'result ' + status;
  r.innerHTML = `<h2>${esc(title)} <small>${esc(sub)}</small></h2>`;
  if (run.error) r.insertAdjacentHTML('beforeend', `<p class="evidence">${esc(run.error)}</p>`);
  if (run.flaky?.length) r.insertAdjacentHTML('beforeend', `<div class="flakybox"><b>⚠ Flaky: passes sometimes, fails sometimes.</b> Usually timing (slow loading, animations), not a real break. Fix the wait before using Fix with AI.<ul>${run.flaky.map(f => `<li>${esc(f.title)}${f.row ? ` (row ${f.row})` : ''}: passed ${f.passed} of ${f.total}</li>`).join('')}</ul></div>`);
  if (run.expected) r.insertAdjacentHTML('beforeend', `<div class="expectbox ${run.expectedMet === true ? 'met' : 'unmet'}"><b>${run.expectedMet === true ? '✓ Expected result met' : run.expectedMet === false ? '✗ Expected result not met' : '? The AI did not confirm the expected result'}</b><span>${esc(run.expected)}</span></div>`);
  if (run.evidence) r.insertAdjacentHTML('beforeend', `<div class="evidence">${md(run.evidence)}</div>`);
  if (run.kind === 'workflow' && blocksDone.length) r.insertAdjacentHTML('beforeend', `<ol class="wf-result">${blocksDone.map(b => `<li class="${esc(b.status)}">
      <div class="wf-r-head"><b>${b.status === 'pass' ? '✓' : '✗'} ${esc(blockTitle(b))}</b><span class="muted">${esc(BLOCKS[b.type]?.name ?? b.type)}, ${b.secs ?? 0} s</span></div>
      ${b.evidence ? `<div class="muted">${esc(b.evidence)}</div>` : ''}
      ${b.output !== undefined ? `<pre class="code">${esc(JSON.stringify(b.output, null, 2))}</pre>` : ''}
      ${b.screenshot ? `<a href="/visual/${esc(run.id)}/${esc(b.screenshot)}" target="_blank" rel="noopener"><img class="wf-shot" src="/visual/${esc(run.id)}/${esc(b.screenshot)}" alt="The page after ${esc(b.label)}" loading="lazy" onerror="this.parentElement.remove()"></a>` : ''}
    </li>`).join('')}</ol>`);
  if (run.kind === 'workflow' && run.outputs && Object.keys(run.outputs).length) {
    const det = document.createElement('details');
    det.innerHTML = `<summary class="link">All data from this run (JSON)</summary><pre class="code"></pre>`;
    det.querySelector('pre').textContent = JSON.stringify(run.outputs, null, 2);
    r.append(det);
  }
  if (total) r.insertAdjacentHTML('beforeend', `<table class="tests"><tbody>${run.tests.map(t => `<tr><td><b style="color:var(--${t.status === 'passed' ? 'pass' : t.status === 'skipped' ? 'muted' : 'fail'})">${t.status === 'passed' ? '✓' : t.status === 'skipped' ? '–' : '✗'}</b> ${esc(t.title)}${t.row ? ` <span class="tag">row ${t.row}</span>` : ''}${t.attempt ? ` <span class="tag">run ${t.attempt}</span>` : ''}<br><span class="muted">${esc(t.file)}</span>${t.error ? `<details><summary>Show error</summary><pre class="code">${esc(t.error)}</pre></details>` : ''}${t.visual?.length ? `<div class="visual">${t.visual.map(v => `<figure><a href="/visual/${esc(run.id)}/${esc(v.file)}" target="_blank" rel="noopener"><img src="/visual/${esc(run.id)}/${esc(v.file)}" alt="${esc(v.kind)} screenshot"></a><figcaption>${{ expected: 'Expected (baseline)', actual: 'Actual (now)', diff: 'Difference' }[v.kind]}</figcaption></figure>`).join('')}</div>` : ''}${t.status !== 'passed' && run.kind === 'replay' ? `<div class="actions" style="margin-top:6px">${t.visual?.length ? `<button type="button" class="btn ghost small" data-accept="${esc(t.file.replace(/\.spec\.ts$/, ''))}">Accept as new baseline</button>` : ''}<button type="button" class="btn small" data-fix="${esc(t.file.replace(/\.spec\.ts$/, ''))}">Fix with AI</button></div>` : ''}</td><td>${(t.ms / 1000).toFixed(1)} s</td></tr>`).join('')}</tbody></table>`);
  if (run.video && live) r.insertAdjacentHTML('beforeend', `<video src="/recordings/${esc(run.video)}" controls preload="metadata"></video>`); // from History it plays on the stage
  for (const b of r.querySelectorAll('[data-fix]')) b.onclick = () => fixTest(run.id, b.dataset.fix);
  // the screen changed on purpose (new design): make the current screen the new reference
  for (const b of r.querySelectorAll('[data-accept]')) b.onclick = () => {
    if (!confirm(`Use the current screens of "${b.dataset.accept}" as the new visual baseline?`)) return;
    origin = 'tests';
    openRunPage({ kind: 'replay', task: `Update visual baseline: ${b.dataset.accept}`, who: 'Playwright, no AI' });
    start('replay', { tests: b.dataset.accept, update: '1', env: run.env ?? '', session: run.session ?? '' });
  };
  if (run.kind === 'fix' && run.script) {
    const d = lineDiff(run.original ?? '', run.script);
    const det = document.createElement('details');
    det.innerHTML = `<summary class="link">Show changes (+${d.added} / −${d.removed} lines)</summary><pre class="diff">${d.html}</pre>`;
    r.append(det);
  }

  // what to do with the run's outputs: one row per kind (label, then its buttons in equal columns)
  const actions = document.createElement('div');
  actions.className = 'result-actions';
  const row = (label, ...els) => {
    els = els.filter(Boolean);
    if (!els.length) return;
    const l = document.createElement('span'); l.className = 'ra-label'; l.textContent = label;
    if (els.length === 1) els[0].classList.add('span2');
    actions.append(l, ...els);
  };
  const link = (href, text, cls, attrs = {}) => { const a = Object.assign(document.createElement('a'), { href, textContent: text, className: `btn small ${cls}` }); for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v); return a; };
  const button = (text, cls, onclick) => Object.assign(document.createElement('button'), { type: 'button', textContent: text, className: `btn small ${cls}`, onclick });
  row('PDF guide',
    run.guide && link(`/guides/${encodeURIComponent(run.guide)}`, 'Open PDF', '', { target: '_blank', rel: 'noopener' }),
    run.guide && run.guideDoc && button('Edit', 'ghost', () => openGuideEditor(run.guide)));
  row('Download',
    link(`/report/${encodeURIComponent(run.id)}`, 'HTML report', 'ghost', { title: 'Download the HTML report' }),
    run.video && link(`/recordings/${encodeURIComponent(run.video)}`, 'Video', 'ghost', { download: '', title: 'Download the video' }));
  r.append(actions);

  if (run.kind === 'fix' && run.script) {
    const name = run.testNames[0];
    const save = document.createElement('button'); save.type = 'button'; save.className = run.status === 'pass' ? 'btn small' : 'btn ghost small';
    save.textContent = run.status === 'pass' ? `Save fix to tests/${run.project}/${name}.spec.ts` : 'Save anyway (not verified)';
    save.onclick = async () => {
      if (run.status !== 'pass' && !confirm('The corrected test did not pass its check. Save it anyway?')) return;
      await api(`/tests?project=${encodeURIComponent(run.project)}`, { method: 'POST', body: JSON.stringify({ name, runId: run.id, overwrite: true }) });
      save.textContent = `Saved to tests/${run.project}/${name}.spec.ts`; save.disabled = true;
    };
    save.classList.add('span-all');
    actions.prepend(save);
  }
  if (run.script && run.kind !== 'fix') {
    const copy = button('Copy', 'ghost', () => navigator.clipboard.writeText(run.script).then(() => { copy.textContent = 'Copied'; }));
    const pre = document.createElement('pre'); pre.className = 'code'; pre.hidden = true; pre.textContent = run.script;
    const view = button('Show', 'ghost', () => { pre.hidden = !pre.hidden; view.textContent = pre.hidden ? 'Show' : 'Hide'; });
    copy.title = 'Copy the Playwright script'; view.title = 'Show the Playwright script';
    row('Script', copy, view);
    r.append(pre);
    r.append(inlineForm('Save as test', 'test-name, e.g. login-and-checkout', slugify(run.title || (run.task ?? '').split('\n')[0]).slice(0, 40), async name => {
      const { name: saved } = await api(withProject('/tests'), { method: 'POST', body: JSON.stringify({ name, runId: run.id }) });
      return `Saved as tests/${project.id}/${saved}.spec.ts. Replay it from the Saved tests tab.`;
    }));
  }
  // the AI's browser stays open after a live run, so its login can be captured now
  if (live && run.kind === 'ai' && run.status !== 'error') {
    r.append(inlineForm('Save login session', 'session name, e.g. admin-login', slugify(new URL(run.url).hostname.replace(/^www\./, '').split('.')[0]), async name => {
      const s = await api('/sessions', { method: 'POST', body: JSON.stringify({ project: project.id, name, run: run.id }) });
      await refreshProject();
      return `Session "${s.name}" saved (${s.cookies} cookies). Pick it under "Start with a login session".`;
    }));
  }
  renderIssues(run.issues ?? []);
  r.hidden = false;
  r.scrollIntoView({ block: 'nearest' });
}

// Console errors and failed requests seen during the run; third-party ones (analytics, fonts) folded away
function renderIssues(issues) {
  const box = $('issuesBox');
  const own = issues.filter(isAppError), other = issues.filter(isThirdParty), a11y = issues.filter(isA11y);
  const item = i => `<li><b>${esc(issueLabel(i))}${i.count > 1 ? ` ×${i.count}` : ''}</b>${esc(issueDetail(i))} <small>at ${i.at ?? 0} s</small></li>`;
  box.hidden = !issues.length;
  box.className = 'issuesbox' + (own.length ? '' : ' clean');
  box.innerHTML = `<h3>${own.length ? `⚠ ${own.length} error${own.length > 1 ? 's' : ''} from the application` : 'No errors from the application'}</h3>
    ${own.length ? `<ul>${own.map(item).join('')}</ul>` : ''}
    ${other.length ? `<details><summary>${other.length} from third-party sites</summary><ul>${other.map(item).join('')}</ul></details>` : ''}
    ${a11y.length ? `<details><summary>♿ ${a11y.length} accessibility problem${a11y.length > 1 ? 's' : ''} (WCAG A/AA)</summary><ul>${a11y.map(item).join('')}</ul></details>` : ''}`;
}

function fixTest(runId, name) {
  const params = { run: runId, test: name, provider: $('provider').value, model: $('model').value.trim(), env: $('replayEnv').value };
  origin = 'tests';
  openRunPage({ kind: 'fix', task: `Fix test: ${name}`, who: `${$('provider').selectedOptions[0]?.textContent ?? ''}${params.model ? ` (${params.model})` : ''}, then verified without AI` });
  start('fix', params);
}

/* ---------- AI form ---------- */
$('f').onsubmit = e => {
  e.preventDefault();
  const params = { url: $('url').value, title: $('taskTitle').value.trim(), task: $('task').value, provider: $('provider').value, model: $('model').value.trim(), session: $('aiSession').value, record: $('record').checked ? '1' : '', guide: $('guide').checked ? '1' : '', flow: attachedFlow ?? '', env: $('aiEnv').value, expected: $('expected').value.trim() };
  store.set({ provider: params.provider, model: params.model, record: $('record').checked, guide: $('guide').checked, aiSession: params.session });
  storeProject({ url: params.url, title: params.title, task: params.task, expected: params.expected, aiEnv: params.env });
  origin = 'ai';
  openRunPage({ kind: 'ai', task: params.task, who: `${$('provider').selectedOptions[0]?.textContent ?? ''}${params.model ? ` (${params.model})` : ''}${params.session ? `, session ${params.session}` : ''}` });
  start('ai', params);
};
$('task').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('f').requestSubmit(); });

/* ---------- saved tests ---------- */
let lastByTest = {};
async function loadTests() {
  const [tests, history] = await Promise.all([api(withProject('/tests')), api(withProject('/history'))]);
  lastByTest = {};
  for (const run of [...history].reverse()) for (const n of run.testNames ?? []) lastByTest[n] = run;
  if (!tests.length) {
    $('testList').innerHTML = `<div class="emptybox"><strong>No saved tests yet</strong>Run the AI, then click "Save as test" on the result.</div>`;
  } else {
    // recent runs per test, oldest left: the same strip as on the project cards
    const recent = {};
    for (const run of history) for (const n of run.testNames ?? []) (recent[n] ??= []).length < 10 && recent[n].push(run.status);
    $('testList').innerHTML = `<div class="list">${tests.map(t => {
      const last = lastByTest[t.name];
      return `<div class="item row-item" data-name="${esc(t.name)}">
        <input type="checkbox" aria-label="Select ${esc(t.name)}">
        <div><div class="title">${esc(t.name)}</div>
          <div class="sub">${esc(t.titles.join(', ') || 'untitled')}</div>
          <div class="meta">Changed ${esc(ago(t.modified))}${last ? `, last run ${esc(ago(last.started))}` : ''}${t.dataRows ? `, data set of ${t.dataRows} row${t.dataRows > 1 ? 's' : ''}` : ''}</div>
        </div>
        <span class="strip" aria-label="Last ${(recent[t.name] ?? []).length} runs">${[...(recent[t.name] ?? [])].reverse().map(st => `<i class="${esc(st)}" title="${esc(STATUS[st] ?? st)}"></i>`).join('')}</span>
        <div class="ractions">
          <button type="button" class="icon-btn" data-act="edit" aria-label="Edit ${esc(t.name)}" title="Edit script and data set">${icon('edit')}</button>
          <button type="button" class="icon-btn" data-act="code" aria-label="Show code of ${esc(t.name)}" title="Show code" aria-pressed="false">${icon('code')}</button>
          <button type="button" class="icon-btn danger" data-act="del" aria-label="Delete ${esc(t.name)}" title="Delete">${icon('trash')}</button>
          <button type="button" class="btn small" data-act="run">${icon('play')}Run</button>
        </div>
        <pre class="code" hidden></pre>
      </div>`;
    }).join('')}</div>`;
  }
  syncSelected();
}
const selectedTests = () => [...document.querySelectorAll('#testList .item')].filter(i => i.querySelector('input')?.checked).map(i => i.dataset.name);
function syncSelected() {
  const n = selectedTests().length;
  $('runSelected').disabled = !n;
  $('runSelected').querySelector('span').textContent = n > 1 ? `Run ${n} tests as a suite` : n === 1 ? 'Run 1 test' : 'Run selected tests';
}
function runTests(names) {
  const params = { tests: names.join(','), session: $('replaySession').value, record: $('replayRecord').checked ? '1' : '', guide: $('replayGuide').checked ? '1' : '', env: $('replayEnv').value, repeat: $('replayRepeat').value };
  store.set({ replayRecord: $('replayRecord').checked, replayGuide: $('replayGuide').checked, replaySession: params.session, replayRepeat: params.repeat });
  storeProject({ replayEnv: params.env });
  origin = 'tests';
  openRunPage({ kind: 'replay', task: names.length > 1 ? `Suite: ${names.join(', ')}` : `Replay: ${names[0]}`, who: `Playwright, no AI${params.session ? `, session ${params.session}` : ''}` });
  start('replay', params);
}
$('testList').onchange = syncSelected;
$('testSearch').oninput = () => {
  const q = $('testSearch').value.trim().toLowerCase();
  for (const item of document.querySelectorAll('#testList .item')) item.hidden = Boolean(q) && !item.textContent.toLowerCase().includes(q);
};
$('testList').onclick = async e => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const act = btn.dataset.act, item = btn.closest('.item'), name = item.dataset.name;
  if (act === 'run') runTests([name]);
  if (act === 'edit') editTest(name);
  if (act === 'code') {
    const pre = item.querySelector('pre');
    if (pre.hidden && !pre.textContent) pre.textContent = await api(withProject(`/tests/${name}`));
    pre.hidden = !pre.hidden; btn.setAttribute('aria-pressed', String(!pre.hidden));
  }
  if (act === 'del') { if (!confirm(`Delete test "${name}"? The file tests/${project.id}/${name}.spec.ts, its data set and visual baselines will be removed.`)) return; await api(withProject(`/tests/${name}`), { method: 'DELETE' }); loadTests(); }
};
$('runSelected').onclick = () => runTests(selectedTests());
// GitHub Actions workflow for the saved tests, plus what to set up on GitHub
$('ciExport').onclick = ciExport;
async function ciExport() {
  const r = $('ciResult');
  try {
    const x = await api('/ci/export', { method: 'POST', body: JSON.stringify({ env: $('replayEnv').value }) });
    r.className = 'result pass'; r.hidden = false;
    r.innerHTML = `<h2>✓ Wrote ${esc(x.path)}</h2>
      <p class="muted">Commit and push it. Then on GitHub, in the repository's Settings &gt; Secrets and variables &gt; Actions:</p>
      <div class="evidence"><p><b>Secrets</b> (same names, real values): ${x.secrets.map(n => `<code>${esc(n)}</code>`).join(' ') || 'none'}</p>
      <p><b>Variable</b> <code>E2E_VARS</code> = the environment values as JSON${x.env ? ` (from "${esc(x.env)}"; use your staging values)` : ''}:</p></div>
      <pre class="code"></pre>
      ${x.localAddresses.length ? `<div class="flakybox"><b>⚠ These addresses only exist on this computer:</b> ${x.localAddresses.map(esc).join(', ')}. GitHub's servers cannot reach them; put staging addresses in E2E_VARS instead.</div>` : ''}`;
    r.querySelector('pre').textContent = x.vars;
  } catch (err) { r.className = 'result fail'; r.hidden = false; r.innerHTML = `<h2>Export failed</h2><p class="evidence">${esc(err.message)}</p>`; }
  r.scrollIntoView({ block: 'nearest' });
}
$('selectAll').onclick = () => { const boxes = [...document.querySelectorAll('#testList input')]; const all = boxes.every(b => b.checked); boxes.forEach(b => { b.checked = !all; }); syncSelected(); };

/* ---------- history ---------- */
let historyRuns = [], historyFilter = 'all';
const KIND = { ai: ['sparkles', 'AI'], fix: ['edit', 'Fix'], workflow: ['workflow', 'Workflow'], replay: ['tests', 'Replay'] };
async function loadHistory() {
  historyRuns = await api(withProject('/history'));
  renderHistory();
}
function renderHistory() {
  const q = $('histSearch').value.trim().toLowerCase();
  const runs = historyRuns.filter(r => (historyFilter === 'all' || (historyFilter === 'pass' ? r.status === 'pass' : r.status !== 'pass'))
    && (!q || `${r.title ?? ''} ${r.task} ${r.provider ?? ''}`.toLowerCase().includes(q)));
  if (!historyRuns.length) { $('historyList').innerHTML = `<div class="emptybox"><strong>No history yet</strong>Every AI run, replay and workflow is recorded here, with its video and report.</div>`; return; }
  if (!runs.length) { $('historyList').innerHTML = `<div class="emptybox"><strong>No runs match</strong>Change the search or the filter.</div>`; return; }
  $('historyList').innerHTML = `<div class="list">${runs.map(r => {
    const [ic, kind] = KIND[r.kind] ?? KIND.replay;
    return `<button type="button" class="item" data-id="${esc(r.id)}">
      <span class="kind ${esc(r.status)}" title="${esc(STATUS[r.status] ?? r.status)}">${icon(ic)}</span>
      <span><span class="title" style="display:block">${esc((r.title || (r.task ?? '').split('\n')[0]).slice(0, 140))}</span>
        <span class="sub" style="display:block">${esc(kind === 'Replay' && r.testNames?.length > 1 ? 'Suite' : kind)}, ${esc(ago(r.started))}, ${r.secs ?? 0} s${r.schedule ? ', scheduled' : ''}${r.provider ? `, ${esc(r.provider)}` : ''}</span></span>
      <span class="tags"><span class="tag ${esc(r.status)}">${esc(STATUS[r.status] ?? r.status)}</span>${r.issueCount ? `<span class="tag fail">${r.issueCount} app error${r.issueCount > 1 ? 's' : ''}</span>` : ''}${r.a11yCount ? `<span class="tag">♿ ${r.a11yCount}</span>` : ''}</span>
    </button>`;
  }).join('')}</div>`;
}
$('histSearch').oninput = renderHistory;
for (const b of document.querySelectorAll('[data-filter]')) b.onclick = () => {
  historyFilter = b.dataset.filter;
  for (const x of document.querySelectorAll('[data-filter]')) x.setAttribute('aria-pressed', String(x === b));
  renderHistory();
};
$('historyList').onclick = async e => {
  const b = e.target.closest('button.item'); if (!b) return;
  const run = await api(`/history/${b.dataset.id}`);
  origin = 'history';
  openRunPage({ kind: run.kind, task: run.task ?? '', who: `${new Date(run.started).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}${run.provider ? `, ${run.provider}` : ''}${run.session ? `, session ${run.session}` : ''}` });
  setRunButtons('history');
  stageMode('past', run);
  current = run.kind === 'workflow'
    ? { kind: 'workflow', params: { workflow: run.workflow, params: JSON.stringify(run.params ?? {}), env: run.env ?? '', session: run.session ?? '', record: run.video ? '1' : '', guide: run.guide ? '1' : '', provider: settings.providers?.find(p => p.label === run.provider)?.id ?? '', model: run.model ?? '' } }
    : run.kind === 'fix'
    ? { kind: 'fix', params: { run: run.fixOf, test: run.testNames?.[0] ?? '', provider: settings.providers?.find(p => p.label === run.provider)?.id ?? '', model: run.model ?? '' } }
    : run.kind === 'ai'
    ? { kind: 'ai', params: { url: run.url, title: run.title ?? '', task: run.task, provider: settings.providers?.find(p => p.label === run.provider)?.id ?? '', model: run.model ?? '', session: run.session ?? '', record: run.video ? '1' : '', guide: run.guide ? '1' : '', flow: run.flow ?? '', env: run.env ?? '', expected: run.expected ?? '' } }
    : { kind: 'replay', params: { tests: (run.testNames ?? []).join(','), session: run.session ?? '', record: run.video ? '1' : '', guide: run.guide ? '1' : '', env: run.env ?? '', repeat: String(run.times ?? 1) } };
  if (run.kind === 'workflow') for (const b of run.blocks ?? []) { // each block: its heading, the AI's steps, its result
    addPlainStep({ section: blockTitle(b) });
    for (const s of (run.steps ?? []).filter(x => x.block === b.n)) addStep(s);
    addBlockResult(b);
  }
  else for (const s of run.steps ?? []) addStep(s);
  if (run.kind === 'fix' && run.replaySteps?.length) addPlainStep({ section: 'Verifying the corrected test (no AI)' });
  for (const s of run.replaySteps ?? []) addPlainStep(s);
  if (run.log?.length) $('log').textContent = run.log.join('\n');
  renderResult(run);
  $('scroll').scrollTop = 0;
};

/* ---------- workflows ---------- */
const blockTitle = b => `${b.n}. ${b.label}${b.iteration ? ` (#${b.iteration})` : ''}`;
function addBlockResult(b) {
  const li = document.createElement('li');
  li.className = `blockres ${b.status}`;
  li.innerHTML = `<b>${b.status === 'pass' ? '✓' : '✗'} ${esc(b.label)}</b> <span class="muted">${b.secs ?? 0} s</span>${b.evidence ? `<div>${esc(b.evidence)}</div>` : ''}${b.output !== undefined ? `<pre class="code">${esc(JSON.stringify(b.output, null, 2).slice(0, 2000))}</pre>` : ''}`;
  $('steps').append(li);
  return li;
}
const studio = createStudio({ $, api, esc, project: () => project, onRun: (id, wf) => runWorkflow(id, wf), onClose: () => loadWorkflows() });
let workflows = [];
async function loadWorkflows() {
  const [list, history] = await Promise.all([api(withProject('/workflows')), api(withProject('/history'))]);
  workflows = list;
  const last = id => history.find(r => r.kind === 'workflow' && r.workflow === id);
  $('wfList').innerHTML = list.length ? `<div class="list">${list.map(w => {
    const l = last(w.id);
    const recent = history.filter(r => r.kind === 'workflow' && r.workflow === w.id).slice(0, 10).map(r => r.status);
    return `<div class="item row-item" data-id="${esc(w.id)}">
      <span class="kind ${l ? esc(l.status) : ''}">${icon('workflow')}</span>
      <div><div class="title">${esc(w.name)}</div>
        ${w.description ? `<div class="sub">${esc(w.description)}</div>` : ''}
        <div class="meta">${w.blocks} block${w.blocks === 1 ? '' : 's'}${w.params?.length ? `, asks for ${w.params.map(x => esc(x.name)).join(', ')}` : ''}, changed ${esc(ago(w.modified))}</div></div>
      <span class="strip" aria-label="Last ${recent.length} runs">${[...recent].reverse().map(st => `<i class="${esc(st)}" title="${esc(STATUS[st] ?? st)}"></i>`).join('')}</span>
      <div class="ractions">
        <button type="button" class="icon-btn" data-act="open" aria-label="${'Edit'} ${esc(w.name)}" title="${'Open in Workflow Studio'}">${icon('edit')}</button>
        <button type="button" class="icon-btn danger" data-act="del" aria-label="Delete ${esc(w.name)}" title="Delete">${icon('trash')}</button>
        <button type="button" class="btn small" data-act="run">${icon('play')}Run</button>
      </div>
    </div>`;
  }).join('')}</div>` : `<div class="emptybox"><strong>No workflows yet</strong>Click "New workflow" and add blocks.</div>`;
}
$('wfNew').onclick = () => studio.open(null);
$('wfList').onclick = async e => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const act = btn.dataset.act, id = btn.closest('[data-id]').dataset.id, w = workflows.find(x => x.id === id);
  if (act === 'open') studio.open(id);
  if (act === 'run') runWorkflow(id, w);
  if (act === 'del' && confirm(`Delete the workflow "${w.name}"? The file tests/${project.id}/workflows/${id}.json will be removed.`)) { await api(withProject(`/workflows/${id}`), { method: 'DELETE' }); loadWorkflows(); }
};
// parameters are asked for first, prefilled with their defaults
function runWorkflow(id, wf) {
  const go = params => {
    const p = { workflow: id, params: JSON.stringify(params), env: $('wfEnv').value, session: $('wfSession').value, record: $('wfRecord').checked ? '1' : '', guide: $('wfGuide').checked ? '1' : '', provider: $('provider').value, model: $('model').value.trim() };
    storeProject({ wfEnv: p.env });
    store.set({ wfRecord: $('wfRecord').checked, wfGuide: $('wfGuide').checked });
    origin = 'workflows';
    openRunPage({ kind: 'workflow', task: `Workflow: ${wf.name}`, who: `${$('provider').selectedOptions[0]?.textContent ?? ''}${p.session ? `, session ${p.session}` : ''}` });
    start('workflow', p);
  };
  if (!wf.params?.length) return go({});
  $('wfRunTitle').textContent = `Run ${wf.name}`;
  $('wfRunParams').innerHTML = wf.params.map(x => `<label>${esc(x.name)} <input class="field" name="${esc(x.name)}" value="${esc(x.default ?? '')}"></label>`).join('');
  $('wfRunForm').onsubmit = e => { e.preventDefault(); $('wfRunDlg').close(); go(Object.fromEntries([...$('wfRunParams').querySelectorAll('input')].map(i => [i.name, i.value]))); };
  $('wfRunDlg').showModal();
}
$('wfRunCancel').onclick = $('wfRunClose').onclick = () => $('wfRunDlg').close();

/* ---------- record flow (Playwright codegen on the desktop) ---------- */
let attachedFlow = null;
function attachFlow(id) {
  attachedFlow = id;
  $('flowChip').hidden = !id; $('flowName').textContent = id ?? '';
}
$('flowRemove').onclick = () => attachFlow(null);
let recEs;
$('recForm').onsubmit = e => {
  e.preventDefault();
  const url = $('recUrl').value, session = $('recSession').value, env = $('recEnv').value;
  store.set({ recSession: session });
  storeProject({ recUrl: url, recEnv: env });
  $('recResult').hidden = true;
  $('recStart').disabled = true; $('recStop').hidden = false;
  $('recState').textContent = 'Opening the browser…';
  recEs = new EventSource('/record?' + new URLSearchParams({ project: project.id, url, session, env }));
  const end = () => { recEs.close(); $('recStart').disabled = false; $('recStop').hidden = true; };
  recEs.addEventListener('started', () => { $('recState').textContent = 'Recording. Click through the flow in the new browser window, then close that window.'; setStatus('Recording', 'run'); });
  recEs.addEventListener('fail', ev => { end(); $('recState').textContent = ''; setStatus('Ready'); showRecResult(null, JSON.parse(ev.data)); });
  recEs.addEventListener('done', ev => { end(); $('recState').textContent = ''; setStatus('Flow recorded', 'pass'); showRecResult(JSON.parse(ev.data)); });
  recEs.onerror = () => { if (!$('recStop').hidden) { end(); $('recState').textContent = 'Connection lost'; setStatus('Ready'); } };
};
$('recStop').onclick = () => { $('recState').textContent = 'Stopping…'; fetch('/record/stop', { method: 'POST' }); };

function showRecResult(flow, error) {
  const r = $('recResult');
  r.hidden = false;
  if (!flow) { r.className = 'result fail'; r.innerHTML = `<h2>Nothing recorded</h2><p class="evidence">${esc(error)}</p>`; return; }
  const steps = (flow.script.match(/await page\./g) ?? []).length;
  r.className = 'result pass';
  r.innerHTML = `<h2>✓ Flow recorded <small>${steps} actions</small></h2>
    <p class="muted">Passwords stored under Settings → Secrets are replaced by <code>{{NAME}}</code>.</p>
    <pre class="code"></pre>
    <div class="actions">
      <button type="button" class="btn small" data-act="ai">Use with AI</button>
      <button type="button" class="btn ghost small" data-act="copy">Copy script</button>
    </div>`;
  r.querySelector('pre').textContent = flow.script;
  r.querySelector('[data-act=copy]').onclick = ev => navigator.clipboard.writeText(flow.script).then(() => { ev.target.textContent = 'Script copied'; });
  r.querySelector('[data-act=ai]').onclick = () => {
    attachFlow(flow.id);
    $('url').value = $('recUrl').value;
    if (!$('task').value.trim()) $('task').value = 'Follow the recorded flow and check that it completes successfully.';
    show('ai'); $('task').focus();
  };
  r.append(inlineForm('Save as test', 'test-name, e.g. checkout-flow', '', async name => {
    const { name: savedName } = await api(withProject('/tests'), { method: 'POST', body: JSON.stringify({ name, code: flow.script }) });
    return `Saved as tests/${project.id}/${savedName}.spec.ts. Replay it from the Saved tests tab.`;
  }));
  if (flow.hasSession) r.append(inlineForm('Save login session', 'session name, e.g. admin-login', slugify(new URL($('recUrl').value).hostname.replace(/^www\./, '').split('.')[0]), async name => {
    const s = await api('/sessions', { method: 'POST', body: JSON.stringify({ project: project.id, name, flowId: flow.id }) });
    await refreshProject();
    return `Session "${s.name}" saved (${s.cookies} cookies).`;
  }));
}

/* ---------- edit a saved test: script + data set ---------- */
let editing = null;
async function editTest(name) {
  editing = name;
  const [code, csv] = await Promise.all([api(withProject(`/tests/${name}`)), api(withProject(`/tests/${name}/data`))]);
  $('editTitle').textContent = `Edit tests/${project.id}/${name}.spec.ts`;
  $('editCode').value = code; $('editCsv').value = csv; $('editErr').textContent = '';
  $('editDlg').showModal();
}
$('editCancel').onclick = $('editClose').onclick = () => $('editDlg').close();
$('editForm').onsubmit = async e => {
  e.preventDefault();
  try {
    await api(withProject(`/tests/${editing}`), { method: 'PUT', body: JSON.stringify({ code: $('editCode').value, csv: $('editCsv').value }) });
    $('editDlg').close(); setStatus('Test saved'); loadTests();
  } catch (err) { $('editErr').textContent = err.message; }
};
$('aiEnv').onchange = () => loadSettings();
// visual check at the cursor: compare the whole page with its baseline (first run records the baseline)
$('insertVisual').onclick = () => {
  const ta = $('editCode'), line = "  await expect(page).toHaveScreenshot({ fullPage: true, maxDiffPixelRatio: 0.01 });\n";
  ta.setRangeText(line, ta.selectionStart, ta.selectionStart, 'end'); ta.focus();
};

/* ---------- settings dialog ---------- */
const PRESETS = [['1280x720', 'HD'], ['1280x800', 'Standard'], ['1366x768', 'Laptop'], ['1440x900', 'Large laptop'], ['1920x1080', 'Full HD'], ['2560x1440', '2K'], ['390x844', 'Phone']];
$('presets').innerHTML = PRESETS.map(([v, n]) => `<button type="button" class="preset" data-v="${v}" aria-pressed="false"><b>${n}</b>${v.replace('x', ' × ')}</button>`).join('');
const syncPreset = () => { const v = `${$('recW').value}x${$('recH').value}`; for (const b of $('presets').children) b.setAttribute('aria-pressed', String(b.dataset.v === v)); };
$('presets').onclick = e => { const b = e.target.closest('.preset'); if (!b) return; [$('recW').value, $('recH').value] = b.dataset.v.split('x'); syncPreset(); };
$('recW').oninput = $('recH').oninput = syncPreset;
// a device profile decides the size itself
function syncDevice() {
  const on = Boolean($('recDevice').value);
  for (const id of ['recW', 'recH']) $(id).disabled = on;
  for (const b of $('presets').children) b.disabled = on;
}
$('recDevice').onchange = syncDevice;

function selectTab(btn) { for (const t of document.querySelectorAll('#sf .tab')) { t.setAttribute('aria-selected', String(t === btn)); $(t.getAttribute('aria-controls')).hidden = t !== btn; } }
for (const t of document.querySelectorAll('#sf .tab')) t.onclick = () => selectTab(t);

// One collapsible row per provider; API keys are write-only (server never returns them)
function providerRow(p = { engine: 'openai-compatible' }, open = false) {
  const d = document.createElement('details');
  d.className = 'prov'; d.open = open;
  d.dataset.id = p.id || ''; d.dataset.apiKeyEnv = p.apiKeyEnv || '';
  const cc = p.engine === 'claude-code';
  const needsKey = !cc && p.apiKeyEnv && !p.ready;
  const status = cc ? (p.account ? ['ok', 'Signed in'] : ['need', 'Not signed in']) : needsKey ? ['need', 'Needs API key'] : ['ok', 'Ready'];
  const keyHint = p.apiKeyEnv ? (p.ready ? 'Saved. Fill in only to replace it.' : 'Not set yet') : 'Leave empty if not needed (e.g. Ollama)';
  d.innerHTML = `
    <summary><span class="name"></span><span class="badge ${status[0]}">${status[1]}</span></summary>
    <div class="prov-body">
      <div class="grid2">
        <label>Name <input class="field" name="label" required></label>
        <label>Connection <select class="field" name="engine"></select></label>
      </div>
      <label class="configdir">Config folder <span class="hint">Optional: which Claude account to use, e.g. ~/.claude-2. Empty = your default login.</span><input class="field" name="configDir" placeholder="~/.claude-2" spellcheck="false"></label>
      <p class="account"></p>
      <label class="baseurl">Base URL <span class="hint">OpenAI-compatible endpoint, e.g. https://api.openai.com/v1</span><input class="field" name="baseURL" type="url"></label>
      <div class="grid2">
        <label>Model default <input class="field" name="model" placeholder="Leave empty for the default"></label>
        <label class="apikey">API key <input class="field" name="apiKey" type="password" autocomplete="off"></label>
      </div>
      <button type="button" class="link danger del"><svg class="i" aria-hidden="true"><use href="#i-trash"/></svg>Delete this provider</button>
    </div>`;
  const q = n => d.querySelector(`[name=${n}]`);
  for (const e of settings.engines) q('engine').add(new Option(e === 'claude-code' ? 'Claude Code on this computer (subscription login)' : 'API (OpenAI-compatible)', e));
  q('label').value = p.label || ''; q('engine').value = p.engine; q('baseURL').value = p.baseURL || ''; q('model').value = p.model || '';
  q('apiKey').placeholder = keyHint; q('configDir').value = p.configDir || '';
  // whose subscription a Claude Code run uses; known only once saved (the server reads the folder)
  d.querySelector('.account').innerHTML = p.account ? `Signed in as <b>${esc(p.account.email)}</b>${p.account.org ? ` (${esc(p.account.org)})` : ''}`
    : p.id ? `Not signed in with this folder. In a terminal run <code>${p.configDir ? `CLAUDE_CONFIG_DIR=${esc(p.configDir)} ` : ''}claude</code> and log in, then reload Settings.` : '';
  d.querySelector('.name').textContent = p.label || 'New provider';
  q('label').oninput = () => { d.querySelector('.name').textContent = q('label').value || 'New provider'; };
  const sync = () => {
    const a = q('engine').value === 'openai-compatible';
    d.querySelector('.baseurl').hidden = !a; d.querySelector('.apikey').hidden = !a; q('baseURL').required = a;
    d.querySelector('.configdir').hidden = d.querySelector('.account').hidden = a;
  };
  q('engine').onchange = sync; sync();
  d.querySelector('.del').onclick = () => d.remove();
  return d;
}
// Secrets: names are shown, values are write-only; each is usable only in the ticked projects
function secretRow(name = '', scope = []) {
  const row = document.createElement('div');
  row.className = 'secret'; row.dataset.existing = name ? '1' : '';
  row.innerHTML = `<input class="field ph" name="sname" required placeholder="SECRET_NAME" pattern="[A-Za-z][A-Za-z0-9_]*" aria-label="Secret name">
    <input class="field val" name="svalue" type="password" autocomplete="off" aria-label="Secret value" placeholder="${name ? 'Saved. Type to replace it.' : 'Value'}" ${name ? '' : 'required'}>
    <button type="button" class="icon-btn danger" aria-label="Delete secret" title="Delete"><svg class="i" aria-hidden="true"><use href="#i-trash"/></svg></button>
    <div class="chips sproj" role="group" aria-label="Projects that may use it"><span class="chips-label">Used by</span>${projects.map(pr => `<label class="chip"><input type="checkbox" name="sproj" value="${esc(pr.id)}"${scope.includes(pr.id) ? ' checked' : ''}><span>${esc(pr.name)}</span></label>`).join('') || '<span class="hint">No projects yet</span>'}</div>
    <p class="hint warn unused"${scope.length ? ' hidden' : ''}>No project picked: no run can use it yet.</p>`;
  row.querySelector('.sproj').onchange = () => { row.querySelector('.unused').hidden = Boolean(row.querySelector('[name=sproj]:checked')); };
  const n = row.querySelector('[name=sname]');
  n.value = name; n.readOnly = Boolean(name);
  n.oninput = () => { n.value = n.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'); };
  row.querySelector('button').onclick = () => row.remove();
  return row;
}
async function renderSettings() {
  await loadSettings();
  $('serr').textContent = '';
  $('plist').replaceChildren(...settings.providers.map(p => providerRow(p)));
  projects = await api('/projects');
  $('secretList').replaceChildren(...settings.secrets.map(n => secretRow(n, settings.secretProjects?.[n] ?? [])));
  $('envList').replaceChildren(...settings.environments.map(e => envRow(e, e.name === settings.activeEnv)));
  $('schedList').replaceChildren(...settings.schedules.map(sc => schedRow(sc)));
  $('tgChat').value = settings.notify?.telegramChatId ?? ''; $('notifyMsg').textContent = '';
  $('guideLang').value = settings.guide.lang; $('guideCompany').value = settings.guide.company; $('guideAccent').value = settings.guide.accent;
  showLogo(settings.hasLogo);
  $('recW').value = settings.recording.width; $('recH').value = settings.recording.height; $('recFps').value = settings.recording.fps; for (const d of settings.devices ?? []) if (![...$('recDevice').options].some(o => o.value === d)) $('recDevice').add(new Option(d, d));
  $('recDevice').value = settings.recording.device ?? ''; syncDevice();
  $('recHighlight').checked = settings.recording.highlight !== false; $('recA11y').checked = Boolean(settings.recording.a11y); $('recKeep').value = settings.recording.keep ?? 50;
  syncPreset(); syncEmpty(); $('guideAccentHex').textContent = $('guideAccent').value;
  baseline = Object.fromEntries(panels().map(pn => [pn.id, panelState(pn)])); refreshDirty();
}
const openSettings = async () => { await renderSettings(); selectTab($('tabAiBtn')); show('settings'); };
for (const b of document.querySelectorAll('.openSettings')) b.onclick = openSettings;

/* unsaved changes: each section compares its fields (and rows) with how it was loaded */
let baseline = {};
const panels = () => [...document.querySelectorAll('#sf .tabpanel')];
const panelState = pn => JSON.stringify([...pn.querySelectorAll('input:not([type=file]), select, textarea')].map(f => [f.name || f.id, f.type === 'checkbox' || f.type === 'radio' ? f.checked : f.value]));
function settingsDirty() {
  return panels().filter(pn => baseline[pn.id] !== undefined && panelState(pn) !== baseline[pn.id]).map(pn => $(pn.getAttribute('aria-labelledby')).textContent.trim());
}
function refreshDirty() {
  const dirty = new Set(settingsDirty());
  for (const t of document.querySelectorAll('#sf .tab')) {
    const on = dirty.has(t.textContent.trim()), dot = t.querySelector('.dirty-dot');
    if (on && !dot) t.insertAdjacentHTML('beforeend', '<span class="dirty-dot" aria-label="unsaved changes"></span>');
    if (!on) dot?.remove();
  }
  $('saveBar').hidden = !dirty.size;
  $('dirtyList').textContent = dirty.size ? `in ${[...dirty].join(', ')}` : '';
  if (!dirty.size) $('serr').textContent = '';
}
const syncEmpty = () => { $('secretEmpty').hidden = $('secretList').children.length > 0; $('schedEmpty').hidden = $('schedList').children.length > 0; };
// rows are added and removed by clicks: check after the click has done its work
for (const ev of ['input', 'change']) $('sf').addEventListener(ev, () => refreshDirty());
$('sf').addEventListener('click', () => setTimeout(() => { syncEmpty(); refreshDirty(); }));
$('guideAccent').addEventListener('input', () => { $('guideAccentHex').textContent = $('guideAccent').value; });
$('discardP').onclick = () => renderSettings();
addEventListener('beforeunload', e => { if (!$('view-settings').hidden && settingsDirty().length) e.preventDefault(); });

$('addP').onclick = () => { const d = providerRow(undefined, true); $('plist').append(d); d.querySelector('input').focus(); };
$('addSecret').onclick = () => { const r = secretRow(); $('secretList').append(r); r.querySelector('input').focus(); };
// Environments: name + name=value lines; one can be the default
function envRow(env = { name: '', vars: {} }, isDefault = false) {
  const row = document.createElement('div');
  row.className = 'env-row';
  row.innerHTML = `<div class="env-head">
      <input class="field env-name" name="ename" required placeholder="Name: local, staging, ..." aria-label="Environment name">
      <label class="chip"><input type="radio" name="envDefault"><span>Default</span></label>
      <label class="chip prod" title="Its addresses are blocked in every test browser"><input type="checkbox" name="eprod"><span>Production</span></label>
      <button type="button" class="icon-btn danger" aria-label="Delete environment" title="Delete"><svg class="i" aria-hidden="true"><use href="#i-trash"/></svg></button>
    </div>
    <textarea class="field code-edit" name="evars" rows="3" aria-label="Values, one name=value per line" placeholder="appUrl=http://myapp.test&#10;adminUrl=http://admin-app.test"></textarea>`;
  row.querySelector('[name=ename]').value = env.name;
  row.querySelector('[name=evars]').value = Object.entries(env.vars).map(([k, v]) => `${k}=${v}`).join('\n');
  row.querySelector('[name=envDefault]').checked = isDefault;
  row.querySelector('[name=eprod]').checked = Boolean(env.production);
  row.querySelector('button').onclick = () => row.remove();
  return row;
}
// Scheduled suites: one collapsible row each
function schedRow(sc = { name: '', time: '07:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], project: project?.id ?? projects[0]?.id ?? '', tests: [], env: project?.env ?? '', repeat: 1, enabled: true }, open = false) {
  const d = document.createElement('details');
  d.className = 'prov'; d.open = open; d.dataset.id = sc.id ?? '';
  d.innerHTML = `
    <summary><span class="name"></span><span class="badge ${sc.enabled ? 'ok' : 'need'}">${sc.enabled ? esc(`${sc.time} ${sc.days.join(' ')}`) : 'Off'}</span></summary>
    <div class="prov-body">
      <div class="grid2">
        <label>Name <input class="field" name="sname" required placeholder="Morning regression"></label>
        <label>Time <input class="field" name="stime" type="time" required></label>
      </div>
      <div class="presets">${settings.days.map(day => `<label class="check"><input type="checkbox" name="sday" value="${day}"> ${day}</label>`).join('')}</div>
      <label>Project <select class="field" name="sproject">${projects.map(pr => `<option value="${esc(pr.id)}">${esc(pr.name)}</option>`).join('')}</select></label>
      <label>Tests <span class="hint">run together as one suite</span></label>
      <div class="presets" data-tests></div>
      <div class="grid3">
        <label>Environment <select class="field" name="senv"><option value="">None</option>${testEnvs().map(e => `<option>${esc(e.name)}</option>`).join('')}</select></label>
        <label>Login session <select class="field" name="ssession"></select></label>
        <label>Repeat <select class="field" name="srepeat"><option value="1">1×</option><option value="3">3×</option><option value="5">5×</option></select></label>
      </div>
      <div class="foot">
        <label class="check"><input type="checkbox" name="senabled"> On</label>
        <label class="check"><input type="checkbox" name="srecord"> Record video</label>
        <label class="check"><input type="checkbox" name="sguide"> PDF guide</label>
        <button type="button" class="btn ghost small" data-act="run" ${sc.id ? '' : 'disabled title="Save settings first"'}>Run now</button>
        <button type="button" class="danger" data-act="del">Delete</button>
      </div>
    </div>`;
  const q = n => d.querySelector(`[name=${n}]`);
  q('sname').value = sc.name; q('stime').value = sc.time; q('senv').value = sc.env ?? ''; q('ssession').value = sc.session ?? ''; q('srepeat').value = String(sc.repeat ?? 1);
  q('senabled').checked = sc.enabled !== false; q('srecord').checked = Boolean(sc.record); q('sguide').checked = Boolean(sc.guide);
  for (const c of d.querySelectorAll('[name=sday]')) c.checked = sc.days.includes(c.value);
  // the test choices follow the chosen project
  const renderTests = chosen => {
    const names = projects.find(pr => pr.id === q('sproject').value)?.tests ?? [];
    d.querySelector('[data-tests]').innerHTML = names.map(t => `<label class="check"><input type="checkbox" name="stest" value="${esc(t)}"${chosen.includes(t) ? ' checked' : ''}> ${esc(t)}</label>`).join('') || '<span class="muted">No saved tests in this project yet</span>';
  };
  const renderSessions = chosen => {
    const list = projects.find(pr => pr.id === q('sproject').value)?.sessions ?? [];
    q('ssession').replaceChildren(new Option('None', ''), ...list.map(x => new Option(x.name, x.name)));
    q('ssession').value = list.some(x => x.name === chosen) ? chosen : '';
  };
  q('sproject').value = sc.project ?? ''; renderTests(sc.tests); renderSessions(sc.session ?? '');
  q('sproject').onchange = () => { renderTests([]); renderSessions(''); };
  d.querySelector('.name').textContent = sc.name || 'New schedule';
  q('sname').oninput = () => { d.querySelector('.name').textContent = q('sname').value || 'New schedule'; };
  d.querySelector('[data-act=del]').onclick = () => d.remove();
  d.querySelector('[data-act=run]').onclick = async ev => {
    await api(`/schedules/${sc.id}/run`, { method: 'POST' });
    ev.target.textContent = 'Queued: see History'; ev.target.disabled = true;
  };
  return d;
}
const collectSchedules = () => [...$('schedList').children].map(d => {
  const v = n => d.querySelector(`[name=${n}]`);
  return {
    id: d.dataset.id || undefined, name: v('sname').value.trim(), time: v('stime').value,
    days: [...d.querySelectorAll('[name=sday]:checked')].map(c => c.value),
    project: v('sproject').value, tests: [...d.querySelectorAll('[name=stest]:checked')].map(c => c.value),
    env: v('senv').value, session: v('ssession').value, repeat: +v('srepeat').value,
    enabled: v('senabled').checked, record: v('srecord').checked, guide: v('sguide').checked,
  };
});
// PDF guide logo: uploaded right away (it is a file, not a setting)
function showLogo(has) {
  $('guideLogo').hidden = !has; $('guideLogoRemove').hidden = !has; $('guideLogoNone').hidden = has;
  if (has) $('guideLogo').src = `/branding/logo?${Date.now()}`;
}
$('guideLogoFile').onchange = () => {
  const f = $('guideLogoFile').files[0]; if (!f) return;
  if (f.size > 350_000) { $('guideLogoMsg').textContent = 'That image is too large: use one under ~350 KB.'; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try { await api('/branding/logo', { method: 'POST', body: JSON.stringify({ dataUrl: reader.result }) }); $('guideLogoMsg').textContent = 'Logo saved.'; showLogo(true); }
    catch (err) { $('guideLogoMsg').textContent = err.message; }
  };
  reader.readAsDataURL(f);
};
$('guideLogoRemove').onclick = async () => { await api('/branding/logo', { method: 'DELETE' }); $('guideLogoFile').value = ''; $('guideLogoMsg').textContent = 'Logo removed.'; showLogo(false); };
$('addSched').onclick = () => { const d = schedRow(undefined, true); $('schedList').append(d); d.querySelector('input').focus(); };
$('notifyTest').onclick = async () => {
  $('notifyMsg').textContent = 'Sending…';
  try { const { sent } = await api('/notify/test', { method: 'POST' }); $('notifyMsg').textContent = `Sent via ${sent.join(' and ')}.`; }
  catch (err) { $('notifyMsg').textContent = err.message; }
};
$('addEnv').onclick = () => { const r = envRow(); $('envList').append(r); r.querySelector('input').focus(); };
function collectEnvironments() {
  let activeEnv = '';
  const environments = [...$('envList').children].map(r => {
    const name = r.querySelector('[name=ename]').value.trim();
    if (r.querySelector('[name=envDefault]').checked) activeEnv = name;
    const vars = {};
    for (const line of r.querySelector('[name=evars]').value.split('\n')) {
      const i = line.indexOf('=');
      if (line.trim() && i < 1) throw new Error(`"${line.trim()}" in ${name || 'an environment'} is not name=value`);
      if (i > 0) vars[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { name, vars, production: r.querySelector('[name=eprod]').checked };
  });
  return { environments, activeEnv };
}
$('sf').addEventListener('invalid', e => {
  // reveal the tab / provider row that holds the invalid field
  const panel = e.target.closest('.tabpanel'); if (panel) selectTab($(panel.getAttribute('aria-labelledby')));
  const row = e.target.closest('details'); if (row) row.open = true;
}, true);
$('sf').onsubmit = async e => {
  e.preventDefault();
  const providers = [...$('plist').children].map(d => {
    const v = n => d.querySelector(`[name=${n}]`).value.trim();
    return { id: d.dataset.id, apiKeyEnv: d.dataset.apiKeyEnv || undefined, label: v('label'), engine: v('engine'), baseURL: v('baseURL'), model: v('model'), apiKey: v('apiKey'), configDir: v('configDir') };
  });
  const secrets = [...$('secretList').children].map(r => ({ name: r.querySelector('[name=sname]').value.trim(), value: r.querySelector('[name=svalue]').value }));
  const secretProjects = Object.fromEntries([...$('secretList').children].map(r => [r.querySelector('[name=sname]').value.trim().toUpperCase(), [...r.querySelectorAll('[name=sproj]:checked')].map(c => c.value)]));
  $('saveP').disabled = true;
  try {
    const envs = collectEnvironments();
    await api('/settings', { method: 'POST', body: JSON.stringify({ providers, secrets, secretProjects, ...envs, schedules: collectSchedules(), notify: { telegramChatId: $('tgChat').value.trim() }, guide: { lang: $('guideLang').value, company: $('guideCompany').value.trim(), accent: $('guideAccent').value }, recording: { width: +$('recW').value, height: +$('recH').value, fps: +$('recFps').value, highlight: $('recHighlight').checked, keep: +$('recKeep').value, device: $('recDevice').value, a11y: $('recA11y').checked } }) });
    await renderSettings(); // fresh from the server: new status badges, signed-in accounts, the saved state as baseline
    toast('Settings saved');
  } catch (err) { $('serr').textContent = err.message; }
  finally { $('saveP').disabled = false; }
};
