import { isAppError, isA11y } from './shared.mjs';

// Run notifications. Telegram: message + the HTML report as a file. Slack: message (incoming webhook).
// Tokens are secrets: TELEGRAM_TOKEN (bot token) and SLACK_WEBHOOK (webhook URL); the Telegram chat id is a setting.

export function summary(run, title) {
  const tests = run.tests ?? [];
  const passed = tests.filter(t => t.status === 'passed').length;
  const icon = run.status === 'pass' ? '✅' : '❌';
  const lines = [`${icon} ${title}: ${run.status === 'pass' ? 'passed' : 'FAILED'} (${passed}/${tests.length} tests, ${run.secs ?? 0} s)`];
  for (const t of tests.filter(x => x.status !== 'passed').slice(0, 10))
    lines.push(`• ${t.title}${t.row ? ` (row ${t.row})` : ''}: ${(t.error ?? t.status).split('\n')[0].slice(0, 160)}`);
  if (run.error) lines.push(`• ${run.error.slice(0, 200)}`);
  if (run.flaky?.length) lines.push(`⚠ Flaky: ${run.flaky.map(f => f.title).join(', ')}`);
  const appErrors = (run.issues ?? []).filter(isAppError).length;
  if (appErrors) lines.push(`⚠ ${appErrors} error(s) from the application (console/network)`);
  const a11y = (run.issues ?? []).filter(isA11y).length;
  if (a11y) lines.push(`♿ ${a11y} accessibility problem(s)`);
  return lines.join('\n');
}

export async function notify({ telegramChatId }, text, report) {
  const sent = [];
  const token = process.env.SECRET_TELEGRAM_TOKEN;
  if (token && telegramChatId) {
    const api = `https://api.telegram.org/bot${token}`;
    const r = await fetch(`${api}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: telegramChatId, text }) });
    if (!r.ok) throw new Error(`Telegram: ${(await r.json().catch(() => ({}))).description ?? r.status}`);
    if (report) {
      const form = new FormData();
      form.append('chat_id', String(telegramChatId));
      form.append('document', new Blob([report.html], { type: 'text/html' }), report.name);
      const d = await fetch(`${api}/sendDocument`, { method: 'POST', body: form });
      if (!d.ok) throw new Error(`Telegram (report): ${(await d.json().catch(() => ({}))).description ?? d.status}`);
    }
    sent.push('Telegram');
  }
  const webhook = process.env.SECRET_SLACK_WEBHOOK;
  if (webhook) {
    const r = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error(`Slack: HTTP ${r.status}`);
    sent.push('Slack');
  }
  return sent;
}
