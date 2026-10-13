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

/** Midnight timestamp (ms) for the local day containing `ts` (defaults to now). */
function startOfDay(ts) {
  const d = new Date(ts === undefined ? Date.now() : ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Midnight timestamp (ms) for today. */
function todayStart() {
  return startOfDay(Date.now());
}

/** Add `n` calendar days to a timestamp (DST-safe), returning midnight of the result. */
function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── CHRONOS ET JOURNÉES ──────────────────────────────────────────────────────
// Un chrono (tétée, sommeil) occupe la plage [start, start + duration].
// Il appartient à chaque journée locale qu'il chevauche, et pas seulement à celle
// où il commence ou finit. Un point (couche, biberon) appartient au jour de son timestamp.

/** Plage d'un chrono [start, start + duration], ou null pour un point. Valeurs forcées en nombres. */
function spanOf(l) {
  if (l.start === undefined || l.start === null) return null;
  const start = Number(l.start);
  return { start, end: start + (Number(l.duration) || 0) };
}

/** Instant représentatif : le début pour un chrono, le timestamp pour un point. */
function anchorOf(l) {
  const sp = spanOf(l);
  return sp ? sp.start : Number(l.timestamp);
}

/** Le log apparaît-il sur la journée commençant à dayStart (minuit local) ? */
function logOnDay(l, dayStart) {
  const dayEnd = addDays(dayStart, 1);
  const sp = spanOf(l);
  if (!sp) {
    const t = Number(l.timestamp);
    return t >= dayStart && t < dayEnd;
  }
  if (sp.end > sp.start) return sp.start < dayEnd && sp.end > dayStart;
  return sp.start >= dayStart && sp.start < dayEnd;   // chrono de durée nulle
}

/** Découpe un chrono en morceaux, un par journée locale traversée. [] pour un point. */
function splitByDay(l) {
  const sp = spanOf(l);
  if (!sp) return [];
  if (sp.end <= sp.start) {
    return [{ dayStart: startOfDay(sp.start), start: sp.start, end: sp.start, duration: 0 }];
  }
  const pieces = [];
  let day = startOfDay(sp.start);
  while (day < sp.end) {
    const next = addDays(day, 1);            // minuit suivant, exact même un jour de changement d'heure
    const s = Math.max(sp.start, day);
    const e = Math.min(sp.end, next);
    if (e > s) pieces.push({ dayStart: day, start: s, end: e, duration: e - s });
    day = next;
  }
  return pieces;
}

/** Morceau d'un chrono tombant sur la journée dayStart, ou null. */
function partOnDay(l, dayStart) {
  return splitByDay(l).find(p => p.dayStart === dayStart) || null;
}

/** Realtime envoie les bigint sous forme de chaînes : on les ramène en nombres. */
function normalizeLogRow(r) {
  const out = { ...r };
  ['start', 'end', 'duration', 'timestamp', 'volume'].forEach(k => {
    if (out[k] !== null && out[k] !== undefined && out[k] !== '') out[k] = Number(out[k]);
  });
  return out;
}
