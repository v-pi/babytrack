// ── render.js ─────────────────────────────────────────────────────────────────
// All DOM rendering: feed, sleep, diapers, timeline, profile list, emoji grid.
// Depends on globals from state.js and helpers from utils.js.
// ─────────────────────────────────────────────────────────────────────────────

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

function startLastBottleTick() {
  stopTick(TICK_LAST_BOTTLE);
  const bottleLogs = allLogs.filter(l => l.type === 'bottle').sort((a,b) => b.timestamp - a.timestamp);
  const el = document.getElementById('last-bottle-global');
  if (!el) return;
  if (!bottleLogs.length) { el.classList.remove('visible'); return; }
  const lastTs = bottleLogs[0].timestamp;
  const lastVol = bottleLogs[0].volume || 0;
  el.classList.add('visible');
  startTick(TICK_LAST_BOTTLE, () => {
    el.textContent = 'Dernier biberon (' + lastVol + ' ml) : ' + fmtAgo(Date.now() - lastTs);
  });
}

// ── UNIFIED DAY NAV ───────────────────────────────────────────────────────────
// `dateTs` is the midnight timestamp (ms) of the day currently shown for that
// section. Defaults to today (see state.js) even when today has no logs yet —
// in that case the day is simply rendered empty, with counters at 0.
// Clicking the label opens the date-picker modal (see openDateModal in app.js).
function renderDayNav(section, dateTs) {
  const isToday = dateTs === todayStart();
  const label = fmtDayLabel(new Date(dateTs));
  return '<div class="day-nav">' +
    '<button class="day-nav-btn" onclick="dayNav(\'' + section + '\',+1)" aria-label="Jour précédent">&#8249;</button>' +
    '<button class="day-nav-label" onclick="openDateModal(\'' + section + '\')">' + label + ' <span class="day-nav-caret">▾</span></button>' +
    '<button class="day-nav-btn" onclick="dayNav(\'' + section + '\',-1)"' + (isToday ? ' disabled' : '') + ' aria-label="Jour suivant">&#8250;</button>' +
    '</div>';
}

// ── FEED ─────────────────────────────────────────────────────────────────────
// Une tétée est listée sur chaque journée qu'elle chevauche. Les totaux ne comptent
// que la part qui tombe ce jour-là (partOnDay, utils.js).

/** Précision ajoutée à une plage horaire quand le chrono déborde de la journée affichée. */
function rangeNote(l, dayStart) {
  const sp = spanOf(l);
  if (!sp) return '';
  if (sp.start < dayStart)           return ' <span style="color:var(--text-muted)">· commencé la veille</span>';
  if (sp.end > addDays(dayStart, 1)) return ' <span style="color:var(--text-muted)">· se termine le lendemain</span>';
  return '';
}

function renderFeed() {
  const selDate = histDate.feed;
  document.getElementById('feed-daynav').innerHTML = renderDayNav('feed', selDate);

  const dayLogs = allLogs
    .filter(l => l.type === 'feed' && logOnDay(l, selDate))
    .sort((a, b) => b.start - a.start);

  const dayMs = l => { const p = partOnDay(l, selDate); return p ? p.duration : 0; };

  document.getElementById('sum-feed-count').textContent = dayLogs.length;
  document.getElementById('sum-feed-total').textContent = fmtDur(dayLogs.reduce((a, l) => a + dayMs(l), 0));
  ['left','right'].forEach(side => {
    const sl  = dayLogs.filter(l => l.side === side);
    const el  = document.getElementById('last-'+side);
    if (!sl.length) { el.textContent = ''; return; }
    const last = sl[0]; // dayLogs est trié du plus récent au plus ancien
    el.textContent = fmtTime(last.start) + ' · ' + fmtDur(last.duration);
  });

  const el = document.getElementById('feed-history');
  el.innerHTML = '<div class="history-list">' +
    (dayLogs.length ? dayLogs.map(l =>
      '<div class="history-item' + (pendingSyncIds.has(l.id) ? ' pending' : '') + '" data-id="' + escapeHtml(l.id) + '">' +
      '<div class="h-dot ' + escapeHtml(l.side) + '"></div>' +
      '<div class="h-main"><div class="h-label">Sein ' + (l.side==='left'?'gauche':'droit') + '</div>' +
      '<div class="h-range">' + fmtTime(l.start) + ' → ' + fmtTime(l.end) + rangeNote(l, selDate) + '</div></div>' +
      '<div class="h-dur">' + fmtDur(l.duration) + '</div><div class="h-edit-hint">✎</div>' +
      '</div>'
    ).join('') : '<div class="empty-state">Aucune tétée ce jour</div>') + '</div>';
  startLastFeedTick();
}

