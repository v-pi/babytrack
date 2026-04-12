// ── js/utils.js ─────────────────────────────────────────────────────────────
// Pure formatting helpers – no DOM, no state, no side effects.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a duration (milliseconds) into a human-readable string.
 *  < 1 h  →  "4m 32s"
 *  ≥ 1 h  →  "1h 23m"
 */
function fmtDur(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const s   = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m   = totalMin % 60;
  const h   = Math.floor(totalMin / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

/** "14:32" */
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** "14:32" (zero-padded, no locale) */
function fmtHM(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/** "2025-06-01" */
function fmtYMD(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/** "Aujourd'hui" / "Hier" / "lundi 1 juin" */
function fmtDayLabel(d) {
  const today = new Date();
  const yest  = new Date(today); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === yest.toDateString())  return 'Hier';
  return d.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' });
}

/**
 * "il y a Xm Ys" / "il y a Xh Ym"
 * Compact version for "since last feed" display.
 */
function fmtAgo(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `il y a ${h}h ${String(m % 60).padStart(2,'0')}m`;
  return `il y a ${m}m ${String(totalSec % 60).padStart(2,'0')}s`;
}

/** Group an array of logs by calendar day, most recent day first. */
function groupByDay(logs) {
  const byDay = {};
  logs.forEach(l => {
    const key = new Date(l.timestamp || l.start).toDateString();
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push(l);
  });
  return Object.keys(byDay)
    .sort((a, b) => new Date(b) - new Date(a))
    .map(key => ({ label: fmtDayLabel(new Date(key)), logs: byDay[key].slice().reverse() }));
}

/**
 * Escape a string for safe insertion into HTML (prevents XSS).
 * Use whenever user-supplied data is concatenated into innerHTML.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Combine a "YYYY-MM-DD" date string and a "HH:MM" time string into a timestamp (ms). */
function combineDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min]  = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, h, min).getTime();
}
