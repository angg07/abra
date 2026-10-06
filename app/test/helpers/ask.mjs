// Tests answer ABRA's confirmation dialog (#askDlg) the way they used to answer the browser's confirm():
// answerAsks(page, 'ok' | 'cancel' | null) keeps answering every one that opens, also after a reload
const install = answer => {
  window.__ask = answer;
  if (window.__askTimer) return;
  window.__askTimer = setInterval(() => {
    const d = document.getElementById('askDlg');
    if (!d?.open || d.dataset.logged === 'y' && !window.__ask) return;
    if (d.dataset.logged !== 'y') { d.dataset.logged = 'y'; (window.__askLog ??= []).push(`${d.querySelector('#askTitle').textContent} ${d.querySelector('#askText').textContent}`); d.addEventListener('close', () => { d.dataset.logged = ''; }, { once: true }); }
    if (!window.__ask) return;
    const input = d.querySelector('#askInput');
    if (!d.querySelector('#askTypeWrap').hidden && window.__ask === 'ok') { input.value = d.querySelector('#askTypeLabel').textContent.replace(/^Type | to confirm$/g, ''); input.dispatchEvent(new Event('input')); }
    d.querySelector(`[data-ask=${window.__ask}]`)?.click();
  }, 30);
};
export async function answerAsks(page, answer = 'ok') {
  if (!page.__askInit) { page.__askInit = true; await page.addInitScript(() => { window.__ask = window.__ask ?? null; }); await page.addInitScript(install, answer); }
  page.__askAnswer = answer;
  await page.evaluate(install, answer).catch(() => {});
}
// the title and text of every confirmation shown on this page so far
export const askLog = page => page.evaluate(() => window.__askLog ?? []);
// waits until a confirmation whose title or text matches was shown
export const waitAsk = (page, re) => page.waitForFunction(src => (window.__askLog ?? []).some(x => new RegExp(src).test(x)), re.source, { timeout: 10_000 });
