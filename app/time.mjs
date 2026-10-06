// Times as the mockup shows them: relative within a week, a short date before that; durations as 1m 52s
const pad = n => String(n).padStart(2, '0');
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
export function when(ts, now = Date.now()) {
  if (ts === undefined || ts === null || Number.isNaN(+ts)) return '';
  const d = new Date(ts), n = new Date(now), days = Math.round((day(n) - day(d)) / 86_400_000);
  if (now >= ts && now - ts <= 60_000) return 'Just now';
  if (days === 0) return `Today, ${hm(d)}`;
  if (days === 1) return `Yesterday, ${hm(d)}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString('en-US', { weekday: 'short' })}, ${hm(d)}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== n.getFullYear() && { year: 'numeric' }) });
}
export function dur(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor(s % 3600 / 60))}m`;
}
