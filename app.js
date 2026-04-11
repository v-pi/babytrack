// ── app.js (Phase 2) ──────────────────────────────────────────────────────────
// Composant Alpine + orchestration. Phase 2 : profils, emojis, timers, modales
// gérés entièrement via l'état Alpine — plus aucun getElementById résiduel pour
// l'UI réactive.
// ─────────────────────────────────────────────────────────────────────────────

// ── COMPOSANT ALPINE ─────────────────────────────────────────────────────────
function babyApp() {
  return {
    // ── En-tête ──────────────────────────────────────────────────────────────
    currentTab:   'feed',
    headerEmoji:  '👶',
    headerName:   'Mon bébé',
    todayDate:    '',
    showShareBtn: false,
    syncState:    '',

    // ── Chronomètres allaitement ─────────────────────────────────────────────
    timerLeft:      '00:00',
    timerRight:     '00:00',
    breastRunning:  { left: false, right: false },
    lastLeft:       '',
    lastRight:      '',

    // ── Dernière tétée ────────────────────────────────────────────────────────
    lastFeedText:   '',
    showLastFeed:   false,

    // ── Chronomètre sommeil ───────────────────────────────────────────────────
    timerSleep:   '--:--',
    isSleeping:   false,
    sleepLabel:   'Début du sommeil',
    sleepSub:     'Appuyer pour commencer',
    sleepIcon:    '😴',

    // ── Stats résumé ──────────────────────────────────────────────────────────
    feedCount:    0,  feedTotal:    '0 min',
    sleepCount:   0,  sleepTotal:   '0 min',
    diaperWet:    0,  diaperDirty:  0,

    // ── Historiques (x-for) ───────────────────────────────────────────────────
    feedGroups:    [],   // [{label, logs[]}]
    sleepGroups:   [],
    diaperGroups:  [],

    // ── Timeline ──────────────────────────────────────────────────────────────
    tlNavLabel:     '—',
    tlPrevDisabled: true,
    tlNextDisabled: true,
    tlSwiping:      false,
    tlEmpty:        false,
    tlHasFeed:      false,
    tlHasSleep:     false,
    tlHasDiaper:    false,
    tlFeedBars:     [],  // [{id, side, left, width}]
    tlSleepBars:    [],  // [{id, left, width}]
    tlDiaperDots:   [],  // [{id, type, left}]

    // ── Profils ───────────────────────────────────────────────────────────────
    profileList:        [],  // copie de profiles[]
    emojis:             ['👶','🧒','🐣','🌟','🌈','🦋','🐧','🐻','🦊','🐼','🍭','🌸'],
    selectedEmoji:      '👶',
    profileFormVisible: false,
    profileFormMode:    'create',  // 'create' | 'edit'

    // ── Modales ───────────────────────────────────────────────────────────────
    editModalOpen:    false,
    profileModalOpen: false,
    syncModalOpen:    false,
    shareModalOpen:   false,
    shareQrUrl:       '',
    shareLink:        '',

    // ── Toast ─────────────────────────────────────────────────────────────────
    toastMsg:     '',
    toastVisible: false,
    _toastTimer:  null,

    // ── Formatters exposés aux templates x-for ────────────────────────────────
    fmtTime(ts)  { return fmtTime(ts); },
    fmtDur(ms)   { return fmtDur(ms); },

    // ── Helpers ───────────────────────────────────────────────────────────────
    /** true si le log est en attente de sync (badge orange). */
    isPending(id) { return typeof pendingSyncIds !== 'undefined' && pendingSyncIds.has(id); },

    /** Label du côté d'allaitement. */
    sideLabel(side) { return side === 'left' ? 'gauche' : 'droit'; },

    /** Label couche. */
    diaperLabel(type) { return type === 'wet' ? '💧 Pipi' : '💩 Selle'; },

    // ── Init Alpine ───────────────────────────────────────────────────────────
    init() {
      window.app = this;
      this.todayDate = new Date().toLocaleDateString('fr-FR', {
        weekday: 'short', day: 'numeric', month: 'short'
      });
    },

    toast(msg) {
      this.toastMsg = msg;
      this.toastVisible = true;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.toastVisible = false; }, 2500);
    },
  };
}

// ── INIT ─────────────────────────────────────────────────────────────────────
window.onload = async () => {
  await openDB();
  loadProfiles();
  updateHeaderProfile();

  const savedTab = sessionStorage.getItem('bt_tab') || 'feed';
  switchTab(savedTab, true);

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
  familyId = getActiveProfile().familyId;

  if (!familyId) {
    window.app.syncModalOpen = true;
  } else {
    window.app.showShareBtn = true;
    initSupabase();
  }

  window.addEventListener('online', () => {
    setSyncDot('syncing');
    setTimeout(() => { if (supabaseClient) syncWithRemote(); else if (familyId) initSupabase(); }, 800);
  });
  window.addEventListener('offline', () => setSyncDot('error'));
};

async function loadProfileData() {
  allLogs = await dbGetAll();
  loadSession();
  renderAll();
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
  window.app.breastRunning[side] = true;
  startTick('b-'+side, () => {
    window.app['timer' + (side === 'left' ? 'Left' : 'Right')] = fmtDur(Date.now() - start);
  });
  saveSession();
}

function stopBreastTimerLocal(side) {
  breastActive[side] = null;
  window.app.breastRunning[side] = false;
  window.app['timer' + (side === 'left' ? 'Left' : 'Right')] = '00:00';
  stopTick('b-'+side);
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
  Object.assign(window.app, {
    isSleeping: true,
    sleepLabel: 'En train de dormir',
    sleepSub:   'Appuyer pour arrêter',
    sleepIcon:  '🌙',
  });
  startTick('sleep', () => {
    window.app.timerSleep = fmtDur(Date.now() - start);
  });
  saveSession();
}

function stopSleepTimerLocal() {
  sleepActive = null;
  Object.assign(window.app, {
    isSleeping: false,
    sleepLabel: 'Début du sommeil',
    sleepSub:   'Appuyer pour commencer',
    sleepIcon:  '😴',
    timerSleep: '--:--',
  });
  stopTick('sleep');
  saveSession();
}

// ── ONGLETS ───────────────────────────────────────────────────────────────────
function switchTab(name, silent) {
  currentTab = name;
  window.app.currentTab = name;
  sessionStorage.setItem('bt_tab', name);
  document.querySelector('.content').scrollTop = 0;
  if (!silent && name === 'timeline') renderTimeline();
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
function showToast(msg) { window.app.toast(msg); }

// ── EXPORT ───────────────────────────────────────────────────────────────────
function exportCSV() {
  if (!allLogs.length) { showToast('Rien à exporter'); return; }
  const rows = [['date','heure','type','detail','duree']];
  [...allLogs].sort((a,b) => (a.timestamp||a.start)-(b.timestamp||b.start)).forEach(l => {
    const ts = l.timestamp || l.start;
    rows.push([
      new Date(ts).toLocaleDateString('fr-FR'), fmtTime(ts),
      l.type==='feed'?'allaitement':l.type==='sleep'?'sommeil':'couche',
      l.type==='feed'?(l.side==='left'?'gauche':'droit'):l.type==='diaper'?(l.diaperType==='wet'?'pipi':'selle'):'',
      l.duration ? fmtDur(l.duration) : ''
    ]);
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r=>r.join(',')).join('\n')], {type:'text/csv;charset=utf-8;'}));
  a.download = `babytrack-${getActiveProfile().name}.csv`;
  a.click();
  showToast('Export CSV téléchargé !');
}

// ── MODALE PROFILS ────────────────────────────────────────────────────────────
function openProfileModal() {
  renderProfileList();
  window.app.profileFormVisible = false;
  window.app.profileModalOpen = true;
}
function closeProfileModal(e) {
  if (e && e.target !== document.getElementById('profile-modal')) return;
  window.app.profileModalOpen = false;
}

