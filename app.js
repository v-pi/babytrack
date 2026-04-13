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
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:#e05;color:#fff;font-size:12px;font-weight:600;text-align:center;padding:8px 12px;';
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

  // Restore last active tab (survives F5, not shared between tabs)
  const savedTab = sessionStorage.getItem('bt_tab') || 'feed';
  switchTab(savedTab, true);   // true = silent, skip early timeline render

  // Handle invite link (?invite=<familyId>)
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
  // Init bottle input from persisted last value
  const bvi = document.getElementById('bottle-vol-input');
  if (bvi) bvi.value = lastBottleVol;
  familyId = getActiveProfile().familyId;

  if (!familyId) {
    document.getElementById('sync-modal').classList.add('open');
  } else {
    document.getElementById('btn-share').style.display = 'block';
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
  ['left','right'].forEach(s => { if (breastActive[s]) activateBreastTimerLocal(s, breastActive[s].start); });
  if (sleepActive) activateSleepTimerLocal(sleepActive.start);
}

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
  // Re-render so history and "last feed" counter reflect the cleared timer state.
  // Covers local stops (race condition with logAction) and remote stops from the
  // active_timers realtime channel (which doesn't go through logAction).
  renderCurrentTab();
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
  document.getElementById('profile-form').style.display = 'none';
  document.getElementById('profile-modal').classList.add('open');
}
function closeProfileModal(e) {
  if (e && e.target !== document.getElementById('profile-modal')) return;
  document.getElementById('profile-modal').classList.remove('open');
}

async function switchToProfile(profileId) {
  if (profileId === activeProfileId) { closeProfileModal(); return; }
  stopAllActive('__none__'); stopAllTicks(); saveSession();
  activeProfileId = profileId; saveProfiles();
  familyId = getActiveProfile().familyId;
  updateHeaderProfile();
  document.getElementById('profile-modal').classList.remove('open');
  supabaseClient = null; breastActive = {left:null,right:null}; sleepActive = null;
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
    const dtypes = ['wet','dirty','mixed'];
    const dlabels = { wet:'💧 Pipi', dirty:'💩 Selle', mixed:'💧💩 Mixte' };
    b.innerHTML = `<div class="modal-row">
      <div class="modal-field"><label>Date</label><input type="date" id="ed-d" value="${fmtYMD(editingLog.timestamp)}"/></div>
      <div class="modal-field"><label>Heure</label><input type="time" id="ed-t" value="${fmtHM(editingLog.timestamp)}"/></div>
    </div>
    <div class="modal-field"><label>Type</label>
      <div style="display:flex;gap:8px;margin-top:4px">
        ${dtypes.map(t => `<button onclick="setEditDiaperType('${t}',this)" id="ed-dtype-${t}"
          style="flex:1;padding:10px 6px;border-radius:10px;border:2px solid ${editingLog.diaperType===t?'var(--pink)':'var(--border)'};
          background:${editingLog.diaperType===t?'var(--pink-light)':'var(--bg)'};font-size:13px;font-weight:600;cursor:pointer">
          ${dlabels[t]}</button>`).join('')}
      </div>
    </div>`;
  } else if (editingLog.type === 'bottle') {
    b.innerHTML = `<div class="modal-row">
      <div class="modal-field"><label>Date</label><input type="date" id="ed-d" value="${fmtYMD(editingLog.timestamp)}"/></div>
      <div class="modal-field"><label>Heure</label><input type="time" id="ed-t" value="${fmtHM(editingLog.timestamp)}"/></div>
    </div>
    <div class="modal-field"><label>Volume (ml)</label>
      <input type="number" id="ed-vol" min="0" max="999" step="10" value="${editingLog.volume || 0}" style="font-size:22px;font-weight:700;text-align:center"/>
    </div>`;
  } else {
    b.innerHTML = `<div class="modal-row">
      <div class="modal-field"><label>Début Date</label><input type="date" id="es-d" value="${fmtYMD(editingLog.start)}"/></div>
      <div class="modal-field"><label>Début Heure</label><input type="time" id="es-t" value="${fmtHM(editingLog.start)}"/></div>
    </div><div class="modal-row">
      <div class="modal-field"><label>Fin Date</label><input type="date" id="ee-d" value="${fmtYMD(editingLog.end)}"/></div>
      <div class="modal-field"><label>Fin Heure</label><input type="time" id="ee-t" value="${fmtHM(editingLog.end)}"/></div>
    </div>`;
  }
  document.getElementById('modal-overlay').classList.add('open');
}
function setEditDiaperType(type, btn) {
  editingLog.diaperType = type;
  ['wet','dirty','mixed'].forEach(t => {
    const b = document.getElementById('ed-dtype-'+t);
    if (b) {
      b.style.borderColor = t === type ? 'var(--pink)' : 'var(--border)';
      b.style.background  = t === type ? 'var(--pink-light)' : 'var(--bg)';
    }
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
    ['left','right'].forEach(s => { if (breastActive[s]) activateBreastTimerLocal(s, breastActive[s].start); });
    if (sleepActive) activateSleepTimerLocal(sleepActive.start);
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
