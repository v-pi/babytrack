// ── state.js (Phase 2) ────────────────────────────────────────────────────────
// État global, profils, persistance session, CRUD logs, helpers timers.
// setSyncDot et updateHeaderProfile passent par window.app (Alpine).
// ─────────────────────────────────────────────────────────────────────────────

const EMOJIS = ['👶','🧒','🐣','🌟','🌈','🦋','🐧','🐻','🦊','🐼','🍭','🌸'];

let profiles         = [];
let activeProfileId  = null;
let familyId         = null;
let allLogs          = [];
let pendingSyncIds   = new Set();
let pendingDeletes   = new Set();
let breastActive     = { left: null, right: null };
let sleepActive      = null;
let ticks            = {};
let editingLog       = null;
let editingProfileId = null;
let currentTab       = 'feed';
let toastTO;
let tlDayIndex = 0, tlDays = [];
const TICK_LAST_FEED = 'last-feed-global';

// ── FILES D'ATTENTE SYNC ─────────────────────────────────────────────────────
function loadSyncQueues() {
  try {
    pendingSyncIds = new Set(JSON.parse(localStorage.getItem('bt_pending_sync') || '[]'));
    pendingDeletes = new Set(JSON.parse(localStorage.getItem('bt_pending_del') || '[]'));
  } catch { pendingSyncIds = new Set(); pendingDeletes = new Set(); }
}
function saveSyncQueues() {
  localStorage.setItem('bt_pending_sync', JSON.stringify([...pendingSyncIds]));
  localStorage.setItem('bt_pending_del',  JSON.stringify([...pendingDeletes]));
}

// ── PROFILS ───────────────────────────────────────────────────────────────────
function loadProfiles() {
  try { profiles = JSON.parse(localStorage.getItem('bt_profiles') || '[]'); } catch { profiles = []; }
  activeProfileId = localStorage.getItem('bt_active_profile');
  const legacyFamilyId = localStorage.getItem('bt_family_id');
  if (profiles.length === 0) {
    const p = { id: crypto.randomUUID(), name: 'Mon bébé', emoji: '👶', familyId: legacyFamilyId || null };
    profiles = [p]; activeProfileId = p.id; saveProfiles();
  }
  if (!activeProfileId || !profiles.find(p => p.id === activeProfileId))
    activeProfileId = profiles[0].id;
  loadSyncQueues();
}
function saveProfiles() {
  localStorage.setItem('bt_profiles', JSON.stringify(profiles));
  localStorage.setItem('bt_active_profile', activeProfileId);
}
function getActiveProfile() {
  return profiles.find(p => p.id === activeProfileId) || profiles[0];
}

// ── INDICATEUR SYNC ───────────────────────────────────────────────────────────
function setSyncDot(state) {
  if (window.app) window.app.syncState = state;
}

// ── EN-TÊTE PROFIL ────────────────────────────────────────────────────────────
function updateHeaderProfile() {
  const p = getActiveProfile();
  if (window.app) { window.app.headerEmoji = p.emoji; window.app.headerName = p.name; }
}

// ── ACTIONS LOGS ─────────────────────────────────────────────────────────────
async function logAction(log) {
  log.id = crypto.randomUUID();
  if (familyId) log.family_id  = familyId;
  else          log.profile_id = activeProfileId;
  allLogs.push(log);
  renderAll();
  await dbPut(log);
  pendingSyncIds.add(log.id); saveSyncQueues();
  if (supabaseClient && navigator.onLine && familyId) {
    setSyncDot('syncing');
    const { error } = await supabaseClient.from('logs').upsert({ ...log, family_id: familyId });
    if (!error) { pendingSyncIds.delete(log.id); saveSyncQueues(); setSyncDot('ok'); setTimeout(() => setSyncDot(''), 2000); }
    else setSyncDot('error');
  }
}

async function updateLogAction(log) {
  const idx = allLogs.findIndex(l => l.id === log.id);
  if (idx >= 0) allLogs[idx] = log;
  renderAll();
  await dbPut(log);
  pendingSyncIds.add(log.id); saveSyncQueues();
  if (supabaseClient && navigator.onLine && familyId) {
    setSyncDot('syncing');
    const { error } = await supabaseClient.from('logs').upsert({ ...log, family_id: familyId });
    if (!error) { pendingSyncIds.delete(log.id); saveSyncQueues(); setSyncDot('ok'); setTimeout(() => setSyncDot(''), 2000); }
    else setSyncDot('error');
  }
}

async function deleteLogAction(id) {
  allLogs = allLogs.filter(l => l.id !== id);
  renderAll();
  await dbDel(id);
  pendingDeletes.add(id); pendingSyncIds.delete(id); saveSyncQueues();
  if (supabaseClient && navigator.onLine && familyId) {
    setSyncDot('syncing');
    const { error } = await supabaseClient.from('logs').delete().eq('id', id);
    if (!error) { pendingDeletes.delete(id); saveSyncQueues(); setSyncDot('ok'); setTimeout(() => setSyncDot(''), 2000); }
    else setSyncDot('error');
  }
}

// ── HELPERS TIMERS ────────────────────────────────────────────────────────────
function startTick(id, fn) { if (ticks[id]) clearInterval(ticks[id]); ticks[id] = setInterval(fn, 1000); fn(); }
function stopTick(id)      { clearInterval(ticks[id]); delete ticks[id]; }
function stopAllTicks()    { Object.keys(ticks).forEach(stopTick); }

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
