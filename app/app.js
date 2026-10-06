// ABRA UI
import { esc, md, describe, issueLabel, issueDetail, lineDiff, isAppError, isThirdParty, isA11y } from '/shared.mjs';
import { createStudio, BLOCKS } from '/studio.js';
import { when, dur } from '/time.mjs';

const $ = id => document.getElementById(id);
const store = {
  get() { try { return JSON.parse(localStorage.getItem('last') || '{}'); } catch { return {}; } },
  set(v) { try { localStorage.setItem('last', JSON.stringify({ ...store.get(), ...v })); } catch {} },
};
const saved = store.get();
$('record').checked = saved.record ?? true; $('replayRecord').checked = saved.replayRecord ?? true; $('showBrowser').checked = saved.showBrowser ?? true; $('replayShowBrowser').checked = saved.replayShowBrowser ?? true;
$('guide').checked = saved.guide ?? false; $('wfRecord').checked = saved.wfRecord ?? true; $('wfGuide').checked = saved.wfGuide ?? false; $('replayGuide').checked = saved.replayGuide ?? false; $('replayRepeat').value = saved.replayRepeat ?? '1';

const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: opts.body ? { 'content-type': 'application/json' } : undefined })
    .catch(() => { throw new Error('Cannot reach the app server: it is not running. Start it with "npm run app", then try again.'); }); // instead of the browser's bare "Failed to fetch"
  if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
  return r.status === 204 ? null : (r.headers.get('content-type') ?? '').includes('json') ? r.json() : r.text();
};
// a file as the request body itself (the server's readRaw); answers JSON
const sendFile = (path, file) => fetch(path, { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } })
  .then(async r => { if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`); return r.json(); });
const fmtSize = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
// one row per file: its {{file.X}} value (click to copy), size, Delete
function renderFiles(list, files, onDelete) {
  list.innerHTML = files.map(f => `<li><code title="Click to copy">{{file.${esc(f.name)}}}</code><span class="muted">${f.size !== undefined ? fmtSize(f.size) : ''}</span><button type="button" class="link danger" data-name="${esc(f.name)}" aria-label="Delete ${esc(f.name)}">Delete</button></li>`).join('');
  for (const c of list.querySelectorAll('code')) c.onclick = () => navigator.clipboard.writeText(c.textContent).then(() => toast(`Copied ${c.textContent}`));
  for (const b of list.querySelectorAll('button')) b.onclick = () => onDelete(b.dataset.name);
}
const STATUS = { pass: 'Passed', fail: 'Failed', stopped: 'Stopped', error: 'Error', blocked: 'Blocked', interrupted: 'Interrupted' };
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
    if (!store.get().setupSeen) { const setup = await setupStatus(); if (setup) { renderSetup(setup); $('setupContinue').hidden = false; show('setup'); return; } }
    await route(); // Projects first: the check loads a second Playwright once, which holds the server up briefly
    setupStatus().then(setup => { if (setup) syncReqBadge(setup.items); if (setup?.items.some(i => i.status === 'bad') && !document.body.classList.contains('running')) { renderSetup(setup); show('setup'); } });
  } catch (err) {
    $('projectList').innerHTML = `<div class="emptybox"><strong>The app could not load</strong>${esc(err.message)}. Check that the server is running (npm run app), then reload this page.</div>`;
  }
}

/* ---------- projects: start screen, then one project at a time (#/p/<id>) ---------- */
let project = null, projects = [];
let shownViews = 0; // counts show() calls, so a late default page never replaces one the user picked
const withProject = path => `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(project.id)}`;
// form fields (URL, instructions, ...) are remembered per project
const projectState = () => store.get().projects?.[project.id] ?? {};
// the environments picked in a project's forms (Run AI, Record, Saved tests, Workflows): dropped when its default changes
const forgetEnvChoices = id => {
  const all = store.get().projects ?? {};
  if (!all[id]) return;
  const { aiEnv, recEnv, replayEnv, wfEnv, ...rest } = all[id];
  store.set({ projects: { ...all, [id]: rest } });
};
const storeProject = v => store.set({ projects: { ...store.get().projects, [project.id]: { ...projectState(), ...v } } });

// Addresses (spec §1): #/ · #/p/<id>[/ai|record|tests|workflows|history] · #/p/<id>/workflows/<wf|new>
// · #/p/<id>/run/<runId|live> · #/settings[/<tab>] · #/requirements · #/report[/<runId>]
const PROJECT_VIEWS = ['ai', 'record', 'tests', 'workflows', 'history'];
function parseUrl(h = location.hash) {
  const parts = h.replace(/^#\/?/, '').split('/').filter(Boolean).map(x => { try { return decodeURIComponent(x); } catch { return x; } });
  if (parts[0] === 'p' && /^[a-z0-9-]+$/.test(parts[1] ?? '')) {
    const [, proj, view = 'ai', id] = parts;
    if (view === 'workflows' && id) return { project: proj, view: 'studio', id };
    if (view === 'run' && id) return { project: proj, view: 'run', id };
    return { project: proj, view: PROJECT_VIEWS.includes(view) ? view : 'ai' };
  }
  if (parts[0] === 'settings') return { view: 'settings', id: parts[1] };
  if (parts[0] === 'requirements') return { view: 'setup' };
  if (parts[0] === 'report') return { view: 'report', id: parts[1] };
  return { view: 'home' };
}
function urlOf(view, id) {
  const p = project ? `#/p/${project.id}` : '#/';
  if (view === 'home') return '#/';
  if (PROJECT_VIEWS.includes(view)) return project ? `${p}/${view}` : '#/';
  if (view === 'studio') return `${p}/workflows/${encodeURIComponent(id ?? 'new')}`;
  if (view === 'run') return `${p}/run/${encodeURIComponent(id ?? 'live')}`;
  if (view === 'settings') return `#/settings${id ? `/${id}` : ''}`;
  if (view === 'setup') return '#/requirements';
  if (view === 'report') return `#/report${id ? `/${encodeURIComponent(id)}` : ''}`;
  return location.hash || '#/';
}
let aiInstr = null; // Run AI's attached instructions: { name, text } of a .md file (server: instr)
let routing = false; // route() is showing what the address says: show() replaces instead of adding an entry
let shownView = 'home', shownId; // the page on screen, so a cancelled leave can put its address back
const writeUrl = (url, replace) => { if (location.hash === url) return; history[replace || routing ? 'replaceState' : 'pushState'](null, '', url); };
const restoreUrl = () => history.replaceState(null, '', urlOf(shownView, shownId));
// One styled dialog for every confirmation (mockup confirm dialog). Resolves true for the action, false for Cancel/Esc;
// typeToConfirm: the action stays off until that text is typed. One at a time: a second ask waits for the first.
let askChain = Promise.resolve();
const askDialog = opts => (askChain = askChain.then(() => openAsk(opts), () => openAsk(opts)));
function openAsk({ title, text = '', confirm = 'OK', cancel = 'Cancel', danger = false, typeToConfirm }) {
  return new Promise(resolve => {
    const dlg = $('askDlg'), ok = dlg.querySelector('[data-ask=ok]'), no = dlg.querySelector('[data-ask=cancel]'), before = document.activeElement;
    $('askTitle').textContent = title; $('askText').textContent = text;
    ok.textContent = confirm; no.textContent = cancel; ok.className = `btn${danger ? ' danger-solid' : ''}`;
    $('askTypeWrap').hidden = !typeToConfirm; $('askInput').value = '';
    $('askTypeLabel').textContent = typeToConfirm ? `Type ${typeToConfirm} to confirm` : '';
    ok.disabled = Boolean(typeToConfirm);
    $('askInput').oninput = () => { ok.disabled = $('askInput').value.trim() !== typeToConfirm; };
    let answer = false;
    ok.onclick = () => { answer = true; dlg.close(); };
    no.onclick = () => dlg.close();
    dlg.addEventListener('close', () => { before?.focus?.(); resolve(answer); }, { once: true });
    dlg.showModal();
    (typeToConfirm ? $('askInput') : danger ? no : ok).focus();
  });
}
// pages that ask before they are left: unsaved Settings, unsaved Studio
function needsLeave(toView, toProject = project?.id) {
  if (toView !== 'settings' && !$('view-settings').hidden && settingsDirty().length) return 'settings';
  if ((toView !== 'studio' || toProject !== project?.id) && !$('view-studio').hidden && studio.isDirty()) return 'studio';
  return null;
}
let leaving = false; // a leave question is open: other navigation waits for its answer
async function askLeave(toView, toProject) {
  const what = needsLeave(toView, toProject);
  if (!what) return true;
  leaving = true;
  try {
    const ok = await askDialog(what === 'settings'
      ? { title: 'Leave Settings?', text: `You have unsaved changes in ${settingsDirty().join(', ')}. They will be lost.`, confirm: 'Leave without saving', danger: true }
      : { title: 'Leave the workflow?', text: 'Your changes to this workflow are not saved yet.', confirm: 'Leave without saving', danger: true });
    if (ok && what === 'studio') studio.discard();
    return ok;
  } finally { leaving = false; }
}
let routeChain = Promise.resolve();
const route = () => (routeChain = routeChain.then(routeNow, routeNow)); // one at a time: a fast Back-Back never interleaves
async function routeNow() {
  const want = parseUrl();
  const global = ['settings', 'setup', 'report'].includes(want.view);
  // a run in progress keeps its project (Back to #/ too: Projects would have no way back in until the run ends)
  if (document.body.classList.contains('running') && (want.project ?? (global ? project?.id : undefined)) !== project?.id) { toast('A run is going on: other projects open when it ends'); return restoreUrl(); }
  if (leaving || !(await askLeave(want.view, want.project ?? project?.id))) return restoreUrl();
  try { projects = await api('/projects'); }
  catch (err) { // never a blank page: say what failed
    show('home', { force: true });
    $('projectList').innerHTML = `<div class="emptybox"><strong>Projects could not be loaded</strong>${esc(err.message)}. Restart the app (npm run app) and reload this page.</div>`;
    return;
  }
  const before = project;
  const next = want.project ? projects.find(p => p.id === want.project) ?? null : global ? project && projects.find(p => p.id === project.id) : null;
  if (want.project && !next) { history.replaceState(null, '', '#/'); return routeNow(); }
  project = next;
  if (project?.id !== before?.id) $('summaries').replaceChildren(); // summary cards belong to the project they ran in (all results stay in History)
  $('projName').textContent = project?.name ?? 'All projects';
  applyRoles();
  routing = true;
  try {
    const clicks = shownViews;
    if (project && project.id !== before?.id) await enterProject();
    if (shownViews !== clicks) return; // a section opened while the project loaded stays open
    if (project && before && project.id !== before.id) toast(`Switched to ${project.name}`);
    await showUrl(want);
  } finally { routing = false; }
}
// the page an address names
async function showUrl(want) {
  const v = want.view;
  if (v === 'home' || (!project && (PROJECT_VIEWS.includes(v) || v === 'studio' || v === 'run'))) { renderHome(); return show('home', { force: true }); }
  if (PROJECT_VIEWS.includes(v)) return show(v, { force: true });
  if (v === 'studio') return shownView === 'studio' && shownId === want.id ? null : studio.open(want.id === 'new' ? null : want.id);
  if (v === 'run') {
    if (want.id === 'live') {
      const run = [...liveRuns].find(r => r.params?.project === project.id || r.page?.project === project.id) ?? [...liveRuns][0];
      if (run) return showLive(run);
      history.replaceState(null, '', urlOf('history')); return show('history', { force: true });
    }
    if (shownView === 'run' && shownId === want.id) return;
    try { return openPastRun(await api(`/history/${encodeURIComponent(want.id)}`), 'history'); }
    catch { history.replaceState(null, '', urlOf('history')); return show('history', { force: true }); }
  }
  if (v === 'settings') return openSettings(want.id);
  if (v === 'setup') return openRequirements();
  if (v === 'report') return openReport(want.id ?? '');
}
window.addEventListener('hashchange', route);

