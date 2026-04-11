// ── render.js (Phase 2) ───────────────────────────────────────────────────────
// Plus aucune manipulation DOM directe pour les listes/stats.
// Toutes les données sont poussées dans window.app (Alpine réactif).
// Restent ici : calculs métier, startLastFeedTick, renderAll, tlNav.
// ─────────────────────────────────────────────────────────────────────────────

function todayLogs() {
  const t = new Date().toDateString();
  return allLogs.filter(l => new Date(l.timestamp || l.start).toDateString() === t);
}

// ── DERNIÈRE TÉTÉE ────────────────────────────────────────────────────────────
function startLastFeedTick() {
  stopTick(TICK_LAST_FEED);
  const sorted = allLogs.filter(l => l.type === 'feed')
    .sort((a,b) => (b.end||b.timestamp) - (a.end||a.timestamp));
  if (!window.app) return;
  if (breastActive.left || breastActive.right || !sorted.length) {
    window.app.showLastFeed = false; return;
  }
  const lastEnd = sorted[0].end || sorted[0].timestamp;
  window.app.showLastFeed = true;
  startTick(TICK_LAST_FEED, () => {
    if (window.app) window.app.lastFeedText = `Dernière tétée : ${fmtAgo(Date.now() - lastEnd)}`;
  });
}

// ── ALLAITEMENT ───────────────────────────────────────────────────────────────
function renderFeed() {
  const app = window.app; if (!app) return;
  const tl = todayLogs().filter(l => l.type === 'feed');
  app.feedCount = tl.length;
  app.feedTotal = fmtDur(tl.reduce((a,l) => a + (l.duration||0), 0));
  ['left','right'].forEach(side => {
    const last = [...tl].filter(l => l.side === side).pop();
    app['last' + (side === 'left' ? 'Left' : 'Right')] =
      last ? `${fmtTime(last.start)} · ${fmtDur(last.duration)}` : '';
  });
  app.feedGroups = groupByDay(
    allLogs.filter(l => l.type === 'feed')
      .sort((a,b) => (b.start||b.timestamp) - (a.start||a.timestamp))
  );
  startLastFeedTick();
}

// ── SOMMEIL ───────────────────────────────────────────────────────────────────
function renderSleep() {
  const app = window.app; if (!app) return;
  const tl = todayLogs().filter(l => l.type === 'sleep');
  app.sleepCount = tl.length;
  app.sleepTotal = fmtDur(tl.reduce((a,l) => a + (l.duration||0), 0));
  app.sleepGroups = groupByDay(
    allLogs.filter(l => l.type === 'sleep')
      .sort((a,b) => (b.start||b.timestamp) - (a.start||a.timestamp))
  );
}

// ── COUCHES ───────────────────────────────────────────────────────────────────
function renderDiapers() {
  const app = window.app; if (!app) return;
  const tl = todayLogs().filter(l => l.type === 'diaper');
  app.diaperWet   = tl.filter(l => l.diaperType === 'wet').length;
  app.diaperDirty = tl.filter(l => l.diaperType === 'dirty').length;
  app.diaperGroups = groupByDay(
    allLogs.filter(l => l.type === 'diaper').sort((a,b) => b.timestamp - a.timestamp)
  );
}

// ── TIMELINE ─────────────────────────────────────────────────────────────────
function tlNav(delta) {
  const newIdx = tlDayIndex + delta;
  if (newIdx < 0 || newIdx >= tlDays.length) return;
  if (window.app) window.app.tlSwiping = true;
  setTimeout(() => { tlDayIndex = newIdx; renderTimeline(); if (window.app) window.app.tlSwiping = false; }, 150);
}

function renderTimeline() {
  const app = window.app; if (!app) return;

  const byDay = {};
  allLogs.forEach(l => {
    const k = new Date(l.timestamp || l.start).toDateString();
    if (!byDay[k]) byDay[k] = [];
    byDay[k].push(l);
  });
  tlDays = Object.keys(byDay).sort((a,b) => new Date(b) - new Date(a));

  if (!tlDays.length) {
    app.tlEmpty = true; app.tlNavLabel = '—'; return;
  }
  app.tlEmpty = false;
  tlDayIndex = Math.max(0, Math.min(tlDayIndex, tlDays.length - 1));

  app.tlNavLabel     = fmtDayLabel(new Date(tlDays[tlDayIndex]));
  app.tlPrevDisabled = (tlDayIndex >= tlDays.length - 1);
  app.tlNextDisabled = (tlDayIndex <= 0);

  const toPct = ts => {
    const d = new Date(ts);
    return +((d.getHours()*3600 + d.getMinutes()*60 + d.getSeconds()) / 86400 * 100).toFixed(3);
  };
  const toWPct = ms => Math.max(0.8, +(ms / 86400000 * 100).toFixed(3));

  const logs = byDay[tlDays[tlDayIndex]];
  const fl = logs.filter(l => l.type === 'feed');
  const sl = logs.filter(l => l.type === 'sleep');
  const dl = logs.filter(l => l.type === 'diaper');

  app.tlHasFeed    = fl.length > 0;
  app.tlHasSleep   = sl.length > 0;
  app.tlHasDiaper  = dl.length > 0;
  app.tlFeedBars   = fl.map(l => ({ id:l.id, side:l.side, left:toPct(l.start), width:toWPct(l.duration) }));
  app.tlSleepBars  = sl.map(l => ({ id:l.id, left:toPct(l.start), width:toWPct(l.duration) }));
  app.tlDiaperDots = dl.map(l => ({ id:l.id, type:l.diaperType, left:toPct(l.timestamp) }));
}

function renderAll() {
  renderFeed();
  renderSleep();
  renderDiapers();
  if (currentTab === 'timeline') renderTimeline();
}

// ── PROFILS & EMOJIS ──────────────────────────────────────────────────────────
/** Copie `profiles` dans Alpine pour le x-for de la modale profils. */
function renderProfileList() {
  if (window.app) window.app.profileList = profiles.map(p => ({ ...p }));
}

/** Met à jour l'emoji sélectionné (grille en x-for). */
function renderEmojiGrid(selected) {
  if (window.app) window.app.selectedEmoji = selected;
}