// ── SLEEP ─────────────────────────────────────────────────────────────────────
// Un sommeil est listé sur chaque journée qu'il chevauche (ex. 23h → 2h : lundi et mardi).
function renderSleep() {
  const selDate = histDate.sleep;
  document.getElementById('sleep-daynav').innerHTML = renderDayNav('sleep', selDate);

  const dayLogs = allLogs
    .filter(l => l.type === 'sleep' && logOnDay(l, selDate))
    .sort((a, b) => b.start - a.start);

  const dayMs = l => { const p = partOnDay(l, selDate); return p ? p.duration : 0; };

  document.getElementById('sum-sleep-count').textContent = dayLogs.length;
  document.getElementById('sum-sleep-total').textContent = fmtDur(dayLogs.reduce((a, l) => a + dayMs(l), 0));

  const el = document.getElementById('sleep-history');
  el.innerHTML = '<div class="history-list">' +
    (dayLogs.length ? dayLogs.map(l =>
      '<div class="history-item' + (pendingSyncIds.has(l.id) ? ' pending' : '') + '" data-id="' + escapeHtml(l.id) + '">' +
      '<div class="h-dot sleep"></div>' +
      '<div class="h-main"><div class="h-label">Sommeil</div>' +
      '<div class="h-range">' + fmtTime(l.start) + ' → ' + fmtTime(l.end) + rangeNote(l, selDate) + '</div></div>' +
      '<div class="h-dur">' + fmtDur(l.duration) + '</div><div class="h-edit-hint">✎</div>' +
      '</div>'
    ).join('') : '<div class="empty-state">Aucun sommeil ce jour</div>') + '</div>';
}

// ── DIAPERS ───────────────────────────────────────────────────────────────────
function renderDiapers() {
  const selDate = histDate.diaper;
  document.getElementById('diaper-daynav').innerHTML = renderDayNav('diaper', selDate);

  const dayLogs = allLogs
    .filter(l => l.type === 'diaper' && startOfDay(l.timestamp || l.start) === selDate)
    .sort((a, b) => b.timestamp - a.timestamp);

  document.getElementById('diaper-wet-count').textContent   = dayLogs.filter(l => l.diaperType === 'wet'   || l.diaperType === 'mixed').length;
  document.getElementById('diaper-dirty-count').textContent = dayLogs.filter(l => l.diaperType === 'dirty' || l.diaperType === 'mixed').length;

  const el = document.getElementById('diaper-history');
  el.innerHTML = '<div class="history-list">' +
    (dayLogs.length ? dayLogs.map(l =>
      '<div class="history-item' + (pendingSyncIds.has(l.id) ? ' pending' : '') + '" data-id="' + escapeHtml(l.id) + '">' +
      '<div class="h-dot ' + escapeHtml(l.diaperType) + '"></div>' +
      '<div class="h-main"><div class="h-label">' + (l.diaperType==='wet'?'💧 Pipi':l.diaperType==='mixed'?'💧💩 Mixte':'💩 Selle') + '</div>' +
      '<div class="h-range">' + fmtTime(l.timestamp) + '</div></div>' +
      '<div class="h-edit-hint">✎</div>' +
      '</div>'
    ).join('') : '<div class="empty-state">Aucun changement ce jour</div>') + '</div>';
}

