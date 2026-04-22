// ── THEME ─────────────────────────────────────────────────────────────────────
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.getElementById('btn-theme').textContent = dark ? '☀️' : '🌙';
}
function toggleTheme() {
  const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
  localStorage.setItem('bt_theme', dark ? 'dark' : 'light');
  applyTheme(dark);
}

// ── app.js ────────────────────────────────────────────────────────────────────
// Orchestration: init, timer toggle handlers, tab/UI management, modals, events.
// Depends on state.js, render.js, utils.js, db.js, sync.js.
// ─────────────────────────────────────────────────────────────────────────────

// ── INIT ─────────────────────────────────────────────────────────────────────
window.onload = async () => {
  applyTheme(localStorage.getItem('bt_theme') === 'dark');

  // IndexedDB can be blocked in private browsing (iOS Safari) or if storage
  // is full. Degrade gracefully: the app still works, data just won't persist.
  try {
    await openDB();
  } catch (err) {
    console.warn('IndexedDB unavailable:', err);
    // Show a non-blocking banner instead of a silent empty state
    const banner = document.createElement('div');
    banner.textContent = '⚠️ Stockage local indisponible (navigation privée ?). Les données ne seront pas sauvegardées.';
    banner.className = 'storage-warning';
    document.body.prepend(banner);
  }

  // Delegated listeners for history items (replaces inline onclick with data-id)
  ['feed-history','sleep-history','diaper-history','bottle-history'].forEach(containerId => {
    document.getElementById(containerId).addEventListener('click', e => {
      const item = e.target.closest('[data-id]');
      if (item) openEdit(item.dataset.id);
    });
  });

  // Delegated listeners for profile list (data-profile-id / data-edit-id)
  document.getElementById('profile-list').addEventListener('click', e => {
    const editBtn = e.target.closest('[data-edit-id]');
    if (editBtn) { e.stopPropagation(); openEditProfile(editBtn.dataset.editId); return; }
    const item = e.target.closest('[data-profile-id]');
    if (item) switchToProfile(item.dataset.profileId);
  });

  loadProfiles();
  updateHeaderProfile();
  familyId = getActiveProfile().familyId;

  // Restore last active tab (survives F5, not shared between tabs)
  const savedTab = sessionStorage.getItem('bt_tab') || 'feed';
  switchTab(savedTab, true);   // true = silent, skip early timeline render

  // ── Handle invite link (?invite=<shortcode>) ──────────────────────────────
  // The invite code is a 7-char alphanumeric string (e.g. "MJKNPQ4"), NOT the
  // raw family UUID. It is resolved server-side so the UUID is never in the URL.
  const params = new URLSearchParams(window.location.search);
  const inviteParam = params.get('invite');
  const hasInviteCode = inviteParam && /^[A-Z0-9]{7}$/i.test(inviteParam);

  if (hasInviteCode) {
    // Pre-fill the join input so joinFamily() can read it, then clean the URL.
    document.getElementById('invite-code').value = inviteParam.toUpperCase();
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  await loadProfileData();
  // Init bottle input from persisted last value
  const bvi = document.getElementById('bottle-vol-input');
  if (bvi) bvi.value = lastBottleVol;

  if (hasInviteCode && !familyId) {
    // Auto-join from a scanned QR code or shared link.
    // joinFamily() handles setSyncDot, modal close, and initSupabase on success.
    await joinFamily();
    // If join failed (expired/invalid code), fall back to the sync modal.
    if (!familyId) document.getElementById('sync-modal').classList.add('open');
  } else if (!familyId) {
    document.getElementById('sync-modal').classList.add('open');
  } else {
    document.getElementById('btn-share').classList.add('shown');
    initSupabase();
  }

  window.addEventListener('online',  () => {
    setSyncDot('syncing');
    setTimeout(() => { if (supabaseClient) syncWithRemote(); else if (familyId) initSupabase(); }, 800);
  });
  window.addEventListener('offline', () => setSyncDot('error'));
};

async function loadProfileData() {
  allLogs = db ? await dbGetAll() : [];
  loadSession();
  renderCurrentTab();
  restoreTimers();
}

// ── TIMERS ────────────────────────────────────────────────────────────────────
function restoreTimers() {
  ['left','right'].forEach(s => {
    const state = breastActive[s];
    if (!state) return;
    if (state.paused) {
      document.getElementById('btn-'+s).classList.add('paused');
      const pb = document.getElementById('pause-'+s);
      pb.classList.add('shown');
      pb.textContent = '▶ Reprendre';
      const el = document.getElementById('timer-'+s); // Fix: was missing, causing silent error
      if (el) el.textContent = fmtDur(state.accumulated);
    } else {
      activateBreastTimerLocal(s, state.start, state.accumulated || 0, state.origin || state.start);
    }
  });
  if (sleepActive) activateSleepTimerLocal(sleepActive.start);
}

function toggleBreast(side) {
  if (breastActive[side]) {
    const s = breastActive[side];
    const dur = s.accumulated + (s.paused ? 0 : Date.now() - s.start);
    logAction({ type:'feed', side, start:s.origin, end:Date.now(), duration:dur, timestamp:Date.now() });
    stopBreastTimerLocal(side);
    setRemoteTimer('feed', side, null);
    showToast(`Tétée ${side==='left'?'gauche':'droite'} enregistrée`);
  } else {
    stopAllActive(side);
    const start = Date.now();
    activateBreastTimerLocal(side, start, 0, start);
    setRemoteTimer('feed', side, start);
  }
}

function activateBreastTimerLocal(side, start, accumulated = 0, origin = null) {
  breastActive[side] = { start, accumulated, origin: origin || start };
  document.getElementById('btn-'+side).classList.add('running');
  document.getElementById('btn-'+side).classList.remove('paused');
  const pb = document.getElementById('pause-'+side);
  pb.classList.add('shown');
  pb.textContent = '⏸ Pause';
  startTick('b-'+side, () => {
    const el = document.getElementById('timer-'+side);
    if (el) el.textContent = fmtDur(accumulated + Date.now() - start);
  });
  saveSession();
}

function stopBreastTimerLocal(side) {
  breastActive[side] = null;
  document.getElementById('btn-'+side).classList.remove('running', 'paused');
  document.getElementById('pause-'+side).classList.remove('shown');
  stopTick('b-'+side);
  const el = document.getElementById('timer-'+side);
  if (el) el.textContent = '00:00';
  saveSession();
  renderCurrentTab();
}

function togglePauseBreast(side) {
  const s = breastActive[side];
  if (!s) return;
  if (s.paused) {
    // ── Resume ──────────────────────────────────────────────────────────────
    // start_time on the remote = timestamp of this resume (current segment).
    // accumulated = total elapsed before this segment.
    const resumeStart = Date.now();
    activateBreastTimerLocal(side, resumeStart, s.accumulated, s.origin);
    // Notify other browsers: timer is running again from resumeStart,
    // with s.accumulated already banked.
    setRemoteTimer('feed', side, resumeStart, false, s.accumulated);
  } else {
    // ── Pause ────────────────────────────────────────────────────────────────
    const accumulated = s.accumulated + Date.now() - s.start;
    stopTick('b-'+side);
    breastActive[side] = { start: null, accumulated, paused: true, origin: s.origin };
    document.getElementById('btn-'+side).classList.remove('running');
    document.getElementById('btn-'+side).classList.add('paused');
    const el = document.getElementById('timer-'+side);
    if (el) el.textContent = fmtDur(accumulated);
    document.getElementById('pause-'+side).textContent = '▶ Reprendre';
    saveSession();
    // Notify other browsers: timer is paused with `accumulated` ms banked.
    // start_time keeps the origin so remote can still show when the feed started.
    setRemoteTimer('feed', side, s.origin, true, accumulated);
  }
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
  // Same rationale as stopBreastTimerLocal — ensures render after state is cleared.
  renderCurrentTab();
}


// ── COUCHES ───────────────────────────────────────────────────────────────────
function toggleDiaper(type) {
  diaperSelection[type] = !diaperSelection[type];
  const btn = document.getElementById('btn-diaper-' + type);
  btn.classList.toggle('pressed', diaperSelection[type]);
  document.getElementById('diaper-validate').classList.toggle(
    'visible', diaperSelection.wet || diaperSelection.dirty
  );
}

function validateDiaper() {
  const { wet, dirty } = diaperSelection;
  if (!wet && !dirty) return;
  const diaperType = wet && dirty ? 'mixed' : wet ? 'wet' : 'dirty';
  const labels = { wet:'💧 Pipi', dirty:'💩 Selle', mixed:'💧💩 Mixte' };
  logAction({ type:'diaper', diaperType, timestamp:Date.now() });
  showToast(labels[diaperType]);
  // Reset selection
  diaperSelection.wet = false;
  diaperSelection.dirty = false;
  document.getElementById('btn-diaper-wet').classList.remove('pressed');
  document.getElementById('btn-diaper-dirty').classList.remove('pressed');
  document.getElementById('diaper-validate').classList.remove('visible');
}

// ── BIBERON ───────────────────────────────────────────────────────────────────
function adjustBottleVol(delta) {
  const input = document.getElementById('bottle-vol-input');
  if (!input) return;
  input.value = Math.max(0, Math.min(999, (parseInt(input.value, 10) || 0) + delta));
}

function setBottlePreset(val) {
  const input = document.getElementById('bottle-vol-input');
  if (!input) return;
  input.value = val;
}

function logBottle() {
  const input = document.getElementById('bottle-vol-input');
  const vol = Math.max(0, parseInt(input ? input.value : 0, 10) || 0);
  logAction({ type: 'bottle', volume: vol, timestamp: Date.now() });
  lastBottleVol = vol;
  localStorage.setItem('bt_last_bottle_vol', vol);
  showToast('🍼 ' + vol + ' ml enregistré');
}

// ── DAY NAVIGATION (unified) ─────────────────────────────────────────────────
function dayNav(section, delta) {
  if (section === 'timeline') {
    const newIdx = tlDayIndex + delta;
    if (newIdx < 0 || newIdx >= tlDays.length) return;
    const c = document.getElementById('timeline-container');
    c.classList.add('swiping');
    setTimeout(() => { tlDayIndex = newIdx; renderTimeline(); c.classList.remove('swiping'); }, 150);
  } else {
    const days = getHistDays(allLogs.filter(l => l.type === section));
    const newIdx = histDay[section] + delta;
    if (newIdx < 0 || newIdx >= days.length) return;
    histDay[section] = newIdx;
    if      (section === 'feed')   renderFeed();
    else if (section === 'bottle') renderBottle();
    else if (section === 'sleep')  renderSleep();
    else if (section === 'diaper') renderDiapers();
  }
}

// ── TABS ─────────────────────────────────────────────────────────────────────
/**
 * @param {string} name - tab name
 * @param {boolean} [silent] - skip timeline render (used at init)
 */
function switchTab(name, silent) {
  ['feed','bottle','sleep','diaper','timeline','stats'].forEach(t => {
    document.getElementById('section-'+t).classList.toggle('active', t === name);
    document.getElementById('tab-'+t).classList.toggle('active', t === name);
  });
  currentTab = name;
  sessionStorage.setItem('bt_tab', name);
  window.scrollTo(0, 0);
  // Stop per-tab ticks when leaving
  if (name !== 'feed')   stopTick(TICK_LAST_FEED);
  if (name !== 'bottle') stopTick(TICK_LAST_BOTTLE);
  if (!silent) renderCurrentTab();
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTO);
  toastTO = setTimeout(() => el.classList.remove('show'), 2500);
}

