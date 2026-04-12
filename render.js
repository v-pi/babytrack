// ── render.js ─────────────────────────────────────────────────────────────────
// All DOM rendering: feed, sleep, diapers, timeline, profile list, emoji grid.
// Depends on globals from state.js and helpers from utils.js.
// ─────────────────────────────────────────────────────────────────────────────

function todayLogs() {
  const t = new Date().toDateString();
  return allLogs.filter(l => new Date(l.timestamp || l.start).toDateString() === t);
}

function startLastFeedTick() {
  stopTick(TICK_LAST_FEED);
  const feedLogs = allLogs.filter(l => l.type === 'feed').sort((a,b) => (b.end||b.timestamp)-(a.end||a.timestamp));
  const el = document.getElementById('last-feed-global');
  if (!el) return;
  if (breastActive.left || breastActive.right) { el.classList.remove('visible'); return; }
  if (!feedLogs.length) { el.classList.remove('visible'); return; }
  const lastEnd = feedLogs[0].end || feedLogs[0].timestamp;
  el.classList.add('visible');
  startTick(TICK_LAST_FEED, () => {
    el.textContent = 'Dernière tétée : ' + fmtAgo(Date.now() - lastEnd);
  });
}

// ── UNIFIED DAY NAV ───────────────────────────────────────────────────────────
function getHistDays(logs) {
  const keys = [...new Set(logs.map(l => new Date(l.timestamp || l.start).toDateString()))];
  return keys.sort((a, b) => new Date(b) - new Date(a));
}

function renderDayNav(section, idx, days) {
  const label = days[idx] === '—' ? '—' : fmtDayLabel(new Date(days[idx]));
  return '<div class="day-nav">' +
    '<button class="day-nav-btn" onclick="dayNav(\'' + section + '\',+1)"' + (idx >= days.length - 1 ? ' disabled' : '') + '>&#8249;</button>' +
    '<span class="day-nav-label">' + label + '</span>' +
    '<button class="day-nav-btn" onclick="dayNav(\'' + section + '\',-1)"' + (idx <= 0 ? ' disabled' : '') + '>&#8250;</button>' +
    '</div>';
}

// ── FEED ─────────────────────────────────────────────────────────────────────
function renderFeed() {
  const tl = todayLogs().filter(l => l.type === 'feed');
  document.getElementById('sum-feed-count').textContent = tl.length;
  document.getElementById('sum-feed-total').textContent = fmtDur(tl.reduce((a,l) => a+(l.duration||0), 0));
  ['left','right'].forEach(side => {
    const sl  = tl.filter(l => l.side === side);
    const el  = document.getElementById('last-'+side);
    if (!sl.length) { el.textContent = ''; return; }
    const last = sl[sl.length-1];
    el.textContent = fmtTime(last.start) + ' · ' + fmtDur(last.duration);
  });
  const el   = document.getElementById('feed-history');
  const logs = allLogs.filter(l => l.type === 'feed');
  const days = getHistDays(logs);
  if (!days.length) { el.innerHTML = '<div class="empty-state">Aucune tétée enregistrée</div>'; startLastFeedTick(); return; }
  histDay.feed = Math.max(0, Math.min(histDay.feed, days.length - 1));
  const dayLogs = logs
    .filter(l => new Date(l.timestamp || l.start).toDateString() === days[histDay.feed])
    .sort((a, b) => (b.start || b.timestamp) - (a.start || a.timestamp));
  el.innerHTML = renderDayNav('feed', histDay.feed, days) +
    '<div class="history-list">' +
    (dayLogs.length ? dayLogs.map(l =>
      '<div class="history-item' + (pendingSyncIds.has(l.id) ? ' pending' : '') + '" onclick="openEdit(\'' + l.id + '\')">' +
      '<div class="h-dot ' + l.side + '"></div>' +
      '<div class="h-main"><div class="h-label">Sein ' + (l.side==='left'?'gauche':'droit') + '</div>' +
      '<div class="h-range">' + fmtTime(l.start) + ' → ' + fmtTime(l.end) + '</div></div>' +
      '<div class="h-dur">' + fmtDur(l.duration) + '</div><div class="h-edit-hint">✎</div>' +
      '</div>'
    ).join('') : '<div class="empty-state">Aucune tétée ce jour</div>') + '</div>';
  startLastFeedTick();
}