// a status as a pill: Passed / Failed / a warning for runs cut short / Not run yet
const statusPill = st => !st ? '<span class="pill idle">Not run yet</span>'
  : st === 'stopped' ? `<span class="pill idle stopped">${icon('stop')}Stopped</span>` // stopped by hand is not a warning
  : `<span class="pill ${esc(st)}">${st === 'pass' ? icon('check') : ['fail', 'error', 'blocked'].includes(st) ? icon('x') : ''}${esc(STATUS[st] ?? st)}</span>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// Projects page numbers: this week's runs over every project, how many passed, projects whose last run failed, runs going now
function projectStats(list, running) {
  const runs = list.reduce((n, p) => n + (p.week?.runs ?? 0), 0), passed = list.reduce((n, p) => n + (p.week?.passed ?? 0), 0);
  return { runs, passRate: runs ? Math.round(passed / runs * 100) : null, failing: list.filter(p => ['fail', 'error', 'blocked'].includes(p.last?.status)).length, running };
}
function renderHome() {
  document.title = 'ABRA';
  const s = projectStats(projects, liveRuns.size);
  const stat = (num, cap, style = '') => `<div class="card stat"><span class="num"${style}>${num}</span><span class="cap">${cap}</span></div>`;
  $('projStats').innerHTML = stat(s.runs, 'Runs this week') + stat(s.passRate === null ? '—' : `${s.passRate}%`, 'Passed')
    + stat(s.failing, 'Failed, need a look', s.failing ? ' style="color:var(--fail)"' : '') + stat(s.running, 'Running now');
  const card = p => {
    const pass = p.recent.filter(st => st === 'pass').length, n = p.recent.length, rate = n ? Math.round(pass / n * 100) : null;
    return `<article class="card project" data-id="${esc(p.id)}">
      <div class="proj-top">
        <span class="proj-ava" aria-hidden="true">${esc(p.name.slice(0, 2).toUpperCase())}</span>
        <span class="proj-id"><span class="proj-name">${esc(p.name)}</span><span class="proj-url">${esc(p.url || p.description || 'No start URL')}</span></span>
        ${statusPill(p.last?.status)}
      </div>
      <div class="meter">
        <div class="meter-top"><span>Pass rate · ${plural(n, 'run')}</span><b>${rate === null ? '—' : `${rate}%`}</b></div>
        <div class="bar" role="img" aria-label="${pass} passed, ${n - pass} not passed"><i class="p" style="width:${n ? pass / n * 100 : 0}%"></i><i class="f" style="width:${n ? (n - pass) / n * 100 : 0}%"></i></div>
      </div>
      <div class="tags-row"><span class="tag">${icon('tests')}${plural(p.tests.length, 'test')}</span><span class="tag">${icon('workflow')}${plural(p.workflows ?? 0, 'workflow')}</span><span class="tag">${icon('globe')}${esc(p.env || settings.activeEnv || 'No environment')}</span></div>
      <div class="proj-foot">
        <span class="hint grow">${p.last ? `Last run ${esc(when(p.last.started))}` : 'No runs yet'}</span>
        <button type="button" class="btn ghost small" data-open="${esc(p.id)}" data-to="tests">Open</button>
        <button type="button" class="btn small" data-open="${esc(p.id)}" data-to="ai">${icon('sparkles')}Run AI</button>
      </div>
    </article>`;
  };
  const demo = projects.length ? '' : `<button type="button" class="project new" data-demo><span class="ico">${icon('sparkles')}</span><b>Try the demo</b><span class="hint">A practice shop with 2 saved tests: press Run and watch</span></button>`;
  $('projectList').innerHTML = projects.map(card).join('') + demo + `<button type="button" class="project new" data-new><span class="ico">${icon('plus')}</span><b>New project</b><span class="hint">Add another application to test</span></button>`;
  applyRoles();
}
$('projectList').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.open) location.hash = `#/p/${b.dataset.open}/${b.dataset.to}`;
  if (b.dataset.edit) editProject(projects.find(p => p.id === b.dataset.edit));
  if ('new' in b.dataset) openNewProject();
  if ('demo' in b.dataset) api('/projects/demo', { method: 'POST' }).then(r => { toast('Demo ready: open Saved tests and press Run on a test'); location.hash = `#/p/${r.id}`; }, err => toast(`The demo could not be added: ${err.message}`));
};
$('newProject').onclick = () => openNewProject();
// New project: a name, a start URL and an environment; it stays on Projects (Edit project has the rest)
function openNewProject() {
  $('npName').value = ''; $('npUrl').value = '';
  $('npEnv').replaceChildren(new Option('The default environment', ''), ...testEnvs().map(e => new Option(e.name, e.name)));
  for (const id of ['npNameErr', 'npUrlErr', 'npErr']) $(id).hidden = true;
  for (const id of ['npName', 'npUrl']) $(id).removeAttribute('aria-invalid');
  $('newProjDlg').showModal(); $('npName').focus();
}
const npNameMsg = v => !v.trim() ? 'Give the project a name, e.g. "Web Shop".' : '';
const npUrlMsg = v => !v.trim() || /^(https?:\/\/\S+|\{\{)/.test(v.trim()) ? '' : 'The address must start with http:// or https://';
$('npName').addEventListener('blur', () => { if (!$('npNameErr').hidden) fieldErr($('npName'), $('npNameErr'), npNameMsg($('npName').value)); });
$('npUrl').addEventListener('blur', () => { if ($('npUrl').value.trim() || !$('npUrlErr').hidden) fieldErr($('npUrl'), $('npUrlErr'), npUrlMsg($('npUrl').value)); });
$('npCancel').onclick = () => $('newProjDlg').close();
$('npForm').onsubmit = async e => {
  e.preventDefault();
  $('npErr').hidden = true;
  const okName = fieldErr($('npName'), $('npNameErr'), npNameMsg($('npName').value)), okUrl = fieldErr($('npUrl'), $('npUrlErr'), npUrlMsg($('npUrl').value));
  if (!okName) return $('npName').focus();
  if (!okUrl) return $('npUrl').focus();
  $('npCreate').disabled = true;
  try {
    const { id } = await api('/projects', { method: 'POST', body: JSON.stringify({ name: $('npName').value.trim(), url: $('npUrl').value.trim(), env: $('npEnv').value, description: '', app: '', guidePrompt: '', codebase: '', db: {}, dbPasswords: {} }) });
    $('newProjDlg').close();
    if (location.hash === '#/') await route(); else { location.hash = '#/'; await new Promise(r => setTimeout(r, 0)); await routeChain; }
    toast('Project created');
    const card = document.querySelector(`.project[data-id="${CSS.escape(id)}"]`);
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); card?.classList.add('flash');
  } catch (err) { // the server's reason, under the field it is about
    if (/name|already exists/i.test(err.message)) fieldErr($('npName'), $('npNameErr'), err.message);
    else if (/url/i.test(err.message)) fieldErr($('npUrl'), $('npUrlErr'), err.message);
    else { $('npErr').textContent = err.message; $('npErr').hidden = false; }
  } finally { $('npCreate').disabled = false; }
};
// ⋯ on Projects: Export all / Import project
const closeMore = () => { $('projMoreMenu').hidden = true; $('projMore').setAttribute('aria-expanded', 'false'); };
$('projMore').onclick = e => { e.stopPropagation(); const open = $('projMoreMenu').hidden; $('projMoreMenu').hidden = !open; $('projMore').setAttribute('aria-expanded', String(open)); if (open) $('projMoreMenu').querySelector('button').focus(); };
$('projMoreMenu').onclick = closeMore;
document.addEventListener('click', e => { if (!$('projMoreMenu').hidden && !e.target.closest('#projMoreMenu')) closeMore(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('projMoreMenu').hidden) { closeMore(); $('projMore').focus(); } });

// sidebar project switcher
const closeMenu = () => { $('projMenu').hidden = true; $('projSwitch').setAttribute('aria-expanded', 'false'); };
$('projSwitch').onclick = e => {
  e.stopPropagation();
  if (!$('projMenu').hidden) return closeMenu();
  $('projMenu').innerHTML = [
    `<button type="button" role="menuitem" data-go="" aria-current="${!project}">${icon('grid')}All projects</button>`, '<hr>',
    ...projects.map(p => `<button type="button" role="menuitem" data-go="${esc(p.id)}" aria-current="${p.id === project?.id}">${icon('folder')}${esc(p.name)}</button>`),
    '<hr>', project && `<button type="button" role="menuitem" data-edit>${icon('edit')}Edit project</button>`, `<button type="button" role="menuitem" data-new>${icon('plus')}New project</button>`,
  ].filter(Boolean).join('');
  $('projMenu').hidden = false; $('projSwitch').setAttribute('aria-expanded', 'true');
  $('projMenu').querySelector('[aria-current="true"]')?.focus();
};
$('projMenu').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  closeMenu();
  if ('new' in b.dataset) return openNewProject();
  if ('edit' in b.dataset) return editProject(project);
  // another project, same page (a run or the Studio belong to their project: Run AI instead)
  location.hash = b.dataset.go ? `#/p/${b.dataset.go}/${PROJECT_VIEWS.includes(shownView) ? shownView : 'ai'}` : '#/';
};
document.addEventListener('click', e => { if (!$('projMenu').hidden && !e.target.closest('.switch-wrap')) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('projMenu').hidden) { closeMenu(); $('projSwitch').focus(); } });
// phones: the sidebar is a drawer over a scrim; every way out closes it
function setSide(open) {
  if ($('side').classList.contains('open') === open) return;
  $('side').classList.toggle('open', open); $('scrim').classList.toggle('open', open);
  for (const b of [$('sideToggle'), $('moreBtn')]) b.setAttribute('aria-expanded', String(open));
  if (open) $('side').querySelector('.side-close').focus();
}
$('sideToggle').onclick = $('moreBtn').onclick = () => setSide(true);
$('scrim').onclick = $('side').querySelector('.side-close').onclick = () => setSide(false);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('side').classList.contains('open')) setSide(false); });
document.querySelector('.bottomnav').addEventListener('click', e => {
  const b = e.target.closest('[data-view]'); if (b) document.querySelector(`nav.views [data-view=${b.dataset.view}]`)?.click();
});
// N: Run AI, unless the key is typed into a field or a dialog is open
document.addEventListener('keydown', e => {
  if (e.key !== 'n' || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !project || document.body.classList.contains('running')) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
  if (!$('view-guide').hidden || document.body.classList.contains('studio-open')) return; // they keep their own unsaved edits
  e.preventDefault(); show('ai');
});
// Requirements in the sidebar: how many tools need attention
function syncReqBadge(items = []) {
  const n = items.filter(i => i.status === 'bad' || i.status === 'warn').length;
  $('reqBadge').hidden = !n; $('reqBadge').textContent = n ? String(n) : '';
}

async function enterProject() {
  document.title = `${project.name} · ABRA`;
  $('projName').textContent = project.name;
  const ps = projectState();
  aiInstr = ps.instructions ?? null; showAiInstr();
  $('url').value = ps.url ?? project.url ?? ''; $('task').value = ps.task ?? ''; $('taskTitle').value = ps.title ?? ''; $('expected').value = ps.expected ?? '';
  $('recUrl').value = ps.recUrl ?? project.url ?? '';
  attachFlow(null);
  setEditing(null); setEditingTest(null); // a prompt or test being edited belongs to the project left behind
  applyRoles();
  await loadSettings();
  for (const sel of document.querySelectorAll('.envSel')) { // the project's environment unless one was picked here before
    const want = ps[sel.id] ?? project.env;
    sel.value = want && [...sel.options].some(o => o.value === want) ? want : settings.activeEnv || '';
  }
  syncAiForm(); varChips();
}

// New / edit project dialog
let editingProject = null;
function editProject(p) {
  editingProject = p;
  $('projTitle').textContent = p ? `Edit ${p.name}` : 'New project';
  $('projSave').textContent = p ? 'Save project' : 'Create project';
  $('projNameIn').value = p?.name ?? ''; $('projDesc').value = p?.description ?? ''; $('projUrl').value = p?.url ?? '';
  $('projApp').value = p?.app ?? '';
  $('projGuidePrompt').value = p?.guidePrompt ?? '';
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
      if (!await askDialog({ title: `Import ${list.length} projects?`, text: `${list.slice(0, 25).join('\n')}${list.length > 25 ? '\n…' : ''}\n\n${warning}`, confirm: 'Import' })) return;
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
      location.hash === '#/' ? route() : (location.hash = '#/');
      return;
    }
    const names = Object.keys(bundle.files ?? {});
    if (!await askDialog({ title: `Import "${bundle.project?.name ?? f.name}"?`, text: `${names.length} files:\n${names.slice(0, 20).join('\n')}${names.length > 20 ? '\n…' : ''}\n\n${warning}`, confirm: 'Import' })) return;
    let r = await send();
    if (r.status === 409) {
      const { conflict, suggestion } = await r.json();
      const overwrite = await askDialog({ title: `"${conflict}" already exists`, text: `Overwrite its tests (history and sessions stay), or import as a new project "${suggestion}".`, confirm: 'Overwrite its tests', cancel: `Import as "${suggestion}"` });
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
      <div><div class="title">${esc(x.name)}</div><div class="sub">${esc(x.sites.join(', ') || 'no cookies')}, saved ${esc(when(x.saved))}</div></div>
      <button type="button" class="link danger">Delete</button></div>`).join('')
    : '<p class="muted" style="padding:10px 14px; margin:0">None saved yet.</p>';
}
$('projSessions').onclick = async e => {
  const item = e.target.closest('[data-name]'); if (!item || e.target.tagName !== 'BUTTON') return;
  if (!await askDialog({ title: `Delete login session "${item.dataset.name}"?`, confirm: 'Delete', danger: true })) return;
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
    name: $('projNameIn').value, description: $('projDesc').value, url: $('projUrl').value, env: $('projEnv').value, app: $('projApp').value, guidePrompt: $('projGuidePrompt').value, codebase: $('projCodebase').value,
    db: Object.fromEntries(rows.map(d => [d.dataset.env, dbConfigOf(d)])),
    dbPasswords: Object.fromEntries(rows.map(d => [d.dataset.env, d.querySelector('[name=dpass]').value])),
  });
  try {
    const { id } = editingProject
      ? await api(`/projects/${editingProject.id}`, { method: 'PUT', body })
      : await api('/projects', { method: 'POST', body });
    $('projDlg').close();
    if (editingProject && (editingProject.env ?? '') !== $('projEnv').value) forgetEnvChoices(editingProject.id);
    if (editingProject) { if (project?.id === editingProject.id) project = null; route(); } // enter it again: its settings changed
    else location.hash = `#/p/${id}`;
  } catch (err) { $('projErr').textContent = err.message; }
};
$('projDelete').onclick = async () => {
  const p = editingProject;
  const typed = await askDialog({ title: `Delete ${p.name}?`, confirm: 'Delete project', danger: true, typeToConfirm: p.name, text: `This deletes "${p.name}" with its ${p.tests.length} saved test${p.tests.length === 1 ? '' : 's'} (the files in tests/${p.id}/), ${p.runs} run${p.runs === 1 ? '' : 's'} of history, and their videos and PDFs.` }) ? p.name : null;
  if (typed !== p.name) return;
  try { await api(`/projects/${p.id}`, { method: 'DELETE' }); $('projDlg').close(); route(); }
  catch (err) { $('projErr').textContent = err.message; }
};
// the status pill of the run on screen, or a short toast elsewhere (the run in progress: liveStatus)
function setStatus(text, kind = '') {
  $('status').textContent = text; $('status').className = 'pill ' + kind;
  if ($('view-run').hidden) toast(text);
}
let toastTimer;
function toast(text) {
  $('toast').textContent = text; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
}

/* ---------- views ---------- */
let origin = 'ai'; // where the current run page was opened from
let lastPage = 'home'; // where Settings returns to
// show a page and write its address; force: the caller already asked the leave guards (route)
// returns true, false (not shown), or a Promise of that while a leave question is open
function show(view, { id, replace, force } = {}) {
  if (!force) {
    if (leaving) return false;
    if (needsLeave(view)) return askLeave(view).then(ok => ok && show(view, { id, replace, force: true }));
  }
  writeUrl(urlOf(view, id), replace);
  shownView = view; shownId = id;
  document.body.classList.toggle('studio-open', view === 'studio');
  shownViews++;
  for (const v of ['home', 'setup', 'guide', 'ai', 'record', 'tests', 'workflows', 'studio', 'history', 'settings', 'run', 'report']) (v === 'home' ? $('home') : $(`view-${v}`)).hidden = v !== view;
  const navView = view === 'run' ? origin : view === 'studio' ? 'workflows' : view;
  for (const b of document.querySelectorAll('nav.views button, .bottomnav [data-view]')) b.setAttribute('aria-current', b.dataset.view === navView ? 'page' : 'false');
  syncChips();
  for (const b of document.querySelectorAll('.openSettings')) b.setAttribute('aria-current', view === 'settings' ? 'page' : 'false');
  if (!['settings', 'run', 'setup', 'guide', 'report'].includes(view)) lastPage = view;
  $('openSetup').setAttribute('aria-current', view === 'setup' ? 'page' : 'false');
  $('reportProblem').setAttribute('aria-current', view === 'report' ? 'page' : 'false');
  if (view !== 'run' && live) { live.close(); live = null; } // not watching: the run's browser can stop its screencast
  if (view === 'tests') loadTests();
  if (view === 'ai') loadPrompts();
  if (view === 'history') loadHistory();
  if (view === 'workflows') loadWorkflows();
  $('scroll').scrollTop = 0; setSide(false);
  syncHeadHeight();
  return true;
}
// boxes that stay in view (Run settings, the Settings sections) stick just below the sticky page header, whatever its height
function syncHeadHeight() {
  const head = [...document.querySelectorAll('.page-head')].find(h => h.offsetParent);
  if (head) $('scroll').style.setProperty('--head-h', `${head.offsetHeight + 16}px`);
}
addEventListener('resize', syncHeadHeight);
// a run may go on while you look elsewhere; switching project waits for it
// Projects: the hash may already be empty (no project open), then there is no hashchange to route on
for (const b of document.querySelectorAll('nav.views button')) b.onclick = () => (b.dataset.view !== 'home' ? show(b.dataset.view) : location.hash === '#/' ? route() : (location.hash = '#/'));

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
      b.onclick = async () => {
        if (act === 'del' && doc.blocks[i].type === 'step' && !await askDialog({ title: 'Delete this step?', text: 'The step and its screenshot leave the guide.', confirm: 'Delete', danger: true })) return;
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
$('guideBack').onclick = async () => { if (guideEdit?.dirty && !await askDialog({ title: 'Leave the guide?', text: 'Your changes to the guide are not saved yet.', confirm: 'Leave without saving', danger: true })) return; show('run', { id: pageMeta?.id }); };

/* ---------- first run: what this computer needs (Requirements) ---------- */
let setupChecked = 0; // when the tools were last checked
function renderSetup(setup) {
  syncReqBadge(setup.items);
  setupChecked = Date.now();
  $('setupOs').textContent = setup.osName;
  const req = setup.items.filter(i => i.required), opt = setup.items.filter(i => !i.required);
  const ready = list => list.filter(i => i.status === 'ok').length;
  const stat = (num, cap) => `<div class="card stat"><span class="num">${num}</span><span class="cap">${cap}</span></div>`;
  $('reqStats').innerHTML = stat(`${ready(req)} of ${req.length}`, 'Required tools ready') + stat(setup.items.filter(i => i.status !== 'ok' && (i.required || i.status === 'warn')).length, 'Need attention')
    + stat(`${ready(opt)} of ${opt.length}`, 'Optional tools installed') + stat(esc(when(setupChecked)), 'Last checked');
  // a row: status icon; name and pill; what it needs · what was found; why; how to install; Install when ABRA can do it
  const row = i => {
    const state = i.status === 'ok' ? 'ok' : i.required ? 'warn' : 'missing';
    const pill = state === 'ok' ? `<span class="pill pass">${icon('check')}Ready</span>` : state === 'warn' ? `<span class="pill warn">${icon('alert')}Needs attention</span>` : '<span class="pill idle">Optional</span>';
    const fixes = i.status === 'ok' ? '' : (i.fix ?? []).map(f => f.cmd
      ? `${f.note ? `<span class="hint">${esc(f.note)}</span>` : ''}<span class="req-cmd"><code>${esc(f.cmd)}</code><button type="button" class="icon-btn" data-copy="${esc(f.cmd)}" aria-label="Copy the command" title="Copy">${icon('copy')}</button></span>`
      : `<span class="hint">${esc(f.note)}</span>`).join('');
    return `<div class="req-row" data-id="${esc(i.id)}">
      <span class="req-ico ${state}">${icon(state === 'ok' ? 'check' : state === 'warn' ? 'alert' : 'download')}</span>
      <span class="req-body"><span class="row-title">${esc(i.label)} ${pill}</span><span class="row-sub">${esc(i.need ?? '')} · <span class="req-found">${esc(i.detail)}</span></span><span class="hint">${esc(i.why ?? '')}</span>${fixes}</span>
      <span class="req-acts">${i.status !== 'ok' && i.action === 'browsers' ? `<button type="button" class="btn ghost small" data-browsers>${icon('download')}Install</button>` : ''}</span>
    </div>`;
  };
  $('reqRequired').innerHTML = req.map(row).join('');
  $('reqOptional').innerHTML = opt.map(row).join('');
  const blocked = setup.items.some(i => i.status === 'bad');
  $('setupContinue').disabled = blocked;
  $('setupContinue').title = blocked ? 'Get the Required items ready first' : '';
  for (const b of $('setupList').querySelectorAll('[data-copy]')) b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Command copied. Paste it in a terminal.'), () => toast('Select the text and copy it'));
  for (const b of $('setupList').querySelectorAll('[data-browsers]')) b.onclick = downloadBrowsers;
}
async function recheckSetup() { renderSetup(await api('/setup/status')); }
function downloadBrowsers() {
  for (const b of $('setupList').querySelectorAll('[data-browsers]')) { b.disabled = true; b.innerHTML = '<span class="spinner" aria-hidden="true"></span>Installing…'; }
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
$('setupRecheck').onclick = async () => {
  const b = $('setupRecheck'); b.disabled = true; b.querySelector('span').textContent = 'Checking…';
  try { await recheckSetup(); toast(`Checked ${$('setupList').querySelectorAll('.req-row').length} tools`); }
  catch (err) { toast(err.message); }
  finally { b.disabled = false; b.querySelector('span').textContent = 'Check again'; }
};
$('setupContinue').onclick = () => { store.set({ setupSeen: true }); $('setupContinue').hidden = true; location.hash === '#/' ? route() : (location.hash = '#/'); };
/* ---------- Report a problem: a form, a live preview, then a filled-in GitHub issue and a folder of attachments ---------- */
let repInfo = null, repRuns = [], repClean = { title: '', text: '', runTitle: '', env: '' }, repTimer;
// the title, text and run as they will leave (secrets marked by the server); the preview never shows a typed secret
let repSeq = 0; // a reply that arrives after a newer one is dropped
async function cleanReport() {
  const seq = ++repSeq;
  try { const r = await api('/report/preview', { method: 'POST', body: JSON.stringify({ title: $('repTitle').value.trim(), text: $('repWhat').value.trim(), runId: $('repRun').value || undefined }) }); if (seq === repSeq) repClean = r; }
  catch { if (seq === repSeq) repClean = { title: '', text: '', runTitle: '', env: '' }; }
  if (seq === repSeq) syncReport();
}
const cleanSoon = () => { clearTimeout(repTimer); repTimer = setTimeout(cleanReport, 250); };
async function openReport(runId = '') {
  $('repMain').hidden = false; $('repSent').hidden = true;
  $('repShotWrap').hidden = !window.abraDesktop; // a screenshot of the window needs the desktop app
  if (!(await show('report', { id: runId || undefined, force: routing }))) return;
  try {
    [repInfo, repRuns] = await Promise.all([api('/report/preview'), project ? api(withProject('/history')) : []]); // a fresh log each time
  } catch (err) { toast(err.message); repInfo ??= { version: '?', os: '', mode: '', log: [] }; }
  $('repRun').replaceChildren(new Option('No run', ''), ...repRuns.slice(0, 50).map(r => new Option(`${r.status === 'pass' ? '✓' : '✗'} ${(r.title || (r.task ?? '').split('\n')[0]).slice(0, 70)} · ${when(r.started)}`, r.id)));
  $('repRun').value = repRuns.some(r => r.id === runId) ? runId : '';
  await cleanReport();
}
function syncReport() {
  const run = repRuns.find(r => r.id === $('repRun').value);
  $('repVideo').disabled = !run?.video;
  $('repVideoHint').textContent = !run ? 'Only when a run is linked.' : run.video ? 'The video of the linked run.' : 'The linked run has no video.';
  const files = [$('repLog').checked && 'app-log.txt', run?.video && $('repVideo').checked && `run-${run.id}${run.video.slice(run.video.lastIndexOf('.'))}`, !$('repShotWrap').hidden && $('repShot').checked && 'screenshot.png'].filter(Boolean);
  const c = t => `<span class="c">${esc(t)}</span>`;
  const log = repInfo?.log ?? [];
  $('repPrev').innerHTML = [
    c(`# ${repClean.title || 'Short title of the problem'}`), '',
    esc(repClean.text || 'What happened, what you expected.').replaceAll('[secret removed]', '<span class="redact">[secret removed]</span>'), '',
    c('## Run'), run ? esc(`${repClean.runTitle} (${run.id}) · ${STATUS[run.status] ?? run.status} · ${when(run.started)}`) : 'No run linked', '',
    c('## Environment'), esc(`ABRA ${repInfo?.version ?? ''} · ${repInfo?.os ?? ''} · ${repInfo?.mode ?? ''}`), ...(project ? [esc(`Project: ${project.name}${repClean.env ? ` · ${repClean.env}` : ''}`)] : []), '',
    ...($('repLog').checked ? [c(`## App log (last ${log.length} lines)`), ...log.map(l => esc(l).replaceAll('[secret removed]', '<span class="redact">[secret removed]</span>')), ''] : []),
    c('## Attachments'), ...(files.length ? files.map(f => `- ${esc(f)}`) : ['None']),
  ].join('\n');
}
for (const id of ['repTitle', 'repWhat']) $(id).addEventListener('input', () => { cleanSoon(); $(`${id}Err`).hidden = true; });
// checked when a field is left, with the same messages as Send
$('repTitle').addEventListener('blur', () => { if (!$('repTitle').value.trim()) { $('repTitleErr').textContent = 'Add a short title, e.g. "Video is missing after a failed run".'; $('repTitleErr').hidden = false; } });
$('repWhat').addEventListener('blur', () => { if ($('repWhat').value.trim().length < 15) { $('repWhatErr').textContent = 'Describe the problem in a sentence or two, so we can reproduce it.'; $('repWhatErr').hidden = false; } });
$('repRun').addEventListener('change', cleanSoon);
for (const id of ['repLog', 'repVideo', 'repShot']) $(id).addEventListener('change', syncReport);
const repErr = (id, text) => { $(`${id}Err`).textContent = text; $(`${id}Err`).hidden = false; $(id).focus(); };
$('repForm').onsubmit = async e => {
  e.preventDefault();
  const title = $('repTitle').value.trim(), text = $('repWhat').value.trim();
  if (!title) return repErr('repTitle', 'Add a short title, e.g. "Video is missing after a failed run".');
  if (text.length < 15) return repErr('repWhat', 'Describe the problem in a sentence or two, so we can reproduce it.');
  const b = $('repSend'); b.disabled = true; b.querySelector('span').textContent = 'Preparing…';
  try {
    const screenshot = !$('repShotWrap').hidden && $('repShot').checked ? await window.abraDesktop.capture() : undefined;
    const r = await api('/report', { method: 'POST', body: JSON.stringify({ title, text, runId: $('repRun').value || undefined, log: $('repLog').checked, video: $('repVideo').checked && !$('repVideo').disabled, screenshot }) });
    window.open(r.url, '_blank', 'noopener');
    const files = [...($('repLog').checked ? ['app-log.txt'] : []), ...r.files];
    $('repFolderBox').hidden = !files.length;
    $('repFiles').textContent = files.join(', ') + (r.missing ? ` (not found: ${r.missing.join(', ')})` : '');
    $('repFolder').textContent = r.folder; $('repFolder').dataset.path = r.folder;
    $('repOpenFolder').hidden = !window.abraDesktop;
    $('repMain').hidden = true; $('repSent').hidden = false;
  } catch (err) { toast(err.message); }
  finally { b.disabled = false; b.querySelector('span').textContent = 'Send to GitHub'; }
};
$('repOpenFolder').onclick = () => window.abraDesktop?.showFolder($('repFolder').dataset.path);
$('repCopyFolder').onclick = () => navigator.clipboard.writeText($('repFolder').dataset.path).then(() => toast('Path copied'), () => toast('Select the path and copy it'));
$('repNew').onclick = () => { $('repTitle').value = ''; $('repWhat').value = ''; openReport(); };
$('repHome').onclick = () => (location.hash === '#/' ? route() : (location.hash = '#/'));
$('reportProblem').onclick = () => openReport();
async function openRequirements() { try { renderSetup(await api('/setup/status')); show('setup', { force: routing }); } catch (err) { toast(err.message); } }
$('openSetup').onclick = openRequirements;

/* ---------- live view ---------- */
let live, liveOf = null; // one screen stream: the browser of the run on screen
function startLive(run) { // the server checks the run is in your projects
  live?.close(); live = null; liveOf = run;
  $('stage').classList.remove('has-frame');
  if (!run.id) return; // still waiting for a free run slot: the 'run' event starts it
  live = new EventSource('/screen?' + new URLSearchParams({ run: run.id }));
  live.addEventListener('frame', e => { if (viewing !== run) return; $('frame').src = 'data:image/jpeg;base64,' + JSON.parse(e.data); $('stage').classList.add('has-frame'); });
  live.addEventListener('url', e => { const u = JSON.parse(e.data); run.addr = u; if (viewing === run) $('addr').textContent = u; });
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
    sel.replaceChildren(...settings.activeEnv ? [] : [new Option('None', '')], ...testEnvs().map(e => new Option(e.name + (e.name === settings.activeEnv ? ' (default)' : ''), e.name)));
    sel.value = testEnvs().some(e => e.name === cur) ? cur : settings.activeEnv || '';
    sel.closest('label').hidden = !testEnvs().length;
  }
  varChips(); syncRunSummary();
}
// Run AI: the values the instructions can use, as chips that type themselves at the cursor
function varChips() {
  const env = Object.keys(settings.environments?.find(e => e.name === $('aiEnv').value)?.vars ?? {});
  const chip = (v, lock) => `<button type="button" class="var-chip" data-var="${esc(v)}"${lock ? ' title="Secret: the AI only sees the name"' : ''}>${lock ? icon('lock') : ''}${esc(v)}</button>`;
  $('varChips').innerHTML = [...env.map(n => chip(`{{${n}}}`)), ...(project?.secrets ?? []).map(n => chip(`{{${n}}}`, true)), chip('{{today}}'), chip('{{random}}')].join('');
}
$('varChips').onclick = e => {
  const b = e.target.closest('[data-var]'); if (!b) return;
  const t = $('task'), s = t.selectionStart ?? t.value.length, end = t.selectionEnd ?? s;
  const pre = t.value.slice(0, s), sep = pre && !/\s$/.test(pre) ? ' ' : '';
  t.setRangeText(sep + b.dataset.var, s, end, 'end'); t.focus(); syncTaskCount();
};
const syncTaskCount = () => { $('taskCount').textContent = `${$('task').value.length} / 10000`; };
$('task').addEventListener('input', syncTaskCount);
// the three summary rows of Run settings; the full choices are under "Change settings"
function syncRunSummary() {
  const prov = $('provider').selectedOptions[0]?.textContent ?? 'No AI', model = $('model').value.trim() || $('model').placeholder;
  $('sumAi').textContent = `${prov} · ${model}`;
  $('sumEnv').textContent = $('aiEnv').value || 'None';
  $('sumOut').textContent = [$('record').checked && 'Video', $('guide').checked && 'PDF guide', $('showBrowser').checked && 'Visible browser'].filter(Boolean).join(', ') || 'In the background, no video';
}
$('f').addEventListener('input', syncRunSummary); $('f').addEventListener('change', syncRunSummary);
// after the form is filled by code (a project, a saved prompt, New prompt): counter, summary, and Title and files open when they hold something
function syncAiForm() {
  syncModelHint(); varChips(); syncTaskCount(); syncRunSummary();
  $('filesMore').open = Boolean($('taskTitle').value.trim() || aiFiles.length);
}
boot();
const syncModelHint = () => { $('model').placeholder = $('provider').selectedOptions[0]?.dataset.model || 'default'; }; // the chosen AI's default model
$('provider').onchange = () => { $('model').value = ''; syncModelHint(); };

/* ---------- running (AI or replay), shared ---------- */
let current; // the run on the page: one in progress, or one opened from History
// Runs in progress, several at once (the server runs MAX_RUNS of them, the rest wait in line). Each streams into its
// own record and has a chip in the sidebar; only the one on screen (viewing) is drawn. Opening another, or a History
// run, leaves it going; its page is drawn again from its record when you open it.
const liveRuns = new Set();
let viewing = null, pageMeta = {};
const paint = (run, fn) => { run.paints.push(fn); if (viewing === run) fn(); };
function liveStatus(run, text, kind = '') {
  run.status = [text, kind];
  run.chip.lastChild.textContent = `${run.label}: ${text}`;
  if (viewing === run) { $('status').textContent = text; $('status').className = 'pill ' + kind; }
}
function syncRunning() {
  const any = liveRuns.size > 0;
  document.body.classList.toggle('running', any);
  $('toProjects').disabled = $('projSwitch').disabled = $('repHome').disabled = any; // runs belong to this project
}
// a run's chip shows unless that run is the page you are on
const syncChips = () => { for (const r of liveRuns) r.chip.hidden = viewing === r && !$('view-run').hidden; };
function showLive(run) {
  current = viewing = run; origin = run.origin;
  openRunPage(run.page);
  setRunButtons('running'); stageMode('live'); $('rec').hidden = run.params.record !== '1'; $('caption').hidden = true;
  if (run.addr) $('addr').textContent = run.addr;
  if (liveOf !== run || !live) startLive(run); // also after the stream was closed on another page
  run.lastNote = null;
  for (const fn of run.paints) fn();
  $('status').textContent = run.status[0]; $('status').className = 'pill ' + run.status[1];
  renderProgress(run);
}
// the run page's progress while the run goes on (mockup .progress)
function renderProgress(run) {
  if (viewing !== run || run.done) return;
  const replay = run.kind === 'replay' && run.planned;
  $('progress').hidden = false;
  $('progText').textContent = `${run.queued ? 'Waiting' : 'Running'} · ${clock(run)}`;
  $('progCount').textContent = replay ? `Test ${Math.max(1, run.testsStarted ?? 0)} of ${run.planned} tests` : plural(run.stepsSeen ?? 0, 'step');
  $('progBarWrap').classList.toggle('indeterminate', !replay);
  $('progBar').style.width = replay ? `${Math.round(Math.max(1, run.testsStarted ?? 0) / run.planned * 100)}%` : '';
}
const clock = run => { const s = Math.round((Date.now() - run.started) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function addStep(t) {
  const { what, detail } = describe(t);
  const li = document.createElement('li');
  const n = $('steps').querySelectorAll('.step').length + 1;
  if (t.at !== undefined) li.dataset.at = t.at;
  if (t.g !== undefined) li.dataset.g = t.g;
  li.innerHTML = `<div class="step plainstep aistep"><span class="n step-ico">${n}</span><span><span class="what">${esc(what)}</span><span class="detail">${esc(detail)}</span></span><button type="button" class="link small" data-act="details" aria-expanded="false">Details</button></div><pre hidden>${esc(JSON.stringify(t.input, null, 2))}</pre>`;
  $('steps').append(li);
  $('stepCount').textContent = `${n} steps`;
  return { li, what, detail };
}
// an AI step's raw input: behind Details, so the step itself stays a plain line; a click on a step shows that moment
$('steps').addEventListener('click', e => {
  const b = e.target.closest('[data-act=details]');
  if (b) { const pre = b.closest('li').querySelector(':scope > pre'); pre.hidden = !pre.hidden; b.setAttribute('aria-expanded', String(!pre.hidden)); return; }
  const st = e.target.closest('.step'); if (!st || !shownRun) return;
  const steps = [...$('steps').querySelectorAll('.step')], n = steps.indexOf(st) + 1;
  for (const x of steps) x.removeAttribute('aria-current');
  st.setAttribute('aria-current', 'step');
  jumpToStep(shownRun, n, st);
});
let shownRun = null; // the finished run on the run page (its steps can be clicked)
// a step's screenshot from the run's PDF guide (its g-th step block), if the run made one
async function stepFrame(run, g) {
  if (!run.guide || !run.guideDoc) return null;
  run.guideBlocks ??= await api(`/guides/${encodeURIComponent(run.guide)}/doc`).then(d => d.blocks.filter(b => b.type === 'step'), () => []);
  const f = run.guideBlocks.at(g)?.frame; // -1: the last one
  return f ? `/guides/${encodeURIComponent(run.guide)}/${encodeURIComponent(f)}` : null;
}
function showShot(src, n, what) {
  $('stageShot').src = src; $('stageShot').hidden = false; $('stageVideo').pause(); $('stageVideo').hidden = true; $('stageDone').hidden = true;
  caption(`Step ${n}`, what);
}
// steps carry their guide step's index (g); a step the guide leaves out (an AI snapshot) shows the one before it.
// Runs before 1.8.0 have no g: the n-th guide step and the run's clock, as before.
async function jumpToStep(run, n, el) {
  const what = el.querySelector('.what')?.textContent ?? '';
  const li = el.closest('li'), lis = [...$('steps').children];
  const hasG = lis.some(x => x.dataset.g !== undefined); // a guide or a video was made (1.8.0+)
  const withG = hasG ? lis.slice(0, lis.indexOf(li) + 1).reverse().find(x => x.dataset.g !== undefined) : null;
  const g = hasG ? (withG ? Number(withG.dataset.g) : null) : n - 1;
  const shot = g === null ? null : await stepFrame(run, g);
  if (shot) return showShot(shot, n, what);
  const at = run.stepVideo ? (g === null ? 0 : run.stepVideo[g] ?? NaN) : Number(li?.dataset.at); // no stepVideo: the video was left as recorded
  if (run.video && Number.isFinite(at)) { $('stageShot').hidden = true; $('stageVideo').hidden = false; $('stageVideo').currentTime = at; $('stageVideo').pause(); caption(`Step ${n}`, what); }
}
// replay steps: a passed test's steps ✓, the last step of a failed test ✗ (Playwright reports results per test only)
function markReplaySteps(run) {
  const groups = [];
  for (const li of $('steps').children) {
    if (li.classList.contains('section') && (li.dataset.level ?? '1') === '1') groups.push([]);
    else { const st = li.querySelector('.step'); if (st && groups.length) groups.at(-1).push(st); }
  }
  // each test heading carries its own result (1.8.0+); older runs: tests[] in order (wrong with repeats)
  const heads = (run.replaySteps ?? []).filter(s => s.section && s.level === 1);
  const own = heads.some(h => h.status);
  groups.forEach((steps, k) => {
    const res = own ? heads[k]?.status : run.tests?.[k]?.status; if (!res || res === 'skipped') return;
    steps.forEach((st, i) => {
      const bad = res !== 'passed' && i === steps.length - 1;
      st.classList.add(bad ? 'fail' : 'pass');
      const ico = st.querySelector('.step-ico'); if (ico) ico.innerHTML = icon(bad ? 'x' : 'check');
    });
  });
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
  if (s.section) { li.className = 'section'; li.dataset.level = s.level ?? 1; li.textContent = s.section; $('steps').append(li); return li; }
  if (s.at !== undefined) li.dataset.at = s.at;
  if (s.g !== undefined) li.dataset.g = s.g;
  const n = $('steps').querySelectorAll('.step').length + 1;
  li.innerHTML = `<div class="step plainstep"><span class="n step-ico">${n}</span><span><span class="what">${esc(s.what)}</span>${s.detail ? `<span class="detail">${esc(s.detail)}</span>` : ''}</span></div>`;
  $('steps').append(li);
  $('stepCount').textContent = `${n} steps`;
  return li;
}
function caption(what, detail) {
  $('capWhat').textContent = what; $('capDetail').textContent = detail; $('caption').hidden = false;
  $('caption').classList.remove('pop'); void $('caption').offsetWidth; $('caption').classList.add('pop');
}

let runPageSeq = 0; // bumped by every run page opened: a result that arrives late knows its page is gone
function openRunPage(meta) {
  runPageSeq++; shownRun = null; // its steps are clickable once this run's result is in
  const { task, who, kind, title } = pageMeta = meta;
  $('runKind').textContent = kind === 'replay' && task.startsWith('Suite:') ? 'Suite' : KIND[kind]?.[1] ?? kind;
  $('runTitle').textContent = title || task.split('\n')[0];
  $('runTask').textContent = task; $('runWho').textContent = who;
  $('progress').hidden = true; $('steps').replaceChildren(); $('log').textContent = ''; $('result').hidden = true;
  $('logWrap').hidden = false; $('logWrap').open = false; $('issuesBox').hidden = true;
  resetRunActs();
  $('trailTitle').textContent = kind === 'replay' ? 'Test steps' : kind === 'workflow' ? 'Blocks' : 'AI steps'; $('stepCount').textContent = '';
  show('run', { id: meta.id }); $('runScroll').scrollTop = 0; // a live run is #/…/run/live until it is saved
}
function setRunButtons(state) { // running | done | history
  $('stop').hidden = state !== 'running'; $('stop').disabled = false;
  $('again').hidden = state === 'running'; // Back stays: leaving the page keeps the run going as a chip
}

// the stage: the live browser during a run, or the video of a finished run opened from History
function stageMode(mode, run) {
  const past = mode === 'past';
  $('stage').classList.toggle('past', past);
  $('stageVideo').pause(); $('stageVideo').hidden = !(past && run.video); $('stageDone').hidden = !(past && !run.video); $('stageShot').hidden = true;
  if (past && run.video) $('stageVideo').src = `/recordings/${run.video}`;
  if (!past) $('stageVideo').removeAttribute('src');
  $('addr').textContent = past ? run.url ?? '' : 'about:blank';
  $('rec').innerHTML = past ? `${icon('video')}Video saved` : 'Recording';
  if (past) $('rec').hidden = !run.video;
}

// the run page's heading for a run about to start; shown now unless the run goes on in the background
const runPage = (meta, background) => { if (background) pageMeta = meta; else openRunPage(meta); };
// background: the run goes on as a sidebar chip; the page on screen, the run page and the live view stay as they are
// (paint() keeps every step for when the chip is clicked)
function start(kind, params, { background = false } = {}) {
  const run = { kind, params, doneMsg: null, page: pageMeta, origin, paints: [], status: ['', ''], issues: [], started: Date.now(), background };
  if (!background) current = viewing = run;
  run.label = String(params.title || pageMeta.task || kind).split('\n')[0].slice(0, 60);
  run.chip = document.createElement('button');
  run.chip.type = 'button'; run.chip.className = 'live-chip'; run.chip.title = run.label;
  run.chip.innerHTML = '<span class="live-dot"></span><span class="live-text"></span>';
  run.chip.onclick = () => showLive(run);
  $('liveChips').append(run.chip);
  liveRuns.add(run); syncRunning();
  if (!background) {
    openRunPage(run.page); // a clean page (Run again reuses the one on screen)
    stageMode('live');
    setRunButtons('running');
    $('rec').hidden = params.record !== '1'; $('caption').hidden = true;
  }
  liveStatus(run, 'Running 0:00', 'run');
  run.timer = setInterval(() => { liveStatus(run, `Running ${clock(run)}`, 'run'); renderProgress(run); }, 1000);

  if (!background) { startLive(run); $('addr').textContent = 'about:blank'; } // this run's own browser comes next
  const es = run.es = new EventSource(`/${{ ai: 'run', replay: 'replay', fix: 'fix', workflow: 'workflow-run' }[kind]}?` + new URLSearchParams({ ...params, project: project.id }));
  paint(run, () => renderIssues(run.issues));
  es.addEventListener('queued', e => {
    const q = JSON.parse(e.data), gb = mb => (mb / 1024).toFixed(1);
    run.queued = true; clearInterval(run.timer);
    liveStatus(run, q.reason === 'memory'
      ? `Waiting for free memory: ${gb(q.freeMB)} GB free, a run needs ${gb(q.needMB)} GB. Close other apps or wait for the other run.`
      : `Waiting for a free run slot (#${q.position} in line)`, 'run');
  });
  es.addEventListener('run', e => {
    run.id = JSON.parse(e.data).id;
    if (viewing === run && !$('view-run').hidden) startLive(run); // a run that waited in line and starts while you are elsewhere: showLive opens it later
    if (run.queued) { run.queued = false; run.started = Date.now(); run.timer = setInterval(() => { liveStatus(run, `Running ${clock(run)}`, 'run'); renderProgress(run); }, 1000); }
  });
  es.addEventListener('text', e => { const t = JSON.parse(e.data); paint(run, () => { run.lastNote = { el: addNote(t), text: t }; run.lastNote.el.scrollIntoView({ block: 'nearest' }); }); });
  es.addEventListener('plan', e => { run.planned = JSON.parse(e.data).tests; renderProgress(run); });
  es.addEventListener('tool', e => { const t = JSON.parse(e.data); run.stepsSeen = (run.stepsSeen ?? 0) + 1; renderProgress(run); paint(run, () => { const { li, what, detail } = addStep(t); caption(what, detail); li.scrollIntoView({ block: 'nearest' }); }); });
  es.addEventListener('log', e => { const line = JSON.parse(e.data); paint(run, () => { $('log').textContent += line + '\n'; $('log').scrollTop = $('log').scrollHeight; }); });
  es.addEventListener('issue', e => { run.issues.push(JSON.parse(e.data)); paint(run, () => renderIssues(run.issues)); });
  // workflows: a heading when a block starts, its result when it ends
  es.addEventListener('block', e => {
    const b = JSON.parse(e.data);
    paint(run, () => {
      if (b.status === 'running') { addPlainStep({ section: blockTitle(b) }).scrollIntoView({ block: 'nearest' }); caption(blockTitle(b), BLOCKS[b.type]?.name ?? ''); }
      else addBlockResult(b).scrollIntoView({ block: 'nearest' });
    });
  });
  es.addEventListener('step', e => {
    const s = JSON.parse(e.data);
    if (s.section && s.level === 1) run.testsStarted = Math.min((run.testsStarted ?? 0) + 1, run.planned ?? Infinity); // a test begins
    else if (!s.section) run.stepsSeen = (run.stepsSeen ?? 0) + 1;
    renderProgress(run);
    const heading = run.kind === 'fix' && !run.verifyHeading;
    if (heading) run.verifyHeading = true;
    paint(run, () => { if (heading) addPlainStep({ section: 'Verifying the corrected test (no AI)' }); const li = addPlainStep(s); if (!s.section) caption(s.what, s.detail); li.scrollIntoView({ block: 'nearest' }); });
  });
  es.addEventListener('fail', e => { const msg = JSON.parse(e.data); paint(run, () => addNote(msg, 'error')); if (!msg.startsWith('Recording failed')) run.doneMsg = 'Error'; });
  es.addEventListener('stopped', () => { run.doneMsg = 'Stopped'; toast('Run stopped'); });
  es.addEventListener('done', e => {
    const d = JSON.parse(e.data);
    paint(run, () => { if (run.lastNote && run.lastNote.text === d.text) run.lastNote.el.remove(); }); // the final answer is shown in the result card
    run.doneMsg = d.ok ? 'Passed' : 'Failed';
    liveStatus(run, 'Saving results', 'run');
  });
  es.addEventListener('saved', async e => {
    const { id } = JSON.parse(e.data);
    const shown = viewing === run && !$('view-run').hidden; // peeked at through its chip and left: the card, not the hidden page
    finish(run);
    const page = runPageSeq;
    const saved = await api(`/history/${id}`);
    // another run opened while the result loaded: it keeps its page, this one becomes a card
    if (shown && page === runPageSeq && !$('view-run').hidden) { renderResult(saved, { live: true }); shownId = saved.id; writeUrl(urlOf('run', saved.id), true); }
    else showSummary(saved);
  });
  es.onerror = () => {
    if (!liveRuns.has(run)) return;
    const shown = viewing === run && !$('view-run').hidden; // peeked at through its chip and left: the card, not the hidden page
    finish(run);
    if (shown) setStatus(run.doneMsg ?? 'Connection lost', 'fail'); else showSummary({ status: { Passed: 'pass', Failed: 'fail', Stopped: 'stopped' }[run.doneMsg] ?? 'error', title: run.label, secs: Math.round((Date.now() - run.started) / 1000), error: run.doneMsg ? '' : 'Connection lost' });
  };
}

/* ---------- background runs: a summary card that stays until closed, plus a system notice when the window is away ---------- */
function showSummary(r) {
  const total = r.tests?.length ?? 0, passed = r.tests?.filter(t => t.status === 'passed').length ?? 0;
  const appErrors = (r.issues ?? []).filter(isAppError).length;
  const meta = [dur(r.secs), ...(r.kind === 'replay' && total ? [`${passed} of ${total} tests passed`] : []), ...(appErrors ? [`${appErrors} app error${appErrors > 1 ? 's' : ''}`] : [])];
  const head = { pass: '✓ Passed', fail: '✗ Failed' }[r.status] ?? STATUS[r.status] ?? r.status;
  const firstError = r.error ?? r.tests?.find(t => t.status !== 'passed' && t.error)?.error; // a failing test keeps its message in tests[]
  const card = document.createElement('div');
  card.className = `summary ${r.status}`;
  if (r.id) card.dataset.id = r.id;
  card.innerHTML = `<div class="summary-head"><b>${esc(head)}</b><button type="button" class="icon-btn" data-act="close" aria-label="Close">${icon('x')}</button></div>
    <div class="summary-name">${esc(r.title || r.task || '')}</div>
    <div class="summary-meta">${esc(meta.join(' · '))}</div>
    ${firstError ? `<div class="summary-error">${esc(String(firstError).split('\n')[0])}</div>` : ''}
    ${r.id ? '<button type="button" class="btn small" data-act="open">Open result</button>' : ''}`;
  card.onclick = async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    card.remove();
    if (b.dataset.act === 'open') openPastRun(await api(`/history/${r.id}`), lastPage);
  };
  $('summaries').prepend(card);
  while ($('summaries').children.length > 5) $('summaries').lastChild.remove();
  notifySystem(r, () => card.querySelector('[data-act=open]')?.click());
}
function notifySystem(r, onClick) {
  if (!document.hidden && document.hasFocus()) return; // you are looking: the card is enough
  if (typeof Notification === 'undefined') return;
  const go = () => {
    const n = new Notification(`ABRA: ${STATUS[r.status] ?? r.status}`, { body: r.title || r.task || '' });
    n.onclick = () => { window.focus(); onClick(); n.close(); };
  };
  if (Notification.permission === 'granted') go();
  else if (Notification.permission !== 'denied') Notification.requestPermission().then(p => { if (p === 'granted') go(); }).catch(() => {});
}

function finish(run) {
  run.es.close(); clearInterval(run.timer); run.done = true;
  if (viewing === run) $('progress').hidden = true;
  liveRuns.delete(run); run.chip.remove(); syncRunning();
  if (liveOf === run) { live?.close(); live = null; liveOf = null; }
  if (viewing !== run) return; // another run or a History run on screen keeps its page
  viewing = null;
  $('rec').hidden = true; $('caption').hidden = true;
  setRunButtons('done');
}

// Stop asks the server, so the stream stays open and the partial recording + history entry still arrive
$('stop').onclick = () => { // the run on screen
  const run = viewing; if (!run) return;
  if (run.queued) { finish(run); setStatus('Removed from the queue'); return; } // leaving the line: the server drops it
  $('stop').disabled = true; liveStatus(run, 'Stopping…', 'run');
  fetch(`/stop?${new URLSearchParams({ run: run.id })}`, { method: 'POST' }).catch(() => finish(run));
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
  const testsBegun = (run.replaySteps ?? []).filter(s => s.section && (s.level ?? 1) === 1).length, testsPlanned = run.planned ?? (run.testNames?.length ?? 0) * (run.times ?? 1); // planned: Playwright's count (1.8.0+)
  const sub = status === 'stopped' && run.kind === 'ai' ? `${plural(run.steps?.length ?? 0, 'step')} done before you stopped it`
    : status === 'stopped' && run.kind === 'replay' && testsPlanned ? `${testsBegun} of ${plural(testsPlanned, 'test')} done before you stopped it`
    : run.kind === 'workflow' ? `${blocksOk} of ${blocksDone.length} blocks passed in ${dur(run.secs)}`
    : run.kind === 'ai' ? `${run.steps?.length ?? 0} steps in ${dur(run.secs)}`
    : run.kind === 'fix' ? `${run.steps?.length ?? 0} AI steps${total ? `, then ${passed} of ${total} passed without AI` : ''}, ${dur(run.secs)}`
    : `${passed} of ${total} tests passed in ${dur(run.secs)}`;
  const title = run.kind === 'fix'
    ? { pass: '✓ Fixed and verified', fail: run.script ? '✗ The corrected test still fails' : '✗ Could not fix this test', stopped: 'Stopped', error: 'The fix could not complete', interrupted: 'Interrupted', blocked: '⛔ Blocked: production address' }[status]
    : { pass: '✓ Passed', fail: '✗ Failed', stopped: 'Stopped', error: 'The run could not complete', interrupted: 'Interrupted', blocked: '⛔ Blocked: production address' }[status];
  r.className = 'result ' + status;
  const failedAt = status === 'fail' && run.kind === 'ai' && run.steps?.length && run.expectedMet !== false ? `Failed at step ${run.steps.length}` : '';
  const bigIcon = status === 'pass' ? 'check' : status === 'stopped' ? 'stop' : ['interrupted', 'blocked'].includes(status) ? 'alert' : 'x';
  r.innerHTML = `<div class="result-top"><span class="big">${icon(bigIcon)}</span><span class="result-text"><b>${esc(failedAt || title.replace(/^[✓✗⛔] /, ''))}</b><small>${esc(sub)}${run.started ? ` · ${esc(when(run.started))}` : ''}</small></span></div>`;
  if (run.error) r.insertAdjacentHTML('beforeend', `<p class="evidence">${esc(run.error)}</p>`);
  if (run.flaky?.length) r.insertAdjacentHTML('beforeend', `<div class="flakybox"><b>⚠ Flaky: passes sometimes, fails sometimes.</b> Usually timing (slow loading, animations), not a real break. Fix the wait before using Fix with AI.<ul>${run.flaky.map(f => `<li>${esc(f.title)}${f.row ? ` (row ${f.row})` : ''}: passed ${f.passed} of ${f.total}</li>`).join('')}</ul></div>`);
  if (run.expected) r.insertAdjacentHTML('beforeend', `<div class="expectbox ${run.expectedMet === true ? 'met' : 'unmet'}"><b>${run.expectedMet === true ? '✓ Expected result met' : run.expectedMet === false ? '✗ Expected result not met' : '? The AI did not confirm the expected result'}</b><span>${esc(run.expected)}</span></div>`);
  // what the AI wrote at the end: in view when the run failed, folded away when it passed
  if (run.evidence) r.insertAdjacentHTML('beforeend', status === 'pass'
    ? `<details class="disclose"><summary><span class="lbl">AI notes</span>${icon('chevron').replace('class="i"', 'class="i chev"')}</summary><div class="disclose-body evidence">${md(run.evidence)}</div></details>`
    : `<div class="ai-note"><span class="ai-note-head">${icon('sparkles')}What the AI saw</span><div class="evidence">${md(run.evidence)}</div></div>`);
  if (run.kind === 'workflow' && blocksDone.length) r.insertAdjacentHTML('beforeend', `<ol class="wf-result">${blocksDone.map(b => `<li class="${esc(b.status)}">
      <div class="wf-r-head"><b>${b.status === 'pass' ? '✓' : '✗'} ${esc(blockTitle(b))}</b><span class="muted">${esc(BLOCKS[b.type]?.name ?? b.type)}, ${dur(b.secs)}</span></div>
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
  for (const b of r.querySelectorAll('[data-accept]')) b.onclick = async () => {
    if (!await askDialog({ title: 'Use the current screens?', text: `They become the new visual baseline of "${b.dataset.accept}".`, confirm: 'Use them' })) return;
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

  // the run's actions sit in its head: the main one, Save as test, Video, and ⋯ with what this run has
  const head = (text, cls, onclick) => { const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text, className: `btn run-primary ${cls}`, onclick }); $('again').before(b); $('again').className = 'btn ghost'; return b; };
  if (run.kind === 'fix' && run.script) {
    const name = run.testNames[0];
    const save = head(run.status === 'pass' ? `Save fix to ${name}` : 'Save anyway (not verified)', run.status === 'pass' ? '' : 'ghost', async () => {
      if (run.status !== 'pass' && !await askDialog({ title: 'Save the fix anyway?', text: 'The corrected test did not pass its check.', confirm: 'Save anyway', danger: true })) return;
      await api(`/tests?project=${encodeURIComponent(run.project)}`, { method: 'POST', body: JSON.stringify({ name, runId: run.id, overwrite: true }) });
      save.textContent = `Saved to tests/${run.project}/${name}.spec.ts`; save.disabled = true;
    });
  }
  // a run made from Edit in Run AI: overwrite that test (script, source, files; never its data set)
  if (run.kind === 'ai' && run.editOf && run.script) {
    const upd = head(`Update ${run.editOf}`, run.status === 'pass' ? '' : 'ghost', async () => {
      if (run.status !== 'pass' && !await askDialog({ title: `Overwrite ${run.editOf}?`, text: 'This run did not pass. The test is replaced by what it recorded.', confirm: 'Overwrite anyway', danger: true })) return;
      try {
        const res = await api(`/tests/${run.editOf}/from-run?project=${encodeURIComponent(run.project)}`, { method: 'PUT', body: JSON.stringify({ runId: run.id }) });
        upd.textContent = `Updated tests/${run.project}/${run.editOf}.spec.ts`; upd.disabled = true;
        if (editingTest === run.editOf && project?.id === run.project) setEditingTest(null);
        toast(`Updated ${run.editOf}`);
        if (project?.id === run.project) loadTests();
        if (res.missingFiles) toast(`File ${res.missingFiles.join(', ')} no longer available: add it in Edit test › Files`);
      } catch (err) { toast(err.message); }
    });
  }
  if (run.video) { $('videoBtn').href = `/recordings/${encodeURIComponent(run.video)}`; $('videoBtn').hidden = false; }
  const items = [];
  if (run.guide) items.push(['pdf', 'Open PDF guide', 'file', () => window.open(`/guides/${encodeURIComponent(run.guide)}`, '_blank', 'noopener')]);
  if (run.guide && run.guideDoc) items.push(['pdfEdit', 'Edit PDF guide', 'edit', () => openGuideEditor(run.guide)]);
  items.push(['report', 'Download HTML report', 'download', () => { location.href = `/report/${encodeURIComponent(run.id)}`; }]);
  if (run.script && run.kind !== 'fix') {
    const pre = document.createElement('pre'); pre.className = 'code'; pre.id = 'scriptPre'; pre.hidden = true; pre.textContent = run.script;
    r.append(pre);
    if (run.scriptFrom === 'browser') { const n = document.createElement('p'); n.className = 'hint'; n.textContent = 'Built from the browser steps that ran: the AI wrote no test. It has no expect() checks yet; add them in Edit after saving.'; r.append(n); }
    items.push(['copy', 'Copy script', 'copy', () => navigator.clipboard.writeText(run.script).then(() => toast('Script copied'))],
      ['show', 'Show script', 'code', () => { pre.hidden = !pre.hidden; if (!pre.hidden) pre.scrollIntoView({ block: 'nearest' }); }]);
    const form = inlineForm('Save as test', 'test-name, e.g. login-and-checkout', slugify(run.title || (run.task ?? '').split('\n')[0]).slice(0, 40), async name => {
      const res = await api(withProject('/tests'), { method: 'POST', body: JSON.stringify({ name, runId: run.id }) });
      return `Saved as tests/${project.id}/${res.name}.spec.ts. Replay it from the Saved tests tab.${res.missingFiles ? ` File ${res.missingFiles.join(', ')} no longer available: add it in Edit test › Files.` : ''}`;
    });
    form.hidden = true; r.append(form);
    $('saveTestBtn').hidden = false;
    $('saveTestBtn').onclick = () => { form.hidden = !form.hidden; if (!form.hidden) { form.scrollIntoView({ block: 'nearest' }); form.querySelector('input')?.focus(); } };
  }
  // the AI's browser stays open after a live run, so its login can be captured now
  if (live && run.kind === 'ai' && run.status !== 'error') {
    const form = inlineForm('Save login session', 'session name, e.g. admin-login', slugify(new URL(run.url).hostname.replace(/^www\./, '').split('.')[0]), async name => {
      const s = await api('/sessions', { method: 'POST', body: JSON.stringify({ project: project.id, name, run: run.id }) });
      await refreshProject();
      return `Session "${s.name}" saved (${s.cookies} cookies). Pick it under "Start with a login session".`;
    });
    form.hidden = true; r.append(form);
    items.push(['session', 'Save login session', 'user', () => { form.hidden = false; form.scrollIntoView({ block: 'nearest' }); form.querySelector('input')?.focus(); }]);
  }
  if (live && run.video) { $('rec').innerHTML = `${icon('video')}Video saved`; $('rec').hidden = false; }
  items.push(['problem', 'Report a problem with this run', 'bug', () => openReport(run.id)]);
  runMenuItems = items;
  $('runMoreWrap').hidden = !items.length;
  if (['ai', 'fix'].includes(run.kind) && run.expectedMet !== false) markSteps(status);
  if (run.kind === 'replay') markReplaySteps(run); // replay steps take their test's result
  shownRun = run;
  renderIssues(run.issues ?? []);
  r.hidden = false;
  if (live) r.scrollIntoView({ block: 'nearest' }); // a run opened from History starts at its head
}
// the run head's ⋯ menu: built from the finished run (renderResult), so it never lists what the run lacks
let runMenuItems = [];
function resetRunActs() {
  for (const b of document.querySelectorAll('#runActs .run-primary')) b.remove();
  $('again').className = 'btn';
  $('saveTestBtn').hidden = $('videoBtn').hidden = $('runMoreWrap').hidden = true;
  $('runMoreMenu').hidden = true; runMenuItems = [];
}
const closeRunMore = () => { $('runMoreMenu').hidden = true; $('runMore').setAttribute('aria-expanded', 'false'); };
$('runMore').onclick = e => {
  e.stopPropagation();
  if (!$('runMoreMenu').hidden) return closeRunMore();
  $('runMoreMenu').innerHTML = runMenuItems.map(([act, label, ic]) => `<button type="button" role="menuitem" data-act="${act}">${icon(ic)}${esc(label)}</button>`).join('');
  $('runMoreMenu').hidden = false; $('runMore').setAttribute('aria-expanded', 'true');
  $('runMoreMenu').querySelector('button')?.focus();
};
$('runMoreMenu').onclick = e => { const b = e.target.closest('[data-act]'); if (!b) return; closeRunMore(); runMenuItems.find(i => i[0] === b.dataset.act)?.[3](); };
document.addEventListener('click', e => { if (!$('runMoreMenu').hidden && !e.target.closest('#runMoreWrap')) closeRunMore(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('runMoreMenu').hidden) { closeRunMore(); $('runMore').focus(); } });
// a finished run: every step done shows ✓, the last one ✗ when the run failed
function markSteps(status) {
  const steps = [...document.querySelectorAll('#steps .step')];
  steps.forEach((st, i) => {
    const bad = status !== 'pass' && i === steps.length - 1 && ['fail', 'error'].includes(status);
    if (status !== 'pass' && !bad && i === steps.length - 1 && status !== 'fail') return; // stopped or interrupted: the last step stays open
    st.classList.add(bad ? 'fail' : 'pass');
    const ico = st.querySelector('.step-ico'); if (ico) ico.innerHTML = icon(bad ? 'x' : 'check');
  });
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
let aiFiles = []; // [{ id, name, size }] uploaded for the next Run AI (server: app/data/uploads)
// attached instructions (aiInstr, declared at the top: enterProject reads it): the text goes to the AI with the task
function showAiInstr() {
  $('aiInstr').innerHTML = aiInstr ? `<li><code>${esc(aiInstr.name)}</code><span class="muted">${fmtSize(new Blob([aiInstr.text]).size)}</span><button type="button" class="link danger" aria-label="Remove ${esc(aiInstr.name)}">Remove</button></li>` : '';
  $('aiInstr').querySelector('button')?.addEventListener('click', () => { aiInstr = null; showAiInstr(); });
  $('aiInstrAddText').textContent = aiInstr ? 'Replace instructions' : 'Attach instructions (.md)';
}
$('aiInstrIn').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > 100 * 1024) return toast(`${f.name} is larger than 100 KB`);
  aiInstr = { name: f.name, text: await f.text() }; showAiInstr();
};
const showAiFiles = () => renderFiles($('aiFiles'), aiFiles, n => { aiFiles = aiFiles.filter(f => f.name !== n); showAiFiles(); });
$('aiFileIn').onchange = async e => {
  try { for (const f of e.target.files) { const up = await sendFile(`/uploads?name=${encodeURIComponent(f.name)}`, f); aiFiles = [...aiFiles.filter(x => x.name !== up.name), { ...up, size: f.size }]; } }
  catch (err) { toast(err.message); }
  e.target.value = ''; showAiFiles();
};
// inline checks (mockup fieldErr): a message under the field and aria-invalid; '' clears it
function fieldErr(input, el, msg) { el.textContent = msg; el.hidden = !msg; input.setAttribute('aria-invalid', String(Boolean(msg))); return !msg; }
const urlMsg = (v, braces = true) => !v.trim() ? 'Enter the address of the page to start on, e.g. http://admin-app.test/'
  : /^https?:\/\/\S+$/.test(v.trim()) || (braces && /^\{\{/.test(v.trim())) ? '' : 'The address must start with http:// or https://';
const taskMsg = v => !v.trim() ? 'Tell the AI what to do, in a sentence or more.' : v.trim().length < 10 ? 'Write at least 10 characters so the AI knows what to do.' : '';
const aiFields = () => [[$('url'), $('urlErr'), urlMsg($('url').value)], [$('task'), $('taskErr'), taskMsg($('task').value)]];
function showAiErrs(list) { // list: [[input, message]]
  $('aiErrs').hidden = !list.length;
  $('aiErrs').innerHTML = list.length ? `<b>${list.length === 1 ? '1 field needs' : `${list.length} fields need`} attention</b><ul>${list.map(([i, m]) => `<li><a href="#" data-for="${i.id}">${esc(m)}</a></li>`).join('')}</ul>` : '';
}
$('aiErrs').onclick = e => { const a = e.target.closest('[data-for]'); if (a) { e.preventDefault(); $(a.dataset.for).focus(); } };
for (const id of ['url', 'task']) $(id).addEventListener('blur', () => {
  const [i, el, msg] = aiFields().find(([x]) => x.id === id);
  // on leaving a field: only what was typed wrong (an empty field waits for Run AI, so nothing jumps under the pointer)
  if ((msg && i.value.trim()) || !el.hidden) fieldErr(i, el, msg);
  if (aiFields().every(([, , m]) => !m)) showAiErrs([]);
});
const runAiIdle = () => { $('runAiBtn').disabled = false; $('runAiBtn').querySelector('span:last-child').textContent = 'Run AI'; $('runAiBtn').querySelector('.spinner')?.remove(); };
$('f').onsubmit = async e => {
  e.preventDefault();
  if ($('runAiBtn').disabled) return; // already starting (Ctrl+Enter again while the server checks)
  const bad = aiFields().filter(([i, el, m]) => !fieldErr(i, el, m));
  showAiErrs(bad.map(([i, , m]) => [i, m]));
  if (bad.length) return $('aiErrs').focus();
  const params = { url: $('url').value, title: $('taskTitle').value.trim(), task: $('task').value, provider: $('provider').value, model: $('model').value.trim(), session: $('aiSession').value, record: $('record').checked ? '1' : '', guide: $('guide').checked ? '1' : '', flow: attachedFlow ?? '', env: $('aiEnv').value, expected: $('expected').value.trim(), files: aiFiles.length ? JSON.stringify(aiFiles.map(({ id, name }) => ({ id, name }))) : '', instr: '', prompt: editingPrompt?.id ?? '', editTest: editingTest ?? '' };
  store.set({ showBrowser: $('showBrowser').checked, provider: params.provider, model: params.model, record: $('record').checked, guide: $('guide').checked, aiSession: params.session });
  storeProject({ url: params.url, title: params.title, task: params.task, expected: params.expected, aiEnv: params.env, instructions: aiInstr });
  // ask the server first: a refused start (bad address, production, no AI) shows its reason here, not "Connection lost"
  const btn = $('runAiBtn'); btn.disabled = true; btn.querySelector('span:last-child').textContent = 'Starting browser…'; btn.insertAdjacentHTML('afterbegin', '<span class="spinner" aria-hidden="true"></span>');
  try {
    if (aiInstr) { const up = await sendFile(`/uploads?name=${encodeURIComponent(aiInstr.name)}`, new Blob([aiInstr.text])); params.instr = JSON.stringify({ id: up.id, name: up.name }); } // too long for the address
    const r = await fetch(`/run?${new URLSearchParams({ ...params, project: project.id, check: '1' })}`);
    if (!r.ok) { showAiErrs([[$('url'), await r.text()]]); $('aiErrs').focus(); return; }
  } catch (err) { showAiErrs([[$('url'), err.message]]); return; }
  finally { runAiIdle(); }
  origin = 'ai';
  runPage({ kind: 'ai', task: params.task, who: `${$('provider').selectedOptions[0]?.textContent ?? ''}${params.model ? ` (${params.model})` : ''}${params.session ? `, session ${params.session}` : ''}${aiInstr ? `, instructions ${aiInstr.name}` : ''}` }, !$('showBrowser').checked);
  start('ai', params, { background: !$('showBrowser').checked });
};
$('task').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('f').requestSubmit(); });

/* ---------- saved prompts (prompts.mjs): the Run AI form kept to run later ---------- */
let editingPrompt = null; // { id, title } while the form holds a saved prompt
function setEditing(p) {
  if (p) setEditingTest(null);
  editingPrompt = p;
  $('promptEditing').hidden = !p;
  $('promptEditingName').textContent = p?.title ?? '';
}
// Edit in Run AI: the form holds a saved test's source; the result of its run offers Update <test>
let editingTest = null;
function setEditingTest(name, hint = false) {
  editingTest = name;
  $('testEditing').hidden = !name;
  $('testEditingName').textContent = name ?? '';
  $('testEditingHint').hidden = !hint;
}
async function editInAi(name) {
  const proj = project.id, step = ++promptStep;
  try {
    const [{ source, from }, files] = await Promise.all([api(withProject(`/tests/${name}/source`)), api(withProject(`/tests/${name}/use-files`), { method: 'POST' })]);
    if (step !== promptStep || project?.id !== proj) return; // another prompt or test was opened meanwhile
    setEditing(null);
    fillAiForm({ ...source, url: source.url || project.url || '' }, files);
    setEditingTest(name, from === 'code');
    show('ai');
    $('scroll').scrollTop = 0; $('task').focus();
  } catch (err) { toast(err.message); }
}
$('testEditCancel').onclick = () => setEditingTest(null);
const promptBody = () => JSON.stringify({
  url: $('url').value, title: $('taskTitle').value.trim(), task: $('task').value, expected: $('expected').value.trim(),
  env: $('aiEnv').value, provider: $('provider').value, model: $('model').value.trim(), session: $('aiSession').value,
  record: $('record').checked, guide: $('guide').checked, flow: attachedFlow ?? '', instructions: aiInstr, files: aiFiles.map(({ id, name }) => ({ id, name })),
});
let promptStep = 0; // bumped by every save or open: a reply that arrives after the form moved on is ignored
$('savePrompt').onclick = async () => {
  if (!$('task').value.trim()) { $('task').focus(); return toast('Write the instructions first'); }
  const was = editingPrompt, proj = project.id, step = ++promptStep;
  const title = $('taskTitle').value.trim() || $('task').value.trim().split('\n')[0];
  $('savePrompt').disabled = true; // one save at a time: a double click must not make two prompts
  try {
    const { id } = was
      ? await api(withProject(`/prompts/${was.id}`), { method: 'PUT', body: promptBody() })
      : await api(withProject('/prompts'), { method: 'POST', body: promptBody() });
    if (project?.id !== proj) return;
    if (step === promptStep && editingPrompt === was) setEditing({ id, title });
    toast('Prompt saved: open it from Saved prompts to run it');
    loadPrompts();
  } catch (err) { toast(err.message); }
  finally { $('savePrompt').disabled = false; }
};
$('promptNew').onclick = () => {
  setEditing(null);
  $('taskTitle').value = ''; $('task').value = ''; $('expected').value = '';
  aiInstr = null; showAiInstr(); aiFiles = []; showAiFiles(); attachFlow(null); syncAiForm();
  $('task').focus();
};
async function loadPrompts() {
  try {
    const [list, history] = await Promise.all([api(withProject('/prompts')), api(withProject('/history'))]);
    const last = {};
    for (const r of history) if (r.prompt && !last[r.prompt]) last[r.prompt] = r; // history is newest first
    $('promptCount').textContent = String(list.length);
    $('promptList').innerHTML = !list.length
      ? `<div class="empty"><span class="ico">${icon('download')}</span><b>No saved prompts yet</b><span>Fill in the form and press Save prompt to run it later.</span></div>`
      : list.map(p => {
        const r = last[p.id], files = p.files.length ? ` · ${p.files.length} file${p.files.length > 1 ? 's' : ''}` : '';
        return `<div class="item prompt-row" data-id="${esc(p.id)}">
          <span class="item-text"><span class="title">${esc(p.title || p.task)}</span><span class="sub">${esc(p.task.split('\n')[0])}</span><span class="meta">${esc(p.url)}${files} · Saved ${esc(when(Date.parse(p.saved)))}</span></span>
          ${r ? statusPill(r.status).replace('</span>', ` ${esc(when(r.started))}</span>`) : statusPill()}
          <span class="ractions"><button type="button" class="btn ghost small" data-act="open">Use</button><button type="button" class="icon-btn danger" data-act="delete" aria-label="Delete ${esc(p.title || p.id)}" title="Delete">${icon('trash')}</button></span>
        </div>`;
      }).join('');
  } catch (err) {
    $('promptList').innerHTML = `<div class="empty"><b>Saved prompts could not be loaded</b><span>${esc(err.message)}</span></div>`;
  }
}
// a saved prompt or a test's source into the Run AI form; an AI, environment or session removed since keeps the current choice
function fillAiForm(p, files) {
  $('url').value = p.url; $('taskTitle').value = p.title; $('task').value = p.task; $('expected').value = p.expected;
  for (const [sel, v] of [['provider', p.provider], ['aiEnv', p.env], ['aiSession', p.session]]) if ([...$(sel).options].some(o => o.value === v)) $(sel).value = v;
  if ($('provider').value === p.provider) $('model').value = p.model; // a model belongs to its AI: another AI keeps its own
  $('record').checked = p.record; $('guide').checked = p.guide;
  attachFlow(p.flow || null);
  aiInstr = p.instructions ?? null; showAiInstr();
  aiFiles = files; showAiFiles();
  syncAiForm();
}
$('promptList').onclick = async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.closest('[data-id]').dataset.id;
  try {
    if (b.dataset.act === 'delete') {
      if (!await askDialog({ title: 'Delete this saved prompt?', text: 'Its files go too.', confirm: 'Delete', danger: true })) return;
      await api(withProject(`/prompts/${id}`), { method: 'DELETE' });
      if (editingPrompt?.id === id) setEditing(null);
      return loadPrompts();
    }
    const proj = project.id, step = ++promptStep;
    const [p, files] = await Promise.all([api(withProject(`/prompts/${id}`)), api(withProject(`/prompts/${id}/use`), { method: 'POST' })]);
    if (step !== promptStep || project?.id !== proj) return; // another prompt was opened or saved meanwhile
    fillAiForm(p, files);
    setEditing({ id, title: p.title || p.task.split('\n')[0] });
    toast(`Loaded "${p.title || p.task.split('\n')[0].slice(0, 40)}"`);
    $('scroll').scrollTop = 0; $('task').focus();
  } catch (err) { toast(err.message); }
};

/* ---------- saved tests ---------- */
let lastByTest = {};
async function loadTests() {
  const [tests, history] = await Promise.all([api(withProject('/tests')), api(withProject('/history'))]);
  lastByTest = {};
  for (const run of [...history].reverse()) for (const n of run.testNames ?? []) lastByTest[n] = run;
  $('testsProj').textContent = project.name;
  if (!tests.length) {
    $('testList').innerHTML = `<div class="empty"><span class="ico">${icon('tests')}</span><b>No saved tests yet</b><span>Run the AI, then click "Save as test" on the result.</span></div>`;
  } else {
    $('testList').innerHTML = tests.map(t => {
      const last = lastByTest[t.name];
      const facts = last ? `${plural(last.stepCount ?? 0, 'step')} · ${dur(last.secs)} · View last result` : 'Not run yet';
      return `<div class="item test-row" data-name="${esc(t.name)}" data-find="${esc(`${t.name} ${t.titles.join(' ')}`.toLowerCase())}">
        <input type="checkbox" aria-label="Select ${esc(t.name)}">
        <span class="item-text">${last ? `<button type="button" class="title row-link" data-act="last" title="${esc(t.titles.join(', '))}" aria-label="${esc(t.name)}: open the last result">${esc(t.name)}</button>` : `<span class="title" title="${esc(t.titles.join(', '))}">${esc(t.name)}</span>`}<span class="sub">${facts}${t.dataRows ? ` · data set of ${t.dataRows} row${t.dataRows > 1 ? 's' : ''}` : ''}</span></span>
        <span class="row-meta">${last ? esc(when(last.started)) : ''}</span>
        ${statusPill(last?.status)}
        <span class="ractions">${last ? `<button type="button" class="icon-btn" data-act="last" aria-label="Open the last result of ${esc(t.name)}" title="Last result">${icon('right')}</button>` : `<button type="button" class="icon-btn" data-act="run" aria-label="Run ${esc(t.name)} for the first time" title="Run">${icon('play')}</button>`}<button type="button" class="icon-btn" data-act="more" aria-label="More actions for ${esc(t.name)}" aria-haspopup="menu">${icon('dots')}</button></span>
        <pre class="code" hidden></pre>
      </div>`;
    }).join('');
  }
  syncSuitebar();
}
const selectedTests = () => [...document.querySelectorAll('#testList .item')].filter(i => i.querySelector('input')?.checked).map(i => i.dataset.name);
// a row's menu: built when opened, inside the row, so its buttons reach the row's click handler
function rowMenu(item, actions) {
  const open = item.querySelector('.row-menu');
  closeRowMenus();
  if (open) return;
  item.insertAdjacentHTML('beforeend', `<div class="menu right row-menu" role="menu">${actions.map(([act, label, ic]) => `<button type="button" role="menuitem" data-act="${act}">${icon(ic)}${esc(label)}</button>`).join('')}</div>`);
  item.querySelector('.row-menu button').focus();
}
const closeRowMenus = () => document.querySelectorAll('.row-menu').forEach(m => m.remove());
document.addEventListener('click', e => { if (!e.target.closest('.row-menu, [data-act=more]')) closeRowMenus(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.querySelector('.row-menu')) { const item = document.querySelector('.row-menu').closest('.item'); closeRowMenus(); item.querySelector('[data-act=more]')?.focus(); } });
// the suite bar shows while tests are ticked
// ▶ and Run use the bar's choices too: they are summed up in the list's head, which opens the bar without ticking
let suiteOpen = false;
function syncSuitebar() {
  const boxes = [...document.querySelectorAll('#testList .item:not([hidden]) input[type=checkbox]')], n = selectedTests().length;
  $('suitebar').hidden = !n && !suiteOpen;
  $('runOptions').setAttribute('aria-expanded', String(!$('suitebar').hidden));
  $('suiteCount').textContent = `${n} selected`;
  $('runSelected').querySelector('span').textContent = n > 1 ? `Run ${n} tests` : 'Run 1 test';
  $('selAll').checked = boxes.length > 0 && boxes.every(b => b.checked);
  $('selAll').indeterminate = !$('selAll').checked && boxes.some(b => b.checked);
}
function runTests(names) {
  const params = { tests: names.join(','), session: $('replaySession').value, record: $('replayRecord').checked ? '1' : '', guide: $('replayGuide').checked ? '1' : '', env: $('replayEnv').value, repeat: $('replayRepeat').value };
  store.set({ replayShowBrowser: $('replayShowBrowser').checked, replayRecord: $('replayRecord').checked, replayGuide: $('replayGuide').checked, replaySession: params.session, replayRepeat: params.repeat });
  storeProject({ replayEnv: params.env });
  origin = 'tests';
  runPage({ kind: 'replay', task: names.length > 1 ? `Suite: ${names.join(', ')}` : `Replay: ${names[0]}`, who: `Playwright, no AI${params.session ? `, session ${params.session}` : ''}` }, !$('replayShowBrowser').checked);
  start('replay', params, { background: !$('replayShowBrowser').checked });
}
$('testList').onchange = syncSuitebar;
$('selAll').onchange = () => { for (const b of document.querySelectorAll('#testList .item:not([hidden]) input[type=checkbox]')) b.checked = $('selAll').checked; syncSuitebar(); };
$('suiteClear').onclick = () => { for (const b of document.querySelectorAll('#testList input[type=checkbox]')) b.checked = false; suiteOpen = false; syncSuitebar(); };
$('runOptions').onclick = () => { suiteOpen = $('suitebar').hidden; syncSuitebar(); };
$('suitebar').addEventListener('change', syncSuitebar);
$('toRecord').onclick = () => show('record');
$('testSearch').oninput = () => {
  const q = $('testSearch').value.trim().toLowerCase();
  for (const item of document.querySelectorAll('#testList .item')) item.hidden = Boolean(q) && !item.dataset.find.includes(q); // the name and the test titles inside
  // nothing left: say so, with a way back (mockup)
  const none = q && document.querySelector('#testList .item') && !document.querySelector('#testList .item:not([hidden])');
  $('testList').querySelector('.no-match')?.remove();
  if (none) $('testList').insertAdjacentHTML('beforeend', `<div class="empty no-match"><span class="ico">${icon('search')}</span><b>No tests match</b><span>Try another word or clear the search.</span><button type="button" class="btn ghost small" id="clearTestSearch">Clear search</button></div>`);
  syncSuitebar();
};
$('testList').addEventListener('click', e => { if (e.target.closest('#clearTestSearch')) { $('testSearch').value = ''; $('testSearch').dispatchEvent(new Event('input')); $('testSearch').focus(); } });
$('testList').onclick = async e => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const act = btn.dataset.act, item = btn.closest('.item'), name = item.dataset.name;
  if (act === 'more') return rowMenu(item, [['run', 'Run', 'play'], ['edit', 'Edit', 'edit'], ['ai', 'Edit in Run AI', 'sparkles'], ['code', 'Show code', 'code'], ['del', 'Delete', 'trash']]);
  closeRowMenus();
  if (act === 'last') return openPastRun(await api(`/history/${lastByTest[name].id}`), 'tests');
  if (act === 'run') runTests([name]);
  if (act === 'edit') editTest(name);
  if (act === 'ai') editInAi(name);
  if (act === 'code') {
    const pre = item.querySelector('pre');
    if (pre.hidden && !pre.textContent) pre.textContent = await api(withProject(`/tests/${name}`));
    pre.hidden = !pre.hidden;
  }
  if (act === 'del') { if (!await askDialog({ title: `Delete test "${name}"?`, text: `The file tests/${project.id}/${name}.spec.ts, its data set and visual baselines will be removed.`, confirm: 'Delete test', danger: true })) return; await api(withProject(`/tests/${name}`), { method: 'DELETE' }); loadTests(); }
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