// ── EXPORT ───────────────────────────────────────────────────────────────────
function exportCSV() {
  if (!allLogs.length) { showToast('Rien à exporter'); return; }
  const rows = [['date','heure','type','detail','duree']];
  [...allLogs].sort((a,b) => (a.timestamp||a.start)-(b.timestamp||b.start)).forEach(l => {
    const ts = l.timestamp || l.start;
    rows.push([
      new Date(ts).toLocaleDateString('fr-FR'), fmtTime(ts),
      l.type==='feed'   ? 'allaitement' :
      l.type==='sleep'  ? 'sommeil'     :
      l.type==='bottle' ? 'biberon'     : 'couche',
      l.type==='feed'   ? (l.side==='left' ? 'gauche' : 'droit') :
      l.type==='diaper' ? (l.diaperType==='wet' ? 'pipi' : l.diaperType==='dirty' ? 'selle' : 'mixte') :
      l.type==='bottle' ? (l.volume || 0) + ' ml' : '',
      l.duration ? fmtDur(l.duration) : ''
    ]);
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r=>r.join(',')).join('\n')], {type:'text/csv;charset=utf-8;'}));
  a.download = `babytrack-${getActiveProfile().name}.csv`;
  a.click();
  showToast('Export CSV téléchargé !');
}