// ── TIMELINE ─────────────────────────────────────────────────────────────────
function renderTimeline() {
  const c = document.getElementById('timeline-container');
  const navEl = document.getElementById('tl-day-nav');
  if (navEl) navEl.innerHTML = renderDayNav('timeline', tlDate);

  const dayStart = tlDate;
  const dayEnd   = addDays(dayStart, 1);       // minuit suivant : une journée peut faire 23 h ou 25 h
  const dayLen   = dayEnd - dayStart;
  // Un chrono est affiché sur chaque journée qu'il chevauche, pas seulement sur celle où il finit.
  const logs = allLogs.filter(l => logOnDay(l, dayStart));

  if (!logs.length) {
    c.innerHTML = '<div class="empty-state">Aucune donnée ce jour</div>';
    return;
  }

  // Position d'un instant dans la journée affichée (0–100 %), bornée à la journée.
  const pct = ts => +((Math.min(Math.max(ts, dayStart), dayEnd) - dayStart) / dayLen * 100).toFixed(3);

  // Barre d'un chrono : seule sa part dans CETTE journée est dessinée.
  const barStyle = l => {
    const p     = partOnDay(l, dayStart);
    const width = Math.max(0.8, +(((p ? p.duration : 0) / dayLen) * 100).toFixed(3));
    const left  = Math.min(pct(p ? p.start : dayStart), 100 - width);
    return 'left:' + left.toFixed(3) + '%;width:' + width.toFixed(3) + '%';
  };

  // Repères toutes les 6 h à l'heure locale réelle (une journée de changement d'heure n'a pas 24 h).
  const ticksHtml = [0, 6, 12, 18, 24].map(h => {
    const t = new Date(dayStart);
    t.setHours(h, 0, 0, 0);
    const left = ((t.getTime() - dayStart) / dayLen * 100).toFixed(1);
    return '<div class="tl-tick" style="left:' + left + '%"><div class="tl-tick-line"></div>' +
      '<div class="tl-tick-lbl">' + String(h).padStart(2,'0') + 'h</div></div>';
  }).join('');
  const fl = logs.filter(l => l.type === 'feed');
  const sl = logs.filter(l => l.type === 'sleep');
  const dl = logs.filter(l => l.type === 'diaper');
  c.innerHTML = '<div class="timeline-day"><div class="tl-body" style="padding-top:20px">' +
    '<div class="tl-ticks-row"><div class="tl-tick-spacer"></div><div class="tl-ticks">' + ticksHtml + '</div></div>' +
    (fl.length ? '<div class="tl-row"><div class="tl-row-label">🤱</div><div class="tl-track feed-track">' + fl.map(l=>'<div class="tl-bar ' + escapeHtml(l.side) + '" style="' + barStyle(l) + '"></div>').join('') + '</div></div>' : '') +
    (sl.length ? '<div class="tl-row"><div class="tl-row-label">🌙</div><div class="tl-track sleep-track">' + sl.map(l=>'<div class="tl-bar sleep" style="' + barStyle(l) + '"></div>').join('') + '</div></div>' : '') +
    (dl.length ? '<div class="tl-row"><div class="tl-row-label">💧</div><div class="tl-track diaper-track">' + dl.map(l=>'<div class="tl-dot ' + escapeHtml(l.diaperType) + '" style="left:' + pct(l.timestamp) + '%"></div>').join('') + '</div></div>' : '') +
    '</div></div>';
}

