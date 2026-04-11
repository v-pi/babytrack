// ── render.js ─────────────────────────────────────────────────────────────────
// All DOM rendering: feed, sleep, diapers, timeline, profile list, emoji grid.
// Depends on globals from state.js and helpers from utils.js.
// ─────────────────────────────────────────────────────────────────────────────

function todayLogs() {
  const t = new Date().toDateString();
  return allLogs.filter(l => new Date(l.timestamp || l.start).toDateString() === t);
}

/** Start / restart the "since last feed" live counter. */
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
    el.textContent = `Dernière tétée : ${fmtAgo(Date.now() - lastEnd)}`;
  });
}

/** Returns sorted unique day keys (toDateString()), most recent first. */
function getHistDays(logs) {
  const keys = [...new Set(logs.map(l => new Date(l.timestamp || l.start).toDateString()))];
  return keys.sort((a, b) => new Date(b) - new Date(a));
}

/** Renders the day nav bar HTML for a history section. */
function renderHistNav(type, idx, days) {
  return `<div class="hist-nav">
    <button class="hist-nav-btn" onclick="histNav('${type}',+1)" ${idx >= days.length - 1 ? 'disabled' : ''}>‹</button>
    <span class="hist-nav-label">${fmtDayLabel(new Date(days[idx]))}</span>
    <button class="hist-nav-btn" onclick="histNav('${type}',-1)" ${idx <= 0 ? 'disabled' : ''}>›</button>
  </div>`;
}

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
  el.innerHTML = renderHistNav('feed', histDay.feed, days) +
    '<div class="history-list">' +
    dayLogs.map(l => `<div class="history-item${pendingSyncIds.has(l.id)?' pending':''}" onclick="openEdit('${l.id}')">
      <div class="h-dot ${l.side}"></div>
      <div class="h-main"><div class="h-label">Sein ${l.side==='left'?'gauche':'droit'}</div>
      <div class="h-range">${fmtTime(l.start)} → ${fmtTime(l.end)}</div></div>
      <div class="h-dur">${fmtDur(l.duration)}</div><div class="h-edit-hint">✎</div>
    </div>`).join('') + '</div>';
  startLastFeedTick();
}

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
  el.innerHTML = renderHistNav('sleep', histDay.sleep, days) +
    '<div class="history-list">' +
    dayLogs.map(l => `<div class="history-item${pendingSyncIds.has(l.id)?' pending':''}" onclick="openEdit('${l.id}')">
      <div class="h-dot sleep"></div>
      <div class="h-main"><div class="h-label">Sommeil</div>
      <div class="h-range">${fmtTime(l.start)} → ${fmtTime(l.end)}</div></div>
      <div class="h-dur">${fmtDur(l.duration)}</div><div class="h-edit-hint">✎</div>
    </div>`).join('') + '</div>';
}

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
  el.innerHTML = renderHistNav('diaper', histDay.diaper, days) +
    '<div class="history-list">' +
    dayLogs.map(l => `<div class="history-item${pendingSyncIds.has(l.id)?' pending':''}" onclick="openEdit('${l.id}')">
      <div class="h-dot ${l.diaperType}"></div>
      <div class="h-main"><div class="h-label">${l.diaperType==='wet'?'💧 Pipi':'💩 Selle'}</div>
      <div class="h-range">${fmtTime(l.timestamp)}</div></div>
      <div class="h-edit-hint">✎</div>
    </div>`).join('') + '</div>';
}

// ── TIMELINE ─────────────────────────────────────────────────────────────────
function tlNav(delta) {
  const newIdx = tlDayIndex + delta;
  if (newIdx < 0 || newIdx >= tlDays.length) return;
  const c = document.getElementById('timeline-container');
  c.classList.add('swiping');
  setTimeout(() => { tlDayIndex = newIdx; renderTimeline(); c.classList.remove('swiping'); }, 150);
}

function renderTimeline() {
  const c = document.getElementById('timeline-container');
  const byDay = {};
  allLogs.forEach(l => {
    const k = new Date(l.timestamp || l.start).toDateString();
    if (!byDay[k]) byDay[k] = [];
    byDay[k].push(l);
  });
  tlDays = Object.keys(byDay).sort((a,b) => new Date(b) - new Date(a));
  if (!tlDays.length) {
    c.innerHTML = '<div class="empty-state">Aucune donnée</div>';
    document.getElementById('tl-nav-label').textContent = '—';
    return;
  }
  tlDayIndex = Math.max(0, Math.min(tlDayIndex, tlDays.length - 1));
  document.getElementById('tl-nav-label').textContent = fmtDayLabel(new Date(tlDays[tlDayIndex]));
  document.getElementById('tl-nav-prev').disabled = (tlDayIndex >= tlDays.length - 1);
  document.getElementById('tl-nav-next').disabled = (tlDayIndex <= 0);

  const logs = byDay[tlDays[tlDayIndex]];
  const pct  = ts => +((new Date(ts).getHours()*3600+new Date(ts).getMinutes()*60+new Date(ts).getSeconds())*1000/86400000*100).toFixed(3);
  const dpct = ms => Math.max(0.8, +(ms/86400000*100).toFixed(3));
  const ticksHtml = [0,6,12,18,24].map(h =>
    `<div class="tl-tick" style="left:${(h/24*100).toFixed(1)}%"><div class="tl-tick-line"></div><div class="tl-tick-lbl">${String(h).padStart(2,'0')}h</div></div>`
  ).join('');

  const fl = logs.filter(l => l.type === 'feed');
  const sl = logs.filter(l => l.type === 'sleep');
  const dl = logs.filter(l => l.type === 'diaper');

  c.innerHTML = `<div class="timeline-day"><div class="tl-body" style="padding-top:20px">
    <div class="tl-ticks-row"><div class="tl-tick-spacer"></div><div class="tl-ticks">${ticksHtml}</div></div>
    ${fl.length ? `<div class="tl-row"><div class="tl-row-label">🤱</div><div class="tl-track feed-track">${fl.map(l=>`<div class="tl-bar ${l.side}" style="left:${pct(l.start)}%;width:${dpct(l.duration)}%"></div>`).join('')}</div></div>` : ''}
    ${sl.length ? `<div class="tl-row"><div class="tl-row-label">🌙</div><div class="tl-track sleep-track">${sl.map(l=>`<div class="tl-bar sleep" style="left:${pct(l.start)}%;width:${dpct(l.duration)}%"></div>`).join('')}</div></div>` : ''}
    ${dl.length ? `<div class="tl-row"><div class="tl-row-label">💧</div><div class="tl-track diaper-track">${dl.map(l=>`<div class="tl-dot ${l.diaperType}" style="left:${pct(l.timestamp)}%"></div>`).join('')}</div></div>` : ''}
  </div></div>`;
}

function renderAll() {
  renderFeed();
  renderSleep();
  renderDiapers();
  if (currentTab === 'timeline') renderTimeline();
}

// ── PROFILE LIST & EMOJI GRID ─────────────────────────────────────────────────
function renderProfileList() {
  document.getElementById('profile-list').innerHTML = profiles.map(p => `
    <div class="profile-item ${p.id===activeProfileId?'active-profile':''}" onclick="switchToProfile('${p.id}')">
      <div class="profile-item-emoji">${p.emoji}</div>
      <div class="profile-item-info">
        <div class="profile-item-name">${p.name}</div>
        <div class="profile-item-sub">${p.familyId?'Synchronisé':'Local uniquement'}</div>
      </div>
      ${p.id===activeProfileId?'<div class="profile-item-badge">Actif</div>':''}
      <button class="profile-item-edit" onclick="event.stopPropagation();openEditProfile('${p.id}')">✎</button>
    </div>`).join('');
}

function renderEmojiGrid(selected) {
  document.getElementById('emoji-grid').innerHTML = EMOJIS.map(e =>
    `<div class="emoji-opt${e===selected?' selected':''}" onclick="selectEmoji('${e}',this)">${e}</div>`
  ).join('');
}