// ── PROFILE MODAL ─────────────────────────────────────────────────────────────
function openProfileModal() {
  renderProfileList();
  document.getElementById('profile-form').classList.remove('shown');
  document.getElementById('profile-modal').classList.add('open');
}

function openAddProfileForm() {
  editingProfileId = null;
  document.getElementById('pf-name').value = '';
  renderEmojiGrid('👶');
  document.getElementById('profile-form').classList.add('shown');
  document.querySelector('#profile-form .btn-save').textContent = 'Créer';
}

function openEditProfile(profileId) {
  editingProfileId = profileId;
  const p = profiles.find(x => x.id === profileId);
  if (!p) return;
  document.getElementById('pf-name').value = p.name;
  renderEmojiGrid(p.emoji);
  document.getElementById('profile-form').classList.add('shown');
  document.querySelector('#profile-form .btn-save').textContent = 'Enregistrer';
}

function closeProfileForm() {
  document.getElementById('profile-form').classList.remove('shown');
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
    if (editingProfileId === activeProfileId) {
      updateHeaderProfile();
      pushBabyNameToRemote(); // sync name+emoji to Supabase families table
    }
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
  if (!confirm(`Supprimer TOUTES les données de ${getActiveProfile().name} ? Cette action est irréversible.`)) return;
  resetCurrentProfile();
}