async function switchToProfile(profileId) {
  if (profileId === activeProfileId) { closeProfileModal(); return; }
  stopAllActive('__none__'); stopAllTicks(); saveSession();
  activeProfileId = profileId; saveProfiles();
  familyId = getActiveProfile().familyId;
  updateHeaderProfile();
  window.app.profileModalOpen = false;
  supabaseClient = null;
  breastActive = { left:null, right:null };
  sleepActive = null;
  await loadProfileData();
  window.app.showShareBtn = !!familyId;
  if (familyId) initSupabase();
  else window.app.syncModalOpen = true;
  showToast('Profil : ' + getActiveProfile().name);
}

function openAddProfileForm() {
  editingProfileId = null;
  document.getElementById('pf-name').value = '';
  window.app.selectedEmoji  = '👶';
  window.app.profileFormMode = 'create';
  window.app.profileFormVisible = true;
}

function openEditProfile(profileId) {
  editingProfileId = profileId;
  const p = profiles.find(x => x.id === profileId);
  if (!p) return;
  document.getElementById('pf-name').value = p.name;
  window.app.selectedEmoji  = p.emoji;
  window.app.profileFormMode = 'edit';
  window.app.profileFormVisible = true;
}

function closeProfileForm() {
  window.app.profileFormVisible = false;
  editingProfileId = null;
}

async function saveProfile() {
  const name = document.getElementById('pf-name').value.trim();
  if (!name) { showToast('Entre un prénom'); return; }
  const emoji = window.app.selectedEmoji || '👶';
  if (editingProfileId) {
    const p = profiles.find(x => x.id === editingProfileId);
    if (p) { p.name = name; p.emoji = emoji; }
    saveProfiles();
    if (editingProfileId === activeProfileId) {
      updateHeaderProfile();
      pushBabyNameToRemote();
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
  renderAll();
  window.app.profileModalOpen = false;
  setSyncDot('');
  showToast('Données effacées');
}

// ── MODALE PARTAGE ────────────────────────────────────────────────────────────
function openShareModal() {
  const url = window.location.origin + window.location.pathname + '?invite=' + familyId;
  window.app.shareQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
  window.app.shareLink  = url;
  window.app.shareModalOpen = true;
}
function closeShareModal(e) {
  if (e && e.target !== document.getElementById('share-modal')) return;
  window.app.shareModalOpen = false;
}
function copyShareLink() {
  navigator.clipboard.writeText(window.app.shareLink);
  showToast('Lien copié !');
}

// ── MODALE ÉDITION ────────────────────────────────────────────────────────────
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
    </div><div class="modal-row">
      <div class="modal-field"><label>Fin Date</label><input type="date" id="ee-d" value="${fmtYMD(editingLog.end)}"/></div>
      <div class="modal-field"><label>Fin Heure</label><input type="time" id="ee-t" value="${fmtHM(editingLog.end)}"/></div>
    </div>`;
  }
  window.app.editModalOpen = true;
}
function closeEditModal(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  window.app.editModalOpen = false;
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
  window.app.editModalOpen = false;
  editingLog = null;
  showToast('Modifié !');
}
function deleteEntry() {
  if (!editingLog || !confirm('Supprimer cet événement ?')) return;
  deleteLogAction(editingLog.id);
  window.app.editModalOpen = false;
  editingLog = null;
  showToast('Supprimé');
}

// ── VISIBILITÉ ────────────────────────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    ['left','right'].forEach(s => { if (breastActive[s]) activateBreastTimerLocal(s, breastActive[s].start); });
    if (sleepActive) activateSleepTimerLocal(sleepActive.start);
    startLastFeedTick();
    if (supabaseClient && navigator.onLine) syncWithRemote();
  } else {
    stopAllTicks();
  }
});

// ── SWIPE CALENDRIER ──────────────────────────────────────────────────────────
(function setupSwipe() {
  const section = document.getElementById('section-timeline');
  let startX = 0;
  section.addEventListener('touchstart', e => { startX = e.changedTouches[0].screenX; }, { passive: true });
  section.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].screenX - startX;
    if (Math.abs(dx) > 50) tlNav(dx > 0 ? +1 : -1);
  }, { passive: true });
})();

// ── SERVICE WORKER ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
