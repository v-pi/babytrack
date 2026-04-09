// ── js/app.js ────────────────────────────────────────────────────────────────
// Core application: profiles, global state, timer management, log actions,
// render functions, UI helpers.
// ─────────────────────────────────────────────────────────────────────────────

// ── CONFIG ───────────────────────────────────────────────────────────────────
const EMOJIS = ['👶','🧒','🐣','🌟','🌈','🦋','🐧','🐻','🦊','🐼','🍭','🌸'];

// ── GLOBAL STATE ─────────────────────────────────────────────────────────────
let profiles       = [];
let activeProfileId = null;
let familyId       = null;     // set from active profile; used by db.js & sync.js
let allLogs        = [];
let pendingSyncIds = new Set();
let breastActive   = { left: null, right: null };  // { start: ms } | null
let sleepActive    = null;                          // { start: ms } | null
let ticks          = {};
let editingLog     = null;
let editingProfileId = null;
let currentTab     = 'feed';
let toastTO;
let tlDayIndex     = 0, tlDays = [];

// "since last feed" live tick id
const TICK_LAST_FEED = 'last-feed-global';

// ── PROFILE MANAGEMENT ───────────────────────────────────────────────────────
function loadProfiles() {
  try { profiles = JSON.parse(localStorage.getItem('bt_profiles') || '[]'); } catch { profiles = []; }
  activeProfileId = localStorage.getItem('bt_active_profile');

  // Legacy migration
  const legacyFamilyId = localStorage.getItem('bt_family_id');
  if (profiles.length === 0) {
    const p = { id: crypto.randomUUID(), name: 'Mon bébé', emoji: '👶', familyId: legacyFamilyId || null };
    profiles = [p];
    activeProfileId = p.id;
    saveProfiles();
  }
  if (!activeProfileId || !profiles.find(p => p.id === activeProfileId))
    activeProfileId = profiles[0].id;
}

function saveProfiles() {
  localStorage.setItem('bt_profiles', JSON.stringify(profiles));
  localStorage.setItem('bt_active_profile', activeProfileId);
}

function getActiveProfile() {
  return profiles.find(p => p.id === activeProfileId) || profiles[0];
}

function updateHeaderProfile() {
  const p = getActiveProfile();
  document.getElementById('header-emoji').textContent = p.emoji;
  document.getElementById('header-name').textContent  = p.name;
}

// ── INIT ─────────────────────────────────────────────────────────────────────
window.onload = async () => {
  document.getElementById('today-date').textContent =
    new Date().toLocaleDateString('fr-FR', { weekday:'short', day:'numeric', month:'short' });

  await openDB();
  loadProfiles();
  updateHeaderProfile();

  // Handle invite link
  const params = new URLSearchParams(window.location.search);
  const invite = params.get('invite');
  if (invite && invite.length > 20) {
    const p = getActiveProfile();
    p.familyId = invite;
    saveProfiles();
    window.history.replaceState({}, document.title, window.location.pathname);
    showToast("Lien d'invitation détecté !");
  }

  await loadProfileData();

  const p = getActiveProfile();
  familyId = p.familyId;

  if (!familyId) {
    document.getElementById('sync-modal').classList.add('open');
  } else {
    document.getElementById('btn-share').style.display = 'block';
    initSupabase();
  }

  window.addEventListener('online',  () => { setSyncDot('syncing'); setTimeout(() => { if (supabaseClient) syncWithRemote(); else if (familyId) initSupabase(); }, 800); });
  window.addEventListener('offline', () => setSyncDot('error'));
};

async function loadProfileData() {
  allLogs = await dbGetAll();
  loadSession();
  renderAll();
  restoreTimers();
}

function setSyncDot(state) {
  document.getElementById('sync-dot').className = 'sync-dot ' + state;
}