// ── BOTTLE ────────────────────────────────────────────────────────────────────
function renderBottle() {
  const selDate = histDate.bottle;
  document.getElementById('bottle-daynav').innerHTML = renderDayNav('bottle', selDate);

  const dayLogs = allLogs
    .filter(l => l.type === 'bottle' && startOfDay(l.timestamp) === selDate)
    .sort((a, b) => b.timestamp - a.timestamp);

  document.getElementById('sum-bottle-count').textContent = dayLogs.length;
  document.getElementById('sum-bottle-total').textContent = dayLogs.reduce((a, l) => a + (l.volume || 0), 0) + ' ml';

  const el = document.getElementById('bottle-history');
  el.innerHTML = '<div class="history-list">' +
    (dayLogs.length ? dayLogs.map(l =>
      '<div class="history-item' + (pendingSyncIds.has(l.id) ? ' pending' : '') + '" data-id="' + escapeHtml(l.id) + '">' +
      '<div class="h-dot bottle"></div>' +
      '<div class="h-main"><div class="h-label">🍼 ' + (l.volume || 0) + ' ml</div>' +
      '<div class="h-range">' + fmtTime(l.timestamp) + '</div></div>' +
      '<div class="h-edit-hint">✎</div>' +
      '</div>'
    ).join('') : '<div class="empty-state">Aucun biberon ce jour</div>') + '</div>';
  startLastBottleTick();
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

// Picks a sensible spacing between X-axis date labels depending on the
// chosen range, so a long custom window (90/180/365 days) doesn't cram in
// far more labels than a 340px-wide chart can legibly show.
function xLabelInterval(N) {
  if (N <= 14)  return 1;
  if (N <= 60)  return 7;
  if (N <= 120) return 14;
  return 30;
}

function buildBarSVG(data, { yMax, yUnit, N, hasMixed }) {
  const W = 340, H = 130;
  const padL = 30, padR = 4, padT = 8, padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  // Adaptive gap: with a large custom range (e.g. 200+ days) a fixed 1.5px gap
  // between every bar would exceed the available width and produce negative
  // bar widths. Cap the gap to a fraction of each day's slot instead.
  const slotW = plotW / N;
  const gap = Math.min(1.5, slotW * 0.25);
  const barW = Math.max(slotW - gap, 0.35);
  const ticks = 4;
  const tickStep = yMax / ticks;
  const xStep = xLabelInterval(N);

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
    const x = +(padL + i * slotW).toFixed(2);
    let yBase = padT + plotH;
    item.segments.forEach(seg => {
      if (seg.val <= 0) return;
      const h = Math.max((seg.val / yMax) * plotH, 1);
      yBase -= h;
      svg += `<rect x="${x}" y="${yBase.toFixed(2)}" width="${Math.max(barW, 1).toFixed(2)}" height="${h.toFixed(2)}" fill="${seg.fill}" rx="1.5"/>`;
    });
	// X label: first, last, every Nth (but don't draw it if too close to the end)
    if (i === 0 || i === N - 1 || (i % xStep === 0 && (N - 1 - i) > xStep * 0.5)) {
      const d = new Date(today);
      d.setDate(today.getDate() - (N - 1 - i));
      const lbl = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
      svg += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle" font-size="7" fill="var(--text-muted)" font-family="-apple-system,sans-serif">${lbl}</text>`;
    }
  });

  svg += '</svg>';
  return svg;
}

/**
 * Simple line chart — same grid/axis/label conventions as buildBarSVG,
 * for metrics best read as a trend (e.g. count per day) rather than stacked totals.
 */
function buildLineSVG(data, { yMax, yUnit, N, color }) {
  const W = 340, H = 130;
  const padL = 30, padR = 4, padT = 8, padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const ticks = 4;
  const tickStep = yMax / ticks;

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block">`;

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

  // Points along the plot, evenly spaced across the N days
  const stepX = N > 1 ? plotW / (N - 1) : 0;
  const pts = data.map((val, i) => ({
    x: +(padL + i * stepX).toFixed(2),
    y: +(padT + plotH - (Math.min(val, yMax) / yMax) * plotH).toFixed(2),
    val
  }));

  // Soft area fill under the line
  const areaPath = `M${pts[0].x},${(padT + plotH).toFixed(2)} ` +
    pts.map(p => `L${p.x},${p.y}`).join(' ') +
    ` L${pts[pts.length - 1].x},${(padT + plotH).toFixed(2)} Z`;
  svg += `<path d="${areaPath}" fill="${color}" fill-opacity="0.08"/>`;

  // Line
  const linePath = 'M' + pts.map(p => `${p.x},${p.y}`).join(' L');
  svg += `<path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`;

  // Dots on days with at least one entry
  pts.forEach(p => {
    if (p.val > 0) svg += `<circle cx="${p.x}" cy="${p.y}" r="1.6" fill="${color}"/>`;
  });

  // X labels: first, last, every Nth (same adaptive convention as the bar chart)
  const today = new Date();
  const xStep = xLabelInterval(N);
  pts.forEach((p, i) => {
    if (i === 0 || i === N - 1 || (i % xStep === 0 && (N - 1 - i) > xStep * 0.5)) {
      const d = new Date(today);
      d.setDate(today.getDate() - (N - 1 - i));
      const lbl = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
      svg += `<text x="${p.x}" y="${H - 3}" text-anchor="middle" font-size="7" fill="var(--text-muted)" font-family="-apple-system,sans-serif">${lbl}</text>`;
    }
  });

  svg += '</svg>';
  return svg;
}