// ── SLEEP ─────────────────────────────────────────────────────────────────────
function renderSleep() {
  const tl = todayLogs().filter(l => l.type === 'sleep');
  document.getElementById('sum-sleep-count').textContent = tl.length;
  document.getElementById('sum-sleep-total').textContent = fmtDur(tl.reduce((a,l) => a+(l.duration||0), 0));
  const el   = document.getElementById('sleep-history');
  const logs = allLogs.filter(l => l.type === 'sleep');
  const days = getHistDays(logs);
  if (!days.length) { el.innerHTML = '<div class="empty-state">Aucun sommeil enregistré</div>'; return; }
  histDay.sleep = Math.max(0, Math.min(histDay.sleep, days.length - 1));
  const dayLogs = logs
    .filter(l => new Date(l.timestamp || l.start).toDateString() === days[histDay.sleep])
    .sort((a, b) => (b.start || b.timestamp) - (a.start || a.timestamp));
  el.innerHTML = renderDayNav('sleep', histDay.sleep, days) +
    '<div class="history-list">' +
    (dayLogs.length ? dayLogs.map(l =>
      '<div class="history-item' + (pendingSyncIds.has(l.id) ? ' pending' : '') + '" onclick="openEdit(\'' + l.id + '\')">' +
      '<div class="h-dot sleep"></div>' +
      '<div class="h-main"><div class="h-label">Sommeil</div>' +
      '<div class="h-range">' + fmtTime(l.start) + ' → ' + fmtTime(l.end) + '</div></div>' +
      '<div class="h-dur">' + fmtDur(l.duration) + '</div><div class="h-edit-hint">✎</div>' +
      '</div>'
    ).join('') : '<div class="empty-state">Aucun sommeil ce jour</div>') + '</div>';
}

// ── DIAPERS ───────────────────────────────────────────────────────────────────
function renderDiapers() {
  const tl = todayLogs().filter(l => l.type === 'diaper');
  document.getElementById('diaper-wet-count').textContent   = tl.filter(l => l.diaperType === 'wet').length;
  document.getElementById('diaper-dirty-count').textContent = tl.filter(l => l.diaperType === 'dirty').length;
  const el   = document.getElementById('diaper-history');
  const logs = allLogs.filter(l => l.type === 'diaper');
  const days = getHistDays(logs);
  if (!days.length) { el.innerHTML = '<div class="empty-state">Aucun changement enregistré</div>'; return; }
  histDay.diaper = Math.max(0, Math.min(histDay.diaper, days.length - 1));
  const dayLogs = logs
    .filter(l => new Date(l.timestamp || l.start).toDateString() === days[histDay.diaper])
    .sort((a, b) => b.timestamp - a.timestamp);
  el.innerHTML = renderDayNav('diaper', histDay.diaper, days) +
    '<div class="history-list">' +
    (dayLogs.length ? dayLogs.map(l =>
      '<div class="history-item' + (pendingSyncIds.has(l.id) ? ' pending' : '') + '" onclick="openEdit(\'' + l.id + '\')">' +
      '<div class="h-dot ' + l.diaperType + '"></div>' +
      '<div class="h-main"><div class="h-label">' + (l.diaperType==='wet'?'💧 Pipi':'💩 Selle') + '</div>' +
      '<div class="h-range">' + fmtTime(l.timestamp) + '</div></div>' +
      '<div class="h-edit-hint">✎</div>' +
      '</div>'
    ).join('') : '<div class="empty-state">Aucun changement ce jour</div>') + '</div>';
}