// ── LOG ACTIONS ───────────────────────────────────────────────────────────────
async function logAction(log) {
  log.id = crypto.randomUUID();
  if (familyId)       log.family_id  = familyId;
  else                log.profile_id = activeProfileId;

  allLogs.push(log);
  renderAll();
  await dbPut(log);

  if (supabaseClient && navigator.onLine && familyId) {
    setSyncDot('syncing');
    const { error } = await supabaseClient.from('logs').insert({ ...log, family_id: familyId });
    if (error) { pendingSyncIds.add(log.id); setSyncDot('error'); }
    else        { setSyncDot('ok'); setTimeout(() => setSyncDot(''), 2000); }
  }
}

async function updateLogAction(log) {
  const idx = allLogs.findIndex(l => l.id === log.id);
  if (idx >= 0) allLogs[idx] = log;
  renderAll();
  await dbPut(log);
  if (supabaseClient && navigator.onLine && familyId)
    await supabaseClient.from('logs').upsert({ ...log, family_id: familyId });
}

async function deleteLogAction(id) {
  allLogs = allLogs.filter(l => l.id !== id);
  renderAll();
  await dbDel(id);
  if (supabaseClient && navigator.onLine && familyId)
    await supabaseClient.from('logs').delete().eq('id', id);
}

// ── TIMERS ────────────────────────────────────────────────────────────────────
function startTick(id, fn)  { if (ticks[id]) clearInterval(ticks[id]); ticks[id] = setInterval(fn, 1000); fn(); }
function stopTick(id)       { clearInterval(ticks[id]); delete ticks[id]; }
function stopAllTicks()     { Object.keys(ticks).forEach(stopTick); }

function toggleBreast(side) {
  if (breastActive[side]) {
    const dur = Date.now() - breastActive[side].start;
    logAction({ type:'feed', side, start:breastActive[side].start, end:Date.now(), duration:dur, timestamp:Date.now() });
    stopBreastTimerLocal(side);
    setRemoteTimer('feed', side, null);
    showToast(`Tétée ${side==='left'?'gauche':'droite'} enregistrée`);
  } else {
    stopAllActive(side);
    const start = Date.now();
    activateBreastTimerLocal(side, start);
    setRemoteTimer('feed', side, start);
  }
}

function activateBreastTimerLocal(side, start) {
  breastActive[side] = { start };
  document.getElementById('btn-'+side).classList.add('running');
  startTick('b-'+side, () => {
    const el = document.getElementById('timer-'+side);
    if (el) el.textContent = fmtDur(Date.now() - start);
  });
  saveSession();
}

function stopBreastTimerLocal(side) {
  breastActive[side] = null;
  document.getElementById('btn-'+side).classList.remove('running');
  stopTick('b-'+side);
  const el = document.getElementById('timer-'+side);
  if (el) el.textContent = '00:00';
  saveSession();
}

function toggleSleep() {
  if (sleepActive) {
    const dur = Date.now() - sleepActive.start;
    logAction({ type:'sleep', start:sleepActive.start, end:Date.now(), duration:dur, timestamp:Date.now() });
    stopSleepTimerLocal();
    setRemoteTimer('sleep', null, null);
    showToast('Sommeil enregistré');
  } else {
    stopAllActive('sleep');
    const start = Date.now();
    activateSleepTimerLocal(start);
    setRemoteTimer('sleep', null, start);
  }
}

function activateSleepTimerLocal(start) {
  sleepActive = { start };
  document.getElementById('sleep-btn').classList.add('sleeping');
  document.getElementById('sleep-label').textContent = 'En train de dormir';
  document.getElementById('sleep-sub').textContent   = 'Appuyer pour arrêter';
  document.getElementById('sleep-icon').textContent  = '🌙';
  startTick('sleep', () => {
    const el = document.getElementById('sleep-timer');
    if (el) el.textContent = fmtDur(Date.now() - start);
  });
  saveSession();
}

function stopSleepTimerLocal() {
  sleepActive = null;
  document.getElementById('sleep-btn').classList.remove('sleeping');
  document.getElementById('sleep-label').textContent = 'Début du sommeil';
  document.getElementById('sleep-sub').textContent   = 'Appuyer pour commencer';
  document.getElementById('sleep-icon').textContent  = '😴';
  const el = document.getElementById('sleep-timer');
  if (el) el.textContent = '--:--';
  stopTick('sleep');
  saveSession();
}

/** Stop all active timers except the one identified by `except`. */
function stopAllActive(except) {
  ['left', 'right'].forEach(side => {
    if (except !== side && breastActive[side]) {
      const dur = Date.now() - breastActive[side].start;
      logAction({ type:'feed', side, start:breastActive[side].start, end:Date.now(), duration:dur, timestamp:Date.now() });
      stopBreastTimerLocal(side);
      setRemoteTimer('feed', side, null);
    }
  });
  if (except !== 'sleep' && sleepActive) {
    const dur = Date.now() - sleepActive.start;
    logAction({ type:'sleep', start:sleepActive.start, end:Date.now(), duration:dur, timestamp:Date.now() });
    stopSleepTimerLocal();
    setRemoteTimer('sleep', null, null);
  }
}

function logDiaper(type) {
  logAction({ type:'diaper', diaperType:type, timestamp:Date.now() });
  showToast(type === 'wet' ? '💧 Couche pipi' : '💩 Couche selle');
}

// ── SESSION ───────────────────────────────────────────────────────────────────
function saveSession() {
  localStorage.setItem('bt_session_'+activeProfileId, JSON.stringify({ breastActive, sleepActive }));
}
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem('bt_session_'+activeProfileId) || 'null');
    if (s) { breastActive = s.breastActive || { left:null, right:null }; sleepActive = s.sleepActive || null; }
    else   { breastActive = { left:null, right:null }; sleepActive = null; }
  } catch { breastActive = { left:null, right:null }; sleepActive = null; }
}
function restoreTimers() {
  ['left','right'].forEach(s => { if (breastActive[s]) activateBreastTimerLocal(s, breastActive[s].start); });
  if (sleepActive) activateSleepTimerLocal(sleepActive.start);
}

// ── RENDER ────────────────────────────────────────────────────────────────────
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
  // Don't show if a breast is currently active
  if (breastActive.left || breastActive.right) { el.classList.remove('visible'); return; }
  if (!feedLogs.length) { el.classList.remove('visible'); return; }
  const lastEnd = feedLogs[0].end || feedLogs[0].timestamp;
  el.classList.add('visible');
  startTick(TICK_LAST_FEED, () => {
    el.textContent = `Dernière tétée : ${fmtAgo(Date.now() - lastEnd)}`;
  });
}

function renderFeed() {
  const tl = todayLogs().filter(l => l.type === 'feed');
  document.getElementById('sum-feed-count').textContent = tl.length;
  document.getElementById('sum-feed-total').textContent = fmtDur(tl.reduce((a,l) => a+(l.duration||0), 0));

  ['left','right'].forEach(side => {
    const sl = tl.filter(l => l.side === side);
    const el = document.getElementById('last-'+side);
    if (!sl.length) { el.textContent = ''; return; }
    const last = sl[sl.length-1];
    el.textContent = fmtTime(last.start) + ' · ' + fmtDur(last.duration);
  });

  const el = document.getElementById('feed-history');
  const logs = allLogs.filter(l => l.type === 'feed').sort((a,b) => (b.start||b.timestamp)-(a.start||a.timestamp));
  if (!logs.length) { el.innerHTML = '<div class="empty-state">Aucune tétée enregistrée</div>'; startLastFeedTick(); return; }

  el.innerHTML = groupByDay(logs).map(g => `
    <div class="day-group"><div class="day-group-label">${g.label}</div><div class="history-list">
    ${g.logs.map(l => `<div class="history-item${pendingSyncIds.has(l.id)?' pending':''}" onclick="openEdit('${l.id}')">
      <div class="h-dot ${l.side}"></div>
      <div class="h-main"><div class="h-label">Sein ${l.side==='left'?'gauche':'droit'}</div><div class="h-range">${fmtTime(l.start)} → ${fmtTime(l.end)}</div></div>
      <div class="h-dur">${fmtDur(l.duration)}</div>
      <div class="h-edit-hint">✎</div>
    </div>`).join('')}
    </div></div>`).join('');

  startLastFeedTick();
}

function renderSleep() {
  const tl = todayLogs().filter(l => l.type === 'sleep');
  document.getElementById('sum-sleep-count').textContent = tl.length;
  document.getElementById('sum-sleep-total').textContent = fmtDur(tl.reduce((a,l) => a+(l.duration||0), 0));

  const el = document.getElementById('sleep-history');
  const logs = allLogs.filter(l => l.type === 'sleep').sort((a,b) => (b.start||b.timestamp)-(a.start||a.timestamp));
  if (!logs.length) { el.innerHTML = '<div class="empty-state">Aucun sommeil enregistré</div>'; return; }

  el.innerHTML = groupByDay(logs).map(g => `
    <div class="day-group"><div class="day-group-label">${g.label}</div><div class="history-list">
    ${g.logs.map(l => `<div class="history-item${pendingSyncIds.has(l.id)?' pending':''}" onclick="openEdit('${l.id}')">
      <div class="h-dot sleep"></div>
      <div class="h-main"><div class="h-label">Sommeil</div><div class="h-range">${fmtTime(l.start)} → ${fmtTime(l.end)}</div></div>
      <div class="h-dur">${fmtDur(l.duration)}</div>
      <div class="h-edit-hint">✎</div>
    </div>`).join('')}
    </div></div>`).join('');
}

function renderDiapers() {
  const tl = todayLogs().filter(l => l.type === 'diaper');
  document.getElementById('diaper-wet-count').textContent   = tl.filter(l => l.diaperType === 'wet').length;
  document.getElementById('diaper-dirty-count').textContent = tl.filter(l => l.diaperType === 'dirty').length;

  const el = document.getElementById('diaper-history');
  const logs = allLogs.filter(l => l.type === 'diaper').sort((a,b) => b.timestamp - a.timestamp);
  if (!logs.length) { el.innerHTML = '<div class="empty-state">Aucun changement enregistré</div>'; return; }

  el.innerHTML = groupByDay(logs).map(g => `
    <div class="day-group"><div class="day-group-label">${g.label}</div><div class="history-list">
    ${g.logs.map(l => `<div class="history-item${pendingSyncIds.has(l.id)?' pending':''}" onclick="openEdit('${l.id}')">
      <div class="h-dot ${l.diaperType}"></div>
      <div class="h-main"><div class="h-label">${l.diaperType==='wet'?'💧 Pipi':'💩 Selle'}</div><div class="h-range">${fmtTime(l.timestamp)}</div></div>
      <div class="h-edit-hint">✎</div>
    </div>`).join('')}
    </div></div>`).join('');
}

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
  const pct  = ts => +((new Date(ts).getHours()*3600 + new Date(ts).getMinutes()*60 + new Date(ts).getSeconds()) * 1000 / 86400000 * 100).toFixed(3);
  const dpct = ms => Math.max(0.8, +(ms / 86400000 * 100).toFixed(3));
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

// ── PROFILE MODAL ─────────────────────────────────────────────────────────────
function openProfileModal() {
  renderProfileList();
  document.getElementById('profile-form').style.display = 'none';
  document.getElementById('profile-modal').classList.add('open');
}
function closeProfileModal(e) {
  if (e && e.target !== document.getElementById('profile-modal')) return;
  document.getElementById('profile-modal').classList.remove('open');
}
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

async function switchToProfile(profileId) {
  if (profileId === activeProfileId) { closeProfileModal(); return; }
  stopAllActive('__none__');
  stopAllTicks();
  saveSession();

  activeProfileId = profileId;
  saveProfiles();
  familyId = getActiveProfile().familyId;

  updateHeaderProfile();
  document.getElementById('profile-modal').classList.remove('open');

  supabaseClient = null;
  breastActive   = { left:null, right:null };
  sleepActive    = null;

  await loadProfileData();
  document.getElementById('btn-share').style.display = familyId ? 'block' : 'none';

  if (familyId) initSupabase();
  else document.getElementById('sync-modal').classList.add('open');

  showToast('Profil : ' + getActiveProfile().name);
}

function openAddProfileForm() {
  editingProfileId = null;
  document.getElementById('pf-name').value = '';
  renderEmojiGrid('👶');
  document.getElementById('profile-form').style.display = 'block';
  document.querySelector('#profile-form .btn-save').textContent = 'Créer';
}
function openEditProfile(profileId) {
  editingProfileId = profileId;
  const p = profiles.find(x => x.id === profileId);
  if (!p) return;
  document.getElementById('pf-name').value = p.name;
  renderEmojiGrid(p.emoji);
  document.getElementById('profile-form').style.display = 'block';
  document.querySelector('#profile-form .btn-save').textContent = 'Enregistrer';
}
function renderEmojiGrid(selected) {
  document.getElementById('emoji-grid').innerHTML = EMOJIS.map(e =>
    `<div class="emoji-opt${e===selected?' selected':''}" onclick="selectEmoji('${e}',this)">${e}</div>`
  ).join('');
}
function selectEmoji(e, el) {
  document.querySelectorAll('.emoji-opt').forEach(x => x.classList.remove('selected'));
  el.classList.add('selected');
}
function closeProfileForm() {
  document.getElementById('profile-form').style.display = 'none';
  editingProfileId = null;
}
async function saveProfile() {
  const name = document.getElementById('pf-name').value.trim();
  if (!name) { showToast('Entre un prénom'); return; }
  const emojiEl = document.querySelector('.emoji-opt.selected');
  const emoji   = emojiEl ? emojiEl.textContent : '👶';

  if (editingProfileId) {
    const p = profiles.find(x => x.id === editingProfileId);
    if (p) { p.name = name; p.emoji = emoji; }
    saveProfiles();
    if (editingProfileId === activeProfileId) updateHeaderProfile();
    // Push updated name to remote
    if (editingProfileId === activeProfileId) pushBabyNameToRemote();
    showToast('Profil mis à jour');
  } else {
    profiles.push({ id: crypto.randomUUID(), name, emoji, familyId: null });
    saveProfiles();
    showToast('Profil créé');
  }
  closeProfileForm();
  renderProfileList();
}

// ── RESET ─────────────────────────────────────────────────────────────────────
function confirmReset() {
  const p = getActiveProfile();
  if (!confirm(`Supprimer TOUTES les données de ${p.name} ? Cette action est irréversible.`)) return;
  resetCurrentProfile();
}

async function resetCurrentProfile() {
  stopAllActive('__none__');
  stopAllTicks();

  // Clear remote data if connected
  if (supabaseClient && navigator.onLine && familyId) {
    setSyncDot('syncing');
    await supabaseClient.from('logs').delete().eq('family_id', familyId);
    await supabaseClient.from('active_timers').delete().eq('family_id', familyId);
  }

  // Clear local IDB
  await dbClear();
  allLogs = [];
  breastActive   = { left:null, right:null };
  sleepActive    = null;

  // Clear localStorage for this profile
  localStorage.removeItem('bt_session_'+activeProfileId);

  renderAll();
  document.getElementById('profile-modal').classList.remove('open');
  setSyncDot('');
  showToast('Données effacées');
}

// ── SHARE MODAL ───────────────────────────────────────────────────────────────
function openShareModal() {
  const url = window.location.origin + window.location.pathname + '?invite=' + familyId;
  document.getElementById('qr-code').src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
  document.getElementById('share-link-input').value = url;
  document.getElementById('share-modal').classList.add('open');
}
function closeShareModal(e) {
  if (e && e.target !== document.getElementById('share-modal')) return;
  document.getElementById('share-modal').classList.remove('open');
}
function copyShareLink() {
  navigator.clipboard.writeText(document.getElementById('share-link-input').value);
  showToast('Lien copié !');
}

// ── EDIT MODAL ────────────────────────────────────────────────────────────────
function openEdit(id) {
  editingLog = allLogs.find(l => l.id === id);
  if (!editingLog) return;
  const b = document.getElementById('modal-body');
  if (editingLog.type === 'diaper') {
    b.innerHTML = `<div class="modal-row">
      <div class="modal-field"><label>Date</label><input type="date" id="ed-d" value="${fmtYMD(editingLog.timestamp)}"/></div>
      <div class="modal-field"><label>Heure</label><input type="time" id="ed-t" value="${fmtHM(editingLog.timestamp)}"/></div>
    </div>`;
  } else {
    b.innerHTML = `<div class="modal-row">
      <div class="modal-field"><label>Début Date</label><input type="date" id="es-d" value="${fmtYMD(editingLog.start)}"/></div>
      <div class="modal-field"><label>Début Heure</label><input type="time" id="es-t" value="${fmtHM(editingLog.start)}"/></div>
    </div>
    <div class="modal-row">
      <div class="modal-field"><label>Fin Date</label><input type="date" id="ee-d" value="${fmtYMD(editingLog.end)}"/></div>
      <div class="modal-field"><label>Fin Heure</label><input type="time" id="ee-t" value="${fmtHM(editingLog.end)}"/></div>
    </div>`;
  }
  document.getElementById('modal-overlay').classList.add('open');
}
function closeEditModal(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').classList.remove('open');
  editingLog = null;
}
function saveEntry() {
  if (!editingLog) return;
  if (editingLog.type === 'diaper') {
    editingLog.timestamp = combineDateTime(document.getElementById('ed-d').value, document.getElementById('ed-t').value);
  } else {
    editingLog.start    = combineDateTime(document.getElementById('es-d').value, document.getElementById('es-t').value);
    editingLog.end      = combineDateTime(document.getElementById('ee-d').value, document.getElementById('ee-t').value);
    editingLog.duration = editingLog.end - editingLog.start;
    editingLog.timestamp = editingLog.end;
  }
  updateLogAction(editingLog);
  closeEditModal(); showToast('Modifié !');
}
function deleteEntry() {
  if (!editingLog || !confirm('Supprimer cet événement ?')) return;
  deleteLogAction(editingLog.id);
  closeEditModal(); showToast('Supprimé');
}

// ── UI HELPERS ────────────────────────────────────────────────────────────────
function switchTab(name) {
  ['feed','sleep','diaper','timeline'].forEach(t => {
    document.getElementById('section-'+t).classList.toggle('active', t === name);
    document.getElementById('tab-'+t).classList.toggle('active', t === name);
  });
  currentTab = name;
  if (name === 'timeline') renderTimeline();
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTO);
  toastTO = setTimeout(() => el.classList.remove('show'), 2500);
}

function exportCSV() {
  if (!allLogs.length) { showToast('Rien à exporter'); return; }
  const rows = [['date','heure','type','detail','duree']];
  [...allLogs].sort((a,b) => (a.timestamp||a.start) - (b.timestamp||b.start)).forEach(l => {
    const ts = l.timestamp || l.start;
    rows.push([
      new Date(ts).toLocaleDateString('fr-FR'),
      fmtTime(ts),
      l.type === 'feed' ? 'allaitement' : l.type === 'sleep' ? 'sommeil' : 'couche',
      l.type === 'feed'   ? (l.side === 'left' ? 'gauche' : 'droit') :
      l.type === 'diaper' ? (l.diaperType === 'wet' ? 'pipi' : 'selle') : '',
      l.duration ? fmtDur(l.duration) : ''
    ]);
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.join(',')).join('\n')], { type:'text/csv;charset=utf-8;' }));
  a.download = `babytrack-${getActiveProfile().name}.csv`;
  a.click();
  showToast('Export CSV téléchargé !');
}

// ── VISIBILITY CHANGE ─────────────────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    ['left','right'].forEach(s => { if (breastActive[s]) activateBreastTimerLocal(s, breastActive[s].start); });
    if (sleepActive) activateSleepTimerLocal(sleepActive.start);
    startLastFeedTick();
    // Retry pending items
    if (pendingSyncIds.size > 0 && navigator.onLine && supabaseClient) {
      const toRetry = allLogs.filter(l => pendingSyncIds.has(l.id));
      if (toRetry.length > 0) {
        supabaseClient.from('logs').upsert(toRetry.map(l => ({ ...l, family_id: familyId }))).then(({ error }) => {
          if (!error) { pendingSyncIds.clear(); renderAll(); }
        });
      }
    }
  } else {
    stopAllTicks();
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