function isFloat(n) { return n % 1 !== 0; }

// ── STATS RANGE SELECTOR ──────────────────────────────────────────────────────
function buildStatsRangeSelector(N) {
  const presets  = [7, 14, 30, 60, 90];
  const isCustom = !presets.includes(N);
  const pills = presets.map(d =>
    `<button class="range-btn${d === N ? ' active' : ''}" onclick="setStatsRange(${d})">${d}j</button>`
  ).join('');
  return `<div class="stats-range">
    ${pills}
    <button class="range-btn range-btn--custom${isCustom ? ' active' : ''}" onclick="toggleStatsRangeCustom()" title="Durée personnalisée">
      ${isCustom ? N + 'j' : '✎ Autre'}
    </button>
    <div class="stats-range-custom" id="stats-range-custom">
      <input type="number" id="stats-range-custom-input" min="2" max="365" step="1"
             inputmode="numeric" placeholder="Jours" value="${N}"
             onkeydown="if(event.key==='Enter')applyCustomStatsRange()"/>
      <button class="range-btn range-btn--ok" onclick="applyCustomStatsRange()">OK</button>
    </div>
  </div>`;
}

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

  const N = statsRangeDays;
  // Fenêtre = N journées civiles locales, de minuit à minuit, aujourd'hui inclus.
  const days = [];
  for (let i = N - 1; i >= 0; i--) days.push(addDays(todayStart(), -i));
  const dayKeys     = days.map(ts => new Date(ts).toDateString());
  const windowStart = days[0];

  const statsMap = {};
  dayKeys.forEach(dk => {
    statsMap[dk] = { feedLeft: 0, feedRight: 0, feedCount: 0, sleepMs: 0, wet: 0, dirty: 0, mixed: 0, bottleVol: 0 };
  });

  allLogs.forEach(l => {
    if (l.type === 'feed' || l.type === 'sleep') {
      // Un chrono est réparti entre les journées qu'il traverse : chaque morceau va dans son jour.
      splitByDay(l).forEach((p, idx) => {
        const bucket = statsMap[new Date(p.dayStart).toDateString()];
        if (!bucket) return;                                    // hors fenêtre
        if (l.type === 'feed') {
          if (l.side === 'left') bucket.feedLeft  += p.duration;
          else                   bucket.feedRight += p.duration;
          if (idx === 0) bucket.feedCount++;                    // une tétée se compte le jour où elle commence
        } else {
          bucket.sleepMs += p.duration;
        }
      });
      return;
    }
    // Couches et biberons : événements ponctuels, rattachés au jour de leur timestamp.
    const t = Number(l.timestamp);
    if (!t || t < windowStart) return;
    const bucket = statsMap[new Date(t).toDateString()];
    if (!bucket) return;
    if (l.type === 'diaper') {
      if      (l.diaperType === 'wet')   bucket.wet++;
      else if (l.diaperType === 'dirty') bucket.dirty++;
      else if (l.diaperType === 'mixed') bucket.mixed++;
    } else if (l.type === 'bottle') {
      bucket.bottleVol += (l.volume || 0);
    }
  });

  const feedLeftMin  = dayKeys.map(dk => statsMap[dk].feedLeft  / 60000);
  const feedRightMin = dayKeys.map(dk => statsMap[dk].feedRight / 60000);
  const feedCountArr = dayKeys.map(dk => statsMap[dk].feedCount);
  const sleepH       = dayKeys.map(dk => statsMap[dk].sleepMs   / 3600000);
  const dWet         = dayKeys.map(dk => statsMap[dk].wet);
  const dDirty       = dayKeys.map(dk => statsMap[dk].dirty);
  const dMixed       = dayKeys.map(dk => statsMap[dk].mixed);
  const bottleVolMl  = dayKeys.map(dk => statsMap[dk].bottleVol);

  // ── Feed chart ────────────────────────────────────────────────────────────
  const feedData = days.map((_, i) => ({ segments: [
    { val: feedLeftMin[i],  fill: 'var(--pink)' },
    { val: feedRightMin[i], fill: 'var(--blue)' }
  ]}));
  const feedMax = niceMax(Math.max(...feedData.map(d => d.segments.reduce((a, s) => a + s.val, 0))));

  // ── Feed count chart (line) ─────────────────────────────────────────────────
  const feedCountMax = niceMax(Math.max(...feedCountArr));

  // ── Bottle chart ──────────────────────────────────────────────────────────
  const bottleData = days.map((_, i) => ({ segments: [
    { val: bottleVolMl[i], fill: 'var(--teal)' }
  ]}));
  const bottleMax = niceMax(Math.max(...bottleData.map(d => d.segments[0].val)));

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

  // ── Heatmap logs : le filtrage par fenêtre se fait dans la heatmap ─────────
  const feedLogsN  = allLogs.filter(l => l.type === 'feed');
  const sleepLogsN = allLogs.filter(l => l.type === 'sleep');
  const rangeLabel = `${N} derniers jours`;

  el.innerHTML =
    buildStatsRangeSelector(N) +

    buildChartCard(`🤱 Allaitement — ${rangeLabel}`, [
      { dotStyle: 'background:var(--pink)',  label: 'Gauche' },
      { dotStyle: 'background:var(--blue)',  label: 'Droit'  }
    ], buildBarSVG(feedData, { yMax: feedMax, yUnit: 'min', N })) +

    buildChartCard(`🤱 Nombre de tétées — ${rangeLabel}`, [
      { dotStyle: 'background:var(--pink)', label: 'Tétées / jour' }
    ], buildLineSVG(feedCountArr, { yMax: feedCountMax, yUnit: '', N, color: 'var(--pink)' })) +

    buildChartCard(`🍼 Biberon — ${rangeLabel}`, [
      { dotStyle: 'background:var(--teal)', label: 'Volume total' }
    ], buildBarSVG(bottleData, { yMax: bottleMax, yUnit: 'ml', N })) +

    buildChartCard(`🌙 Sommeil — ${rangeLabel}`, [
      { dotStyle: 'background:var(--green)', label: 'Durée totale' }
    ], buildBarSVG(sleepData, { yMax: sleepMax, yUnit: 'h', N })) +

    buildChartCard(`💧 Couches — ${rangeLabel}`, [
      { dotStyle: 'background:var(--blue)',  label: 'Pipi'  },
      { dotStyle: 'background:var(--amber)', label: 'Selle' },
      { dotStyle: 'background:linear-gradient(135deg,var(--blue) 50%,var(--amber) 50%)', label: 'Mixte' }
    ], buildBarSVG(diaperData, { yMax: diaperMax, yUnit: '', N, hasMixed: true })) +

    buildChartCard('🔮 Rythme typique des tétées', [], buildRhythmHeatmapSVG(feedLogsN, N, {
      color: '#8b5cf6', alpha: 0.07, minPx: 4, useDuration: true,
      caption: (n, d) => `${n} tétées sur ${d} jour${d > 1 ? 's' : ''} — plus c'est dense, plus c'est habituel`
    })) +

    buildChartCard('🌙 Rythme typique du sommeil', [], buildRhythmHeatmapSVG(sleepLogsN, N, {
      color: '#4caf82', alpha: 0.10, minPx: 8, useDuration: true,
      caption: (n, d) => `${n} siestes/nuits sur ${d} jour${d > 1 ? 's' : ''} — les plages sombres = moments habituels`
    }));
}