// ── TIMELINE ─────────────────────────────────────────────────────────────────
function renderTimeline() {
  const c = document.getElementById('timeline-container');
  const navEl = document.getElementById('tl-day-nav');
  const byDay = {};
  allLogs.forEach(l => {
    const k = new Date(l.timestamp || l.start).toDateString();
    if (!byDay[k]) byDay[k] = [];
    byDay[k].push(l);
  });
  tlDays = Object.keys(byDay).sort((a,b) => new Date(b) - new Date(a));
  if (!tlDays.length) {
    c.innerHTML = '<div class="empty-state">Aucune donnée</div>';
    if (navEl) navEl.innerHTML = renderDayNav('timeline', 0, ['—']);
    return;
  }
  tlDayIndex = Math.max(0, Math.min(tlDayIndex, tlDays.length - 1));
  if (navEl) navEl.innerHTML = renderDayNav('timeline', tlDayIndex, tlDays);

  const logs = byDay[tlDays[tlDayIndex]];
  const pct  = ts => +((new Date(ts).getHours()*3600+new Date(ts).getMinutes()*60+new Date(ts).getSeconds())*1000/86400000*100).toFixed(3);
  const dpct = ms => Math.max(0.8, +(ms/86400000*100).toFixed(3));
  const ticksHtml = [0,6,12,18,24].map(h =>
    '<div class="tl-tick" style="left:' + (h/24*100).toFixed(1) + '%"><div class="tl-tick-line"></div><div class="tl-tick-lbl">' + String(h).padStart(2,'0') + 'h</div></div>'
  ).join('');
  const fl = logs.filter(l => l.type === 'feed');
  const sl = logs.filter(l => l.type === 'sleep');
  const dl = logs.filter(l => l.type === 'diaper');
  c.innerHTML = '<div class="timeline-day"><div class="tl-body" style="padding-top:20px">' +
    '<div class="tl-ticks-row"><div class="tl-tick-spacer"></div><div class="tl-ticks">' + ticksHtml + '</div></div>' +
    (fl.length ? '<div class="tl-row"><div class="tl-row-label">🤱</div><div class="tl-track feed-track">' + fl.map(l=>'<div class="tl-bar ' + l.side + '" style="left:' + pct(l.start) + '%;width:' + dpct(l.duration) + '%"></div>').join('') + '</div></div>' : '') +
    (sl.length ? '<div class="tl-row"><div class="tl-row-label">🌙</div><div class="tl-track sleep-track">' + sl.map(l=>'<div class="tl-bar sleep" style="left:' + pct(l.start) + '%;width:' + dpct(l.duration) + '%"></div>').join('') + '</div></div>' : '') +
    (dl.length ? '<div class="tl-row"><div class="tl-row-label">💧</div><div class="tl-track diaper-track">' + dl.map(l=>'<div class="tl-dot ' + l.diaperType + '" style="left:' + pct(l.timestamp) + '%"></div>').join('') + '</div></div>' : '') +
    '</div></div>';
}

// ── BOTTLE ────────────────────────────────────────────────────────────────────
function renderBottle() {
  const tl = todayLogs().filter(l => l.type === 'bottle');
  document.getElementById('sum-bottle-count').textContent = tl.length;
  document.getElementById('sum-bottle-total').textContent = tl.reduce((a, l) => a + (l.volume || 0), 0) + ' ml';

  const el   = document.getElementById('bottle-history');
  const logs = allLogs.filter(l => l.type === 'bottle');
  const days = getHistDays(logs);
  if (!days.length) { el.innerHTML = '<div class="empty-state">Aucun biberon enregistré</div>'; return; }
  histDay.bottle = Math.max(0, Math.min(histDay.bottle || 0, days.length - 1));
  const dayLogs = logs
    .filter(l => new Date(l.timestamp).toDateString() === days[histDay.bottle])
    .sort((a, b) => b.timestamp - a.timestamp);
  el.innerHTML = renderDayNav('bottle', histDay.bottle, days) +
    '<div class="history-list">' +
    (dayLogs.length ? dayLogs.map(l =>
      '<div class="history-item' + (pendingSyncIds.has(l.id) ? ' pending' : '') + '" onclick="openEdit(\'' + l.id + '\')">' +
      '<div class="h-dot bottle"></div>' +
      '<div class="h-main"><div class="h-label">🍼 ' + (l.volume || 0) + ' ml</div>' +
      '<div class="h-range">' + fmtTime(l.timestamp) + '</div></div>' +
      '<div class="h-edit-hint">✎</div>' +
      '</div>'
    ).join('') : '<div class="empty-state">Aucun biberon ce jour</div>') + '</div>';
}

/** Render only the currently visible tab. Call this after any data mutation. */
function renderCurrentTab() {
  if      (currentTab === 'feed')     renderFeed();
  else if (currentTab === 'bottle')   renderBottle();
  else if (currentTab === 'sleep')    renderSleep();
  else if (currentTab === 'diaper')   renderDiapers();
  else if (currentTab === 'timeline') renderTimeline();
  else if (currentTab === 'stats')    renderStats();
}

// ── STATS ─────────────────────────────────────────────────────────────────────
function niceMax(val, isFloat) {
  if (!val || val <= 0) return isFloat ? 2 : 10;
  if (isFloat) {
    const steps = [0.5,1,2,4,6,8,10,12,16,20,24];
    return steps.find(v => v >= val * 1.15) || Math.ceil(val * 1.2);
  }
  const steps = [2,5,8,10,12,15,20,25,30,40,50,60,80,100,120,150,200];
  return steps.find(v => v >= val * 1.15) || Math.ceil(val * 1.2);
}

function buildBarSVG(data, { yMax, yUnit, N, hasMixed }) {
  const W = 340, H = 130;
  const padL = 30, padR = 4, padT = 8, padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const gap = 1.5;
  const barW = (plotW - gap * (N - 1)) / N;
  const ticks = 4;
  const tickStep = yMax / ticks;

  let defs = hasMixed
    ? `<defs><linearGradient id="mix-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="50%" stop-color="var(--blue)"/><stop offset="50%" stop-color="var(--amber)"/>
       </linearGradient></defs>`
    : '';

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block">${defs}`;

  // Grid lines + Y labels
  for (let i = 0; i <= ticks; i++) {
    const val = tickStep * i;
    const y = +(padT + plotH - (val / yMax) * plotH).toFixed(1);
    svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border)" stroke-width="0.6"/>`;
    let lbl;
    if (val === 0) lbl = '0';
    else if (isFloat(val)) lbl = val.toFixed(1) + (i === ticks && yUnit ? yUnit : '');
    else lbl = Math.round(val) + (i === ticks && yUnit ? yUnit : '');
    svg += `<text x="${padL - 3}" y="${y + 3}" text-anchor="end" font-size="7" fill="var(--text-muted)" font-family="-apple-system,sans-serif">${lbl}</text>`;
  }

  // Bars
  const today = new Date();
  data.forEach((item, i) => {
    const x = +(padL + i * (barW + gap)).toFixed(2);
    let yBase = padT + plotH;
    item.segments.forEach(seg => {
      if (seg.val <= 0) return;
      const h = Math.max((seg.val / yMax) * plotH, 1);
      yBase -= h;
      svg += `<rect x="${x}" y="${yBase.toFixed(2)}" width="${Math.max(barW, 1).toFixed(2)}" height="${h.toFixed(2)}" fill="${seg.fill}" rx="1.5"/>`;
    });
    // X label: first, last, every 7th
    if (i === 0 || i === N - 1 || i % 7 === 0) {
      const d = new Date(today);
      d.setDate(today.getDate() - (N - 1 - i));
      const lbl = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
      svg += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle" font-size="7" fill="var(--text-muted)" font-family="-apple-system,sans-serif">${lbl}</text>`;
    }
  });

  svg += '</svg>';
  return svg;
}

function isFloat(n) { return n % 1 !== 0; }

function buildChartCard(title, legend, svgContent) {
  const legendHtml = legend.map(l =>
    `<div class="stats-leg-item"><span class="stats-leg-dot" style="${l.dotStyle}"></span>${l.label}</div>`
  ).join('');
  return `<div class="card stats-card">
    <div class="stats-card-header">
      <div class="card-title" style="margin-bottom:0">${title}</div>
      <div class="stats-legend">${legendHtml}</div>
    </div>
    <div class="stats-chart">${svgContent}</div>
  </div>`;
}