async function resetCurrentProfile() {
  stopAllActive('__none__'); stopAllTicks();
  if (supabaseClient && navigator.onLine && familyId) {
    setSyncDot('syncing');
    await supabaseClient.from('logs').delete().eq('family_id', familyId);
    await supabaseClient.from('active_timers').delete().eq('family_id', familyId);
  }
  await dbClear();
  allLogs = []; breastActive = {left:null,right:null}; sleepActive = null;
  localStorage.removeItem('bt_session_'+activeProfileId);
  renderCurrentTab();
  document.getElementById('profile-modal').classList.remove('open');
  setSyncDot('');
  showToast('Données effacées');
}

// ── SHARE MODAL ───────────────────────────────────────────────────────────────
let _shareCountdownInterval = null;
let _currentShareCode       = null; // { raw, display, expiresAt }

async function openShareModal() {
  // Reset display to loading state before opening
  document.getElementById('share-code-display').textContent = '···-····';
  document.getElementById('share-countdown').textContent    = '--:--';
  document.getElementById('share-countdown').classList.remove('expired');
  document.getElementById('qr-code').src = '';
  document.getElementById('share-modal').classList.add('open');
  await _generateAndDisplayCode();
}

async function _generateAndDisplayCode() {
  // Clear any running countdown before starting a new one
  if (_shareCountdownInterval) { clearInterval(_shareCountdownInterval); _shareCountdownInterval = null; }

  const result = await createInviteCode();

  if (!result) {
    document.getElementById('share-countdown').textContent = 'Erreur ⚠️';
    document.getElementById('share-countdown').classList.add('expired');
    showToast('Impossible de créer un code');
    return;
  }

  _currentShareCode = result;

  // Show the human-readable code
  document.getElementById('share-code-display').textContent = result.display;

  // QR code embeds the short code (not the UUID) so the URL never leaks the secret
  const url = window.location.origin + window.location.pathname + '?invite=' + result.raw;
  document.getElementById('qr-code').src =
    `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;

  // Live countdown
  const expiresAt = new Date(result.expiresAt).getTime();
  const tick = () => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      clearInterval(_shareCountdownInterval);
      _shareCountdownInterval = null;
      document.getElementById('share-countdown').textContent = 'Expiré — génère un nouveau code';
      document.getElementById('share-countdown').classList.add('expired');
      document.getElementById('share-code-display').textContent = '···-····';
      return;
    }
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    document.getElementById('share-countdown').textContent = `${m}:${String(s).padStart(2, '0')}`;
  };
  tick(); // immediate first render
  _shareCountdownInterval = setInterval(tick, 1000);
}

async function refreshInviteCode() {
  document.getElementById('share-code-display').textContent = '···-····';
  document.getElementById('share-countdown').textContent    = '--:--';
  document.getElementById('share-countdown').classList.remove('expired');
  await _generateAndDisplayCode();
}

function closeShareModal(e) {
  if (e && e.target !== document.getElementById('share-modal')) return;
  if (_shareCountdownInterval) { clearInterval(_shareCountdownInterval); _shareCountdownInterval = null; }
  document.getElementById('share-modal').classList.remove('open');
}

function copyShareLink() {
  if (!_currentShareCode) return;
  const url = window.location.origin + window.location.pathname + '?invite=' + _currentShareCode.raw;
  navigator.clipboard.writeText(url);
  showToast('Lien copié !');
}

// ── EDIT MODAL ────────────────────────────────────────────────────────────────
function openEdit(id) {
  editingLog = allLogs.find(l => l.id === id);
  if (!editingLog) return;
  const b = document.getElementById('modal-body');
  if (editingLog.type === 'diaper') {
    const dtypes = ['wet','dirty','mixed'];
    const dlabels = { wet:'💧 Pipi', dirty:'💩 Selle', mixed:'💧💩 Mixte' };
    b.innerHTML = `<div class="modal-row">
      <div class="modal-field"><label>Date</label><input type="date" id="ed-d" value="${fmtYMD(editingLog.timestamp)}"/></div>
      <div class="modal-field"><label>Heure</label><input type="time" id="ed-t" value="${fmtHM(editingLog.timestamp)}"/></div>
    </div>
    <div class="modal-field"><label>Type</label>
      <div class="edit-type-group">
        ${dtypes.map(t => `<button onclick="setEditDiaperType('${t}',this)" id="ed-dtype-${t}"
          class="edit-type-btn${editingLog.diaperType===t?' active':''}">
          ${dlabels[t]}</button>`).join('')}
      </div>
    </div>`;
  } else if (editingLog.type === 'bottle') {
    b.innerHTML = `<div class="modal-row">
      <div class="modal-field"><label>Date</label><input type="date" id="ed-d" value="${fmtYMD(editingLog.timestamp)}"/></div>
      <div class="modal-field"><label>Heure</label><input type="time" id="ed-t" value="${fmtHM(editingLog.timestamp)}"/></div>
    </div>
    <div class="modal-field"><label>Volume (ml)</label>
      <input type="number" id="ed-vol" min="0" max="999" step="10" value="${editingLog.volume || 0}" class="edit-vol-input"/>
    </div>`;
  } else {
    // feed or sleep — for feed, add a side selector
    const sideSelector = editingLog.type === 'feed' ? `
    <div class="modal-field"><label>Sein</label>
      <div class="edit-type-group">
        ${[['left','👈 Gauche'],['right','Droit 👉']].map(([val, label]) => `
          <button id="ed-side-${val}" onclick="setEditFeedSide('${val}',this)"
            class="edit-type-btn${editingLog.side===val?' active':''}">
            ${label}
          </button>`).join('')}
      </div>
    </div>` : '';
    b.innerHTML = `<div class="modal-row">
      <div class="modal-field"><label>Début Date</label><input type="date" id="es-d" value="${fmtYMD(editingLog.start)}"/></div>
      <div class="modal-field"><label>Début Heure</label><input type="time" id="es-t" value="${fmtHM(editingLog.start)}"/></div>
    </div><div class="modal-row">
      <div class="modal-field"><label>Fin Date</label><input type="date" id="ee-d" value="${fmtYMD(editingLog.end)}"/></div>
      <div class="modal-field"><label>Fin Heure</label><input type="time" id="ee-t" value="${fmtHM(editingLog.end)}"/></div>
    </div>${sideSelector}`;
  }
  document.getElementById('modal-overlay').classList.add('open');
}
function setEditFeedSide(side, btn) {
  editingLog.side = side;
  ['left', 'right'].forEach(s => {
    const b = document.getElementById('ed-side-' + s);
    if (b) b.classList.toggle('active', s === side);
  });
}

function setEditDiaperType(type, btn) {
  editingLog.diaperType = type;
  ['wet','dirty','mixed'].forEach(t => {
    const b = document.getElementById('ed-dtype-'+t);
    if (b) b.classList.toggle('active', t === type);
  });
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
  } else if (editingLog.type === 'bottle') {
    editingLog.timestamp = combineDateTime(document.getElementById('ed-d').value, document.getElementById('ed-t').value);
    editingLog.volume    = Math.max(0, parseInt(document.getElementById('ed-vol').value, 10) || 0);
  } else {
    const start = combineDateTime(document.getElementById('es-d').value, document.getElementById('es-t').value);
    const end   = combineDateTime(document.getElementById('ee-d').value, document.getElementById('ee-t').value);
    if (end <= start) { showToast('⚠️ La fin doit être après le début'); return; }
    editingLog.start     = start;
    editingLog.end       = end;
    editingLog.duration  = end - start;
    editingLog.timestamp = end;
  }
  updateLogAction(editingLog);
  closeEditModal(); showToast('Modifié !');
}
function deleteEntry() {
  if (!editingLog || !confirm('Supprimer cet événement ?')) return;
  deleteLogAction(editingLog.id);
  closeEditModal(); showToast('Supprimé');
}

// ── VISIBILITY CHANGE ─────────────────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    restoreTimers();
    if (currentTab === 'feed')   startLastFeedTick();
    if (currentTab === 'bottle') startLastBottleTick();
    
    // Une seule commande suffit, elle gère maintenant les retry, delete et pull.
    if (supabaseClient && navigator.onLine) syncWithRemote();
  } else {
    stopAllTicks();
  }
});

// ── SWIPE (all sections, unified) ────────────────────────────────────────────
(function setupDaySwipe() {
  [['section-feed','feed'],['section-bottle','bottle'],['section-sleep','sleep'],
   ['section-diaper','diaper'],['section-timeline','timeline']].forEach(([id, section]) => {
    const el = document.getElementById(id);
    let sx = 0, sy = 0;
    el.addEventListener('touchstart', e => {
      sx = e.changedTouches[0].screenX;
      sy = e.changedTouches[0].screenY;
    }, { passive: true });
    el.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].screenX - sx;
      const dy = e.changedTouches[0].screenY - sy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy))
        dayNav(section, dx > 0 ? +1 : -1);
  }, { passive: true });
  });
})();

// ── SERVICE WORKER ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