/* ---------- history ---------- */
let historyRuns = [], historyFilter = 'all';
const KIND = { ai: ['sparkles', 'AI run'], fix: ['edit', 'Fix'], workflow: ['workflow', 'Workflow'], replay: ['tests', 'Replay'] };
async function loadHistory() {
  historyRuns = await api(withProject('/history'));
  renderHistory();
}
function renderHistory() {
  const q = $('histSearch').value.trim().toLowerCase();
  const failed = r => ['fail', 'error', 'blocked'].includes(r.status); // stopped and interrupted runs did not fail
  const runs = historyRuns.filter(r => (historyFilter === 'all' || (historyFilter === 'pass' ? r.status === 'pass' : failed(r)))
    && (!q || `${r.title ?? ''} ${r.task} ${r.provider ?? ''}`.toLowerCase().includes(q)));
  const counts = { all: historyRuns.length, pass: historyRuns.filter(r => r.status === 'pass').length };
  counts.fail = historyRuns.filter(failed).length;
  for (const c of document.querySelectorAll('[data-count]')) c.textContent = counts[c.dataset.count];
  const empty = (b, t) => `<div class="card flush"><div class="empty"><span class="ico">${icon('history')}</span><b>${b}</b><span>${t}</span></div></div>`;
  if (!historyRuns.length) { $('historyList').innerHTML = empty('No history yet', 'Every AI run, replay and workflow is recorded here, with its video and report.'); return; }
  if (!runs.length) { $('historyList').innerHTML = empty('No runs here', 'Nothing matches this filter. Show all runs or change the search.').replace('</div></div>', '<button type="button" class="btn ghost small" id="showAllRuns">Show all runs</button></div></div>'); return; }
  // who ran it: a schedule, plain Playwright, or the AI (provider · model)
  const who = r => r.schedule ? `Schedule · ${r.schedule}` : r.kind === 'replay' ? 'Playwright' : [r.provider, r.model].filter(Boolean).join(' · ') || 'AI';
  $('historyList').innerHTML = `<div class="list">${runs.map(r => {
    const kind = r.kind === 'replay' && r.testNames?.length > 1 ? 'Suite' : (KIND[r.kind] ?? KIND.replay)[1];
    return `<button type="button" class="item hist-row" data-id="${esc(r.id)}">
      ${statusPill(r.status)}
      <span class="item-text"><span class="title">${esc((r.title || (r.task ?? '').split('\n')[0]).slice(0, 140))}${r.issueCount ? ` <span class="tag fail">${r.issueCount} app error${r.issueCount > 1 ? 's' : ''}</span>` : ''}${r.a11yCount ? ` <span class="tag">♿ ${r.a11yCount}</span>` : ''}</span>
        <span class="sub">${esc(kind)} · ${plural(r.stepCount ?? 0, 'step')} · ${esc(who(r))}</span></span>
      <span class="when hide-sm"><span class="row-meta">${esc(when(r.started))}</span><span class="row-meta">${dur(r.secs)}</span></span>
      ${icon('right')}
    </button>`;
  }).join('')}</div>`;
}
$('histSearch').oninput = renderHistory;
for (const b of document.querySelectorAll('[data-filter]')) b.onclick = () => {
  historyFilter = b.dataset.filter;
  for (const x of document.querySelectorAll('[data-filter]')) x.setAttribute('aria-pressed', String(x === b));
  renderHistory();
};
$('historyList').addEventListener('click', e => { if (e.target.closest('#showAllRuns')) { e.stopPropagation(); $('histSearch').value = ''; historyFilter = 'all'; for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b.dataset.filter === 'all')); renderHistory(); } }, true);
$('historyList').onclick = async e => {
  const b = e.target.closest('button.item'); if (!b) return;
  openPastRun(await api(`/history/${b.dataset.id}`));
};
// a finished run's full page (History, or Open result on a summary card); Back returns to `from`
function openPastRun(run, from = 'history') {
  origin = from;
  viewing = null; // runs in progress go on in the background (sidebar chips)
  $('rec').hidden = true; $('caption').hidden = true;
  openRunPage({ id: run.id, kind: run.kind, title: run.title, task: run.task ?? '', who: `${when(run.started)}${run.provider ? `, ${run.provider}` : ''}${run.session ? `, session ${run.session}` : ''}${run.instructions ? `, instructions ${run.instructions.name}` : ''}` });
  setRunButtons('history');
  stageMode('past', run);
  // a run with a PDF guide: its last step's screenshot on the stage (the video is in the head's Video button)
  stepFrame(run, -1).then(src => {
    if (src && pageMeta?.id === run.id) showShot(src, run.steps?.length ?? run.replaySteps.filter(st => !st.section).length, '');
  });
  current = run.kind === 'workflow'
    ? { kind: 'workflow', params: { workflow: run.workflow, params: JSON.stringify(run.params ?? {}), env: run.env ?? '', session: run.session ?? '', record: run.video ? '1' : '', guide: run.guide ? '1' : '', provider: settings.providers?.find(p => p.label === run.provider)?.id ?? '', model: run.model ?? '' } }
    : run.kind === 'fix'
    ? { kind: 'fix', params: { run: run.fixOf, test: run.testNames?.[0] ?? '', provider: settings.providers?.find(p => p.label === run.provider)?.id ?? '', model: run.model ?? '' } }
    : run.kind === 'ai'
    ? { kind: 'ai', params: { url: run.url, title: run.title ?? '', task: run.task, provider: settings.providers?.find(p => p.label === run.provider)?.id ?? '', model: run.model ?? '', session: run.session ?? '', record: run.video ? '1' : '', guide: run.guide ? '1' : '', flow: run.flow ?? '', env: run.env ?? '', expected: run.expected ?? '', instrRun: run.instructions ? run.id : '' } }
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
}

/* ---------- workflows ---------- */
const blockTitle = b => `${b.n}. ${b.label}${b.iteration ? ` (#${b.iteration})` : ''}`;
function addBlockResult(b) {
  const li = document.createElement('li');
  li.className = `blockres ${b.status}`;
  li.innerHTML = `<b>${b.status === 'pass' ? '✓' : '✗'} ${esc(b.label)}</b> <span class="muted">${dur(b.secs)}</span>${b.evidence ? `<div>${esc(b.evidence)}</div>` : ''}${b.output !== undefined ? `<pre class="code">${esc(JSON.stringify(b.output, null, 2).slice(0, 2000))}</pre>` : ''}`;
  $('steps').append(li);
  return li;
}
const studio = createStudio({ $, api, esc, askDialog, askLeave: () => askLeave('workflows'), project: () => project, onRun: (id, wf) => runWorkflow(id, wf), onClose: () => show('workflows'), toast, show: (v, o) => show(v, { ...o, force: o?.force ?? routing }), onSaved: id => { shownId = id; writeUrl(urlOf('studio', id), true); } });
let workflows = [];
async function loadWorkflows() {
  const [list, history] = await Promise.all([api(withProject('/workflows')), api(withProject('/history'))]);
  workflows = list;
  const last = id => history.find(r => r.kind === 'workflow' && r.workflow === id);
  // the chain of top-level blocks, each with its type's color
  const chain = types => (types ?? []).map((t, i) => `${i ? '<span class="arrow" aria-hidden="true">→</span>' : ''}<span class="tag"><span class="sw" style="background:var(--t-${esc(t)})"></span>${esc(BLOCKS[t]?.name ?? t)}</span>`).join('');
  $('wfList').innerHTML = `<div class="card flush">${list.length ? list.map(w => {
    const l = last(w.id);
    return `<div class="item wf-row" data-id="${esc(w.id)}">
      <span class="item-text wf-text">
        <span class="wf-name"><span class="title">${esc(w.name)}</span>${statusPill(l?.status)}</span>
        <span class="chain" aria-label="Blocks">${chain(w.types)}</span>
        <span class="sub">Last run ${l ? esc(when(l.started)) : 'Never'}</span>
      </span>
      <span class="ractions">
        <button type="button" class="btn ghost small" data-act="open" aria-label="Edit ${esc(w.name)}" title="Open in Workflow Studio">Edit</button>
        <button type="button" class="btn small" data-act="run"${w.params?.length ? ` title="Asks for ${esc(w.params.map(x => x.name).join(', '))}"` : ''}>${icon('play')}Run</button>
      </span>
    </div>`;
  }).join('') : `<div class="empty"><span class="ico">${icon('workflow')}</span><b>No workflows yet</b><span>Chain an AI task, a check and a saved test to cover a longer journey.</span></div>`}</div>`;
}
$('wfNew').onclick = () => studio.open(null);
$('wfRunOptions').onclick = () => { $('wfOptions').hidden = !$('wfOptions').hidden; $('wfRunOptions').setAttribute('aria-expanded', String(!$('wfOptions').hidden)); };
$('wfList').onclick = async e => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const act = btn.dataset.act, id = btn.closest('[data-id]').dataset.id, w = workflows.find(x => x.id === id);
  if (act === 'open') studio.open(id);
  if (act === 'run') runWorkflow(id, w);
  if (act === 'del' && await askDialog({ title: `Delete the workflow "${w.name}"?`, text: `The file tests/${project.id}/workflows/${id}.json will be removed.`, confirm: 'Delete', danger: true })) { await api(withProject(`/workflows/${id}`), { method: 'DELETE' }); loadWorkflows(); }
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
$('recUrl').addEventListener('blur', () => { if ($('recUrl').value.trim() || !$('recUrlErr').hidden) fieldErr($('recUrl'), $('recUrlErr'), urlMsg($('recUrl').value, false)); });
$('recForm').onsubmit = e => {
  e.preventDefault();
  if (!fieldErr($('recUrl'), $('recUrlErr'), urlMsg($('recUrl').value, false))) return $('recUrl').focus();
  const url = $('recUrl').value, session = $('recSession').value, env = $('recEnv').value;
  store.set({ recSession: session });
  storeProject({ recUrl: url, recEnv: env });
  $('recResult').hidden = true;
  $('recStart').disabled = true; $('recBusy').hidden = false; $('recIdle').hidden = true;
  $('recState').textContent = 'Opening the browser…';
  recEs = new EventSource('/record?' + new URLSearchParams({ project: project.id, url, session, env }));
  const end = () => { recEs.close(); $('recStart').disabled = false; $('recBusy').hidden = true; $('recIdle').hidden = false; };
  recEs.addEventListener('started', () => { $('recState').textContent = 'Recording. Click through the flow in the new browser window, then close that window.'; setStatus('Recording', 'run'); });
  recEs.addEventListener('fail', ev => { end(); $('recState').textContent = ''; setStatus('Ready'); showRecResult(null, JSON.parse(ev.data)); });
  recEs.addEventListener('done', ev => { end(); $('recState').textContent = ''; setStatus('Flow recorded', 'pass'); showRecResult(JSON.parse(ev.data)); });
  recEs.onerror = () => { if (!$('recBusy').hidden) { end(); setStatus('Recording: the connection to the app was lost'); } };
};
$('recStop').onclick = () => { $('recState').textContent = 'Stopping…'; fetch('/record/stop', { method: 'POST' }); };

function showRecResult(flow, error) {
  const r = $('recResult');
  r.hidden = false;
  if (!flow) { r.className = 'result fail'; r.innerHTML = `<h2>Nothing recorded</h2><p class="evidence">${esc(error)}</p>`; return; }
  const steps = (flow.script.match(/await page\./g) ?? []).length;
  r.className = 'card narrow record-card';
  r.innerHTML = `<div class="rec-head"><h2 class="card-title">Recorded script</h2><span class="pill pass">${icon('check')}${plural(steps, 'action')}</span></div>
    <p class="hint">Passwords stored under Settings → Secrets are replaced by <code>{{NAME}}</code>.</p>
    <pre class="code"></pre>
    <div class="actions">
      <button type="button" class="btn ghost" data-act="ai">${icon('sparkles')}Give to AI as route map</button>
      <button type="button" class="btn quiet" data-act="copy">Copy script</button>
    </div>`;
  r.querySelector('pre').textContent = flow.script;
  r.querySelector('[data-act=copy]').onclick = ev => navigator.clipboard.writeText(flow.script).then(() => { ev.target.textContent = 'Script copied'; });
  r.querySelector('[data-act=ai]').onclick = () => {
    attachFlow(flow.id);
    $('url').value = $('recUrl').value;
    if (!$('task').value.trim()) $('task').value = 'Follow the recorded flow and check that it completes successfully.';
    syncAiForm(); show('ai'); $('task').focus();
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
  editLoaded = { code, csv };
  await loadEditFiles();
  $('editDlg').showModal();
}
let editLoaded = null; // the script and data set as opened: leaving for Run AI asks before dropping changes
$('editInAi').onclick = async () => {
  if (($('editCode').value !== editLoaded?.code || $('editCsv').value !== editLoaded?.csv) && !await askDialog({ title: 'Leave the unsaved changes?', text: 'Leave the unsaved changes to this test and open it in Run AI?', confirm: 'Leave them', danger: true })) return;
  $('editDlg').close(); editInAi(editing);
};
// a failed list or delete shows in the dialog's error line; it never keeps the dialog from opening
async function loadEditFiles() {
  try {
    const files = await api(withProject(`/tests/${editing}/files`));
    renderFiles($('editFiles'), files, async n => {
      try { await api(withProject(`/tests/${editing}/files/${encodeURIComponent(n)}`), { method: 'DELETE' }); }
      catch (err) { $('editErr').textContent = err.message; }
      loadEditFiles();
    });
  } catch (err) { $('editErr').textContent = err.message; }
}
$('editFileIn').onchange = async e => {
  try { for (const f of e.target.files) await sendFile(withProject(`/tests/${editing}/files?name=${encodeURIComponent(f.name)}`), f); }
  catch (err) { $('editErr').textContent = err.message; }
  e.target.value = ''; loadEditFiles();
};
$('editCancel').onclick = $('editClose').onclick = () => $('editDlg').close();
$('editForm').onsubmit = async e => {
  e.preventDefault();
  try {
    await api(withProject(`/tests/${editing}`), { method: 'PUT', body: JSON.stringify({ code: $('editCode').value, csv: $('editCsv').value }) });
    $('editDlg').close(); setStatus('Test saved'); loadTests();
  } catch (err) { $('editErr').textContent = err.message; }
};
$('aiEnv').onchange = () => loadSettings(); // the environment's values become chips
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
// tablist keys (ARIA): arrows move, Home/End jump; the chosen tab takes the focus
document.querySelector('#sf .tabs').addEventListener('keydown', e => {
  const tabs = [...document.querySelectorAll('#sf .tab')], i = tabs.indexOf(document.activeElement); if (i < 0) return;
  const j = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (j === undefined) return;
  e.preventDefault(); const t = tabs[(j + tabs.length) % tabs.length]; selectTab(t); t.focus();
});
/* Appearance: per computer and applied at once; the <head> script in index.html owns the value */
const themeBtns = [...document.querySelectorAll('[data-theme-pick]')];
const markTheme = () => { for (const b of themeBtns) b.setAttribute('aria-pressed', String(b.dataset.themePick === window.__theme())); };
for (const b of themeBtns) b.onclick = () => { window.__setTheme(b.dataset.themePick); markTheme(); };
markTheme();
$('scroll').addEventListener('scroll', e => e.target.classList.toggle('scrolled', e.target.scrollTop > 4), { passive: true });

// One collapsible row per provider; API keys are write-only (server never returns them)
function providerRow(p = { engine: 'openai-compatible' }, open = false) {
  const d = document.createElement('details');
  d.className = 'prov provider'; d.open = open;
  d.dataset.id = p.id || ''; d.dataset.apiKeyEnv = p.apiKeyEnv || '';
  const cc = p.engine === 'claude-code';
  const needsKey = !cc && p.apiKeyEnv && !p.ready;
  const status = cc ? (p.account ? ['pass', 'Signed in'] : ['warn', 'Not signed in']) : needsKey ? ['warn', 'Needs a key'] : p.apiKeyEnv ? ['pass', 'Key saved'] : ['pass', 'Ready'];
  // the card's one line: whose subscription, or which endpoint and model
  const line = !p.id ? 'Not saved yet' : cc ? (p.account ? `Uses the subscription of ${p.account.email}` : 'Uses the subscription you are signed in with')
    : `${p.baseURL || 'No address yet'} · ${p.model || 'default model'}`;
  const initials = ((p.label || 'New').match(/[\p{L}\p{N}]+/gu) ?? ['?']).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const keyHint = p.apiKeyEnv ? (p.ready ? 'Saved. Fill in only to replace it.' : 'Not set yet') : 'Leave empty if not needed (e.g. Ollama)';
  d.innerHTML = `
    <summary><span class="prov-ico" aria-hidden="true">${esc(initials)}</span><span class="prov-text"><span class="prov-line"><span class="name"></span><span class="pill ${status[0]}">${status[0] === 'pass' ? icon('check') : icon('alert')}${status[1]}</span></span><span class="sub">${esc(line)}</span></span><span class="btn ghost small">Configure</span></summary>
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
// tab: ai, secret, env, sched, guide, rec or look (#/settings/<tab>)
const openSettings = async tab => {
  if (!routing && !(await askLeave('settings'))) return;
  if ($('view-settings').hidden) await renderSettings(); // already open (Forward, a tab's address): what was typed stays
  selectTab($(`tab${typeof tab === 'string' && /^[a-z]+$/.test(tab) ? tab[0].toUpperCase() + tab.slice(1) : 'Ai'}Btn`) ?? $('tabAiBtn'));
  show('settings', { id: typeof tab === 'string' ? tab : undefined, force: true });
};
for (const b of document.querySelectorAll('.openSettings')) b.onclick = () => openSettings();

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
$('discardP').onclick = () => renderSettings().then(() => toast('Changes discarded'));
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
      <label class="chip prod" title="Its addresses are blocked in every test browser"><input type="checkbox" name="eprod"><span><svg class="i" aria-hidden="true"><use href="#i-lock"/></svg>Production<span class="on"> · blocked in tests</span></span></label>
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