function renderStats() {
  const el = document.getElementById('stats-container');
  if (!el) return;

  const N = 30;
  const today = new Date();
  const days = [];
  for (let i = N - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push(d.toDateString());
  }

  // ── Collect per-day data ──────────────────────────────────────────────────
  const feedLeftMin = [], feedRightMin = [];
  const sleepH = [];
  const dWet = [], dDirty = [], dMixed = [];

  days.forEach(dk => {
    const fl = allLogs.filter(l => l.type === 'feed' && new Date(l.start).toDateString() === dk);
    feedLeftMin.push(fl.filter(l => l.side === 'left').reduce((a, l) => a + (l.duration || 0), 0) / 60000);
    feedRightMin.push(fl.filter(l => l.side === 'right').reduce((a, l) => a + (l.duration || 0), 0) / 60000);

    const sl = allLogs.filter(l => l.type === 'sleep' && new Date(l.start).toDateString() === dk);
    sleepH.push(sl.reduce((a, l) => a + (l.duration || 0), 0) / 3600000);

    const dl = allLogs.filter(l => l.type === 'diaper' && new Date(l.timestamp).toDateString() === dk);
    dWet.push(dl.filter(l => l.diaperType === 'wet').length);
    dDirty.push(dl.filter(l => l.diaperType === 'dirty').length);
    dMixed.push(dl.filter(l => l.diaperType === 'mixed').length);
  });

  // ── Feed chart ────────────────────────────────────────────────────────────
  const feedData = days.map((_, i) => ({ segments: [
    { val: feedLeftMin[i],  fill: 'var(--pink)' },
    { val: feedRightMin[i], fill: 'var(--blue)' }
  ]}));
  const feedMax = niceMax(Math.max(...feedData.map(d => d.segments.reduce((a, s) => a + s.val, 0))));

  // ── Sleep chart ───────────────────────────────────────────────────────────
  const sleepData = days.map((_, i) => ({ segments: [
    { val: sleepH[i], fill: 'var(--green)' }
  ]}));
  const sleepMax = niceMax(Math.max(...sleepData.map(d => d.segments[0].val)), true);

  // ── Diaper chart ──────────────────────────────────────────────────────────
  const diaperData = days.map((_, i) => ({ segments: [
    { val: dWet[i],   fill: 'var(--blue)'  },
    { val: dDirty[i], fill: 'var(--amber)' },
    { val: dMixed[i], fill: 'url(#mix-grad)' }
  ]}));
  const diaperMax = niceMax(Math.max(...diaperData.map(d => d.segments.reduce((a, s) => a + s.val, 0))));

  // ── Feed heatmap ──────────────────────────────────────────────────────────
  const cutoff = Date.now() - N * 86400000;
  const feedLogs30 = allLogs.filter(l => l.type === 'feed' && (l.start || 0) >= cutoff);

  el.innerHTML =
    buildChartCard('🤱 Allaitement — 30 derniers jours', [
      { dotStyle: 'background:var(--pink)',  label: 'Gauche' },
      { dotStyle: 'background:var(--blue)',  label: 'Droit'  }
    ], buildBarSVG(feedData, { yMax: feedMax, yUnit: 'min', N })) +

    buildChartCard('🌙 Sommeil — 30 derniers jours', [
      { dotStyle: 'background:var(--green)', label: 'Durée totale' }
    ], buildBarSVG(sleepData, { yMax: sleepMax, yUnit: 'h', N })) +

    buildChartCard('💧 Couches — 30 derniers jours', [
      { dotStyle: 'background:var(--blue)',  label: 'Pipi'  },
      { dotStyle: 'background:var(--amber)', label: 'Selle' },
      { dotStyle: 'background:linear-gradient(135deg,var(--blue) 50%,var(--amber) 50%)', label: 'Mixte' }
    ], buildBarSVG(diaperData, { yMax: diaperMax, yUnit: '', N, hasMixed: true })) +

    buildChartCard('🔮 Rythme typique des tétées', [], buildFeedHeatmapSVG(feedLogs30, N));
}

// ── FEED HEATMAP ──────────────────────────────────────────────────────────────
// Chaque tétée des 30 derniers jours est dessinée sur un axe 0h-24h
// avec une très faible opacité. Les créneaux habituels s'assombrissent
// naturellement par accumulation (transparence additive).
// Formule : opacité effective = 1 - (1 - α)^n
//   α=0.07, n=10 → ~51%  |  n=20 → ~77%  |  n=30 → ~90%
function buildFeedHeatmapSVG(logs, N) {
  const W = 340, H = 88;
  const padL = 8, padR = 8, padT = 10, padB = 22;
  const plotW = W - padL - padR;
  const trackH = H - padT - padB;   // 56px de hauteur de piste
  const DAY_MS = 86400000;
  const ALPHA   = 0.07;              // opacité par barre
  const MIN_PX  = 4;                 // largeur minimale visible (feed très court)
  const PURPLE  = '#8b5cf6';

  // ── Fond de piste + ticks ────────────────────────────────────────────────
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block">`;

  // Fond légèrement teinté
  svg += `<rect x="${padL}" y="${padT}" width="${plotW}" height="${trackH}" fill="${PURPLE}" fill-opacity="0.05" rx="4"/>`;

  // Lignes de quart de journée + labels
  [0, 6, 12, 18, 24].forEach(h => {
    const x = +(padL + (h / 24) * plotW).toFixed(1);
    svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + trackH}" stroke="${PURPLE}" stroke-opacity="0.15" stroke-width="1" stroke-dasharray="2,2"/>`;
    svg += `<text x="${x}" y="${H - 4}" text-anchor="middle" font-size="7" fill="var(--text-muted)" font-family="-apple-system,sans-serif">${String(h).padStart(2,'0')}h</text>`;
  });

  // ── Barres superposées ────────────────────────────────────────────────────
  logs.forEach(l => {
    const d   = new Date(l.start);
    const sec = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    const x   = +(padL + (sec / 86400) * plotW).toFixed(2);
    const w   = Math.max((l.duration || 0) / DAY_MS * plotW, MIN_PX).toFixed(2);
    svg += `<rect x="${x}" y="${padT}" width="${w}" height="${trackH}" fill="${PURPLE}" fill-opacity="${ALPHA}" rx="2"/>`;
  });

  svg += '</svg>';

  // Sous-titre (nombre de tétées analysées)
  const nDays = Math.min(N, new Set(logs.map(l => new Date(l.start).toDateString())).size);
  const caption = logs.length
    ? `<div class="stats-heatmap-caption">${logs.length} tétées sur ${nDays} jour${nDays > 1 ? 's' : ''} — plus c'est dense, plus c'est habituel</div>`
    : `<div class="stats-heatmap-caption empty">Aucune tétée enregistrée sur 30 jours</div>`;

  return svg + caption;
}

// ── PROFILE LIST & EMOJI GRID ─────────────────────────────────────────────────
function renderProfileList() {
  document.getElementById('profile-list').innerHTML = profiles.map(p => {
    const safeName  = escapeHtml(p.name);
    const safeEmoji = escapeHtml(p.emoji);
    return '<div class="profile-item ' + (p.id===activeProfileId?'active-profile':'') + '" onclick="switchToProfile(\'' + p.id + '\')">' +
      '<div class="profile-item-emoji">' + safeEmoji + '</div>' +
      '<div class="profile-item-info">' +
      '<div class="profile-item-name">' + safeName + '</div>' +
      '<div class="profile-item-sub">' + (p.familyId?'Synchronisé':'Local uniquement') + '</div>' +
      '</div>' +
      (p.id===activeProfileId?'<div class="profile-item-badge">Actif</div>':'') +
      '<button class="profile-item-edit" onclick="event.stopPropagation();openEditProfile(\'' + p.id + '\')">✎</button>' +
      '</div>';
  }).join('');
}

function renderEmojiGrid(selected) {
  document.getElementById('emoji-grid').innerHTML = EMOJIS.map(e =>
    '<div class="emoji-opt' + (e===selected?' selected':'') + '" onclick="selectEmoji(\'' + e + '\',this)">' + e + '</div>'
  ).join('');
}