// ── RHYTHM HEATMAP (generic) ──────────────────────────────────────────────────
// Axe 0h–24h commun à toutes les journées de la fenêtre, à faible opacité.
// Chaque morceau de chrono est placé sur l'axe de SA journée (heure locale) : un sommeil
// 23h → 2h donne une barre à droite (23h–24h) le premier jour et une à gauche (0h–2h) le lendemain.
// Options : { color, alpha, minPx, useDuration, caption(n, nDays) }
function buildRhythmHeatmapSVG(logs, N, { color, alpha, minPx, useDuration, caption }) {
  const W = 340, H = 88;
  const padL = 8, padR = 8, padT = 10, padB = 22;
  const plotW = W - padL - padR;
  const trackH = H - padT - padB;
  const windowStart = addDays(todayStart(), -(N - 1));

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block">`;
  svg += `<rect x="${padL}" y="${padT}" width="${plotW}" height="${trackH}" fill="${color}" fill-opacity="0.05" rx="4"/>`;

  [0, 6, 12, 18, 24].forEach(h => {
    const x = +(padL + (h / 24) * plotW).toFixed(1);
    svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + trackH}" stroke="${color}" stroke-opacity="0.15" stroke-width="1" stroke-dasharray="2,2"/>`;
    svg += `<text x="${x}" y="${H - 4}" text-anchor="middle" font-size="7" fill="var(--text-muted)" font-family="-apple-system,sans-serif">${String(h).padStart(2,'0')}h</text>`;
  });

  const days = new Set();
  let nLogs = 0;
  logs.forEach(l => {
    let counted = false;
    splitByDay(l).forEach(p => {
      if (p.dayStart < windowStart) return;
      const len  = addDays(p.dayStart, 1) - p.dayStart;     // longueur réelle de la journée
      const x0   = padL + ((p.start - p.dayStart) / len) * plotW;
      const wRaw = useDuration ? (p.duration / len) * plotW : minPx;
      const w    = Math.max(0, Math.min(Math.max(wRaw, minPx), padL + plotW - x0));
      svg += `<rect x="${x0.toFixed(2)}" y="${padT}" width="${w.toFixed(2)}" height="${trackH}" fill="${color}" fill-opacity="${alpha}" rx="2"/>`;
      days.add(p.dayStart);
      counted = true;
    });
    if (counted) nLogs++;
  });

  svg += '</svg>';

  const cap = nLogs
    ? `<div class="stats-heatmap-caption">${caption(nLogs, days.size)}</div>`
    : `<div class="stats-heatmap-caption empty">Aucune donnée sur ${N} jour${N > 1 ? 's' : ''}</div>`;

  return svg + cap;
}

