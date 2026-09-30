// Shared by the UI (served at /shared.mjs) and the HTML report.

export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Minimal, escaped markdown for AI text: paragraphs, bullet lists, **bold**, `code`
export function md(src) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>'); // addresses become links
  const out = []; let list = null;
  for (const line of String(src).split('\n')) {
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (m) { (list ??= []).push(`<li>${inline(m[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

// Did the AI confirm the user's expected result? true / false / null (no expectation, or no verdict line)
export const expectedVerdict = text => { const m = String(text).match(/EXPECTED:\s*(NOT\s+)?MET/i); return m ? !m[1] : null; };

// AI answer → { evidence, script }: drops the RESULT/EXPECTED lines and pulls out the generated test
export function splitAnswer(text = '') {
  const script = text.match(/```(?:ts|typescript|js|javascript)?\n([\s\S]*?)```/)?.[1] ?? null;
  const evidence = text.replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*\d*\.?\s*\**RESULT:\s*\w+\**\s*/i, '')
    .replace(/^\s*\**EXPECTED:\s*(NOT\s+)?MET\**\s*[.:,;\-–—]?\s*/i, '')
    .trim();
  return { evidence, script };
}

// Line diff (LCS) between a test and its AI fix, as HTML: removed lines first, then added
export function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  const L = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0, added = 0, removed = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { out.push(`<span>  ${esc(x[i])}</span>`); i++; j++; }
    else if (i < x.length && (j >= y.length || L[i + 1][j] >= L[i][j + 1])) { out.push(`<span class="del">- ${esc(x[i])}</span>`); i++; removed++; } // removed lines first
    else { out.push(`<span class="add">+ ${esc(y[j])}</span>`); j++; added++; }
  }
  return { html: out.join(''), added, removed };
}

// Same test (and data row) both passing and failing across repeats = flaky: timing, not a real break
export function flakyOf(tests) {
  const groups = new Map();
  for (const t of tests) {
    const k = `${t.file}|${t.title}|${t.row ?? ''}`;
    const g = groups.get(k) ?? { file: t.file, title: t.title, row: t.row, passed: 0, total: 0 };
    g.total++; if (t.status === 'passed') g.passed++;
    groups.set(k, g);
  }
  return [...groups.values()].filter(g => g.total > 1 && g.passed > 0 && g.passed < g.total);
}

// Problems seen during a run (console errors, failed requests)
export const issueLabel = i => ({ console: 'Console error', exception: 'JavaScript error', http: `HTTP ${i.status}`, failed: 'Request failed', a11y: `Accessibility (${i.impact})` }[i.kind] ?? i.kind);
// three kinds of findings, shown separately: errors from the app, from third-party sites, accessibility
export const isA11y = i => i.kind === 'a11y';
export const isAppError = i => !i.thirdParty && !isA11y(i);
export const isThirdParty = i => i.thirdParty && !isA11y(i);
export const issueDetail = i => (i.kind === 'http' || i.kind === 'failed' ? `${i.method ?? ''} ${i.url ?? ''}`.trim() : i.kind === 'a11y' ? `${i.text} on ${i.url}` : i.text);
export function issuesTable(issues, esc) {
  return `<table class="issues"><tbody>${issues.map(i => `<tr><td class="kind">${esc(issueLabel(i))}${i.count > 1 ? ` ×${i.count}` : ''}</td><td>${esc(issueDetail(i))}${i.kind === 'failed' ? `<br><small>${esc(i.text)}</small>` : ''}</td><td class="at">${i.at ?? 0} s</td></tr>`).join('')}</tbody></table>`;
}

// Plain-language labels for Playwright MCP tool calls
const STEPS = {
  browser_navigate: ['Open page', i => i.url],
  browser_navigate_back: ['Go back'],
  browser_snapshot: ['Read the page'],
  browser_click: ['Click', i => i.element ?? i.target],
  browser_hover: ['Hover', i => i.element ?? i.target],
  browser_type: ['Type', i => `${i.element ?? i.target ?? ''} → “${i.text}”`],
  browser_fill_form: ['Fill form', i => i.fields?.map(f => f.name).join(', ')],
  browser_select_option: ['Select option', i => `${i.element ?? ''} → ${[].concat(i.values ?? []).join(', ')}`],
  browser_press_key: ['Press key', i => i.key],
  browser_wait_for: ['Wait', i => i.text ? `for “${i.text}”` : i.textGone ? `for “${i.textGone}” to disappear` : i.time ? `${i.time} s` : ''],
  browser_find: ['Find on page', i => i.text ?? i.regex],
  browser_evaluate: ['Check with a script'],
  browser_take_screenshot: ['Take screenshot'],
  browser_console_messages: ['Check browser console'],
  browser_network_requests: ['Check network requests'],
  browser_tabs: ['Manage tabs'],
  browser_file_upload: ['Upload file'],
  browser_handle_dialog: ['Handle dialog', i => i.accept ? 'accept' : 'dismiss'],
  browser_drag: ['Drag element'],
  browser_resize: ['Resize window'],
  browser_close: ['Close browser'],
};

export function describe({ name, input }) {
  const [what, fn] = STEPS[name] ?? [String(name).replace(/^browser_/, '').replaceAll('_', ' ')];
  let detail = '';
  try { detail = fn?.(input ?? {}) ?? ''; } catch {}
  return { what, detail: String(detail) };
}