// ── PROFILE LIST & EMOJI GRID ─────────────────────────────────────────────────
function renderProfileList() {
  document.getElementById('profile-list').innerHTML = profiles.map(p => {
    const safeName  = escapeHtml(p.name);
    const safeEmoji = escapeHtml(p.emoji);
    const safeId    = escapeHtml(p.id);
    return '<div class="profile-item ' + (p.id===activeProfileId?'active-profile':'') + '" data-profile-id="' + safeId + '">' +
      '<div class="profile-item-emoji">' + safeEmoji + '</div>' +
      '<div class="profile-item-info">' +
      '<div class="profile-item-name">' + safeName + '</div>' +
      '<div class="profile-item-sub">' + (p.familyId?'Synchronisé':'Local uniquement') + '</div>' +
      '</div>' +
      (p.id===activeProfileId?'<div class="profile-item-badge">Actif</div>':'') +
      '<button class="profile-item-edit" data-edit-id="' + safeId + '">✎</button>' +
      '</div>';
  }).join('');
}

function renderEmojiGrid(selected) {
  document.getElementById('emoji-grid').innerHTML = EMOJIS.map(e =>
    '<div class="emoji-opt' + (e===selected?' selected':'') + '" onclick="selectEmoji(\'' + e + '\',this)">' + e + '</div>'
  ).join('');
}