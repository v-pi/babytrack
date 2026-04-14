// ── state.js ──────────────────────────────────────────────────────────────────
// Global state, profile management, session persistence, log CRUD, timer helpers.
// No DOM rendering here — only data + a few status helpers.
// ─────────────────────────────────────────────────────────────────────────────

const EMOJIS = ['👶','🧒','🐣','🌟','🌈','🦋','🐧','🐻','🦊','🐼','🍭','🌸'];

// ── GLOBAL STATE ─────────────────────────────────────────────────────────────
let profiles         = [];
let activeProfileId  = null;
let familyId         = null;
let allLogs          = [];
let pendingSyncIds   = new Set(); // Logs à ajouter/modifier sur le serveur
let pendingDeletes   = new Set(); // IDs à supprimer sur le serveur
let pendingTimers    = {};        // [NOUVEAU] Chronos en attente de synchro { 'feed_left': { type, side, startTime } }
let breastActive     = { left: null, right: null };
let sleepActive      = null;
let ticks            = {};
let editingLog       = null;
let editingProfileId = null;
let currentTab       = 'feed';
let diaperSelection = { wet: false, dirty: false };
let lastBottleVol   = 0;   // default 0, then last entered value
let toastTO;
let tlDayIndex = 0, tlDays = [];
let histDay = { feed: 0, bottle: 0, sleep: 0, diaper: 0 };
const TICK_LAST_FEED   = 'last-feed-global';
const TICK_LAST_BOTTLE = 'last-bottle-global';

// ── SYNC QUEUES (Sauvegarde locale des actions en attente) ───────────────────
function loadSyncQueues() {
  try {
    pendingSyncIds = new Set(JSON.parse(localStorage.getItem('bt_pending_sync') || '[]'));
    pendingDeletes = new Set(JSON.parse(localStorage.getItem('bt_pending_del') || '[]'));
    pendingTimers  = JSON.parse(localStorage.getItem('bt_pending_timers') || '{}');
  } catch { pendingSyncIds = new Set(); pendingDeletes = new Set(); pendingTimers = {}; }
}

function saveSyncQueues() {
  localStorage.setItem('bt_pending_sync', JSON.stringify([...pendingSyncIds]));
  localStorage.setItem('bt_pending_del', JSON.stringify([...pendingDeletes]));
  localStorage.setItem('bt_pending_timers', JSON.stringify(pendingTimers));
}

// ── PROFILES ─────────────────────────────────────────────────────────────────
function loadProfiles() {
  try { profiles = JSON.parse(localStorage.getItem('bt_profiles') || '[]'); } catch { profiles = []; }
  activeProfileId = localStorage.getItem('bt_active_profile');
  if (profiles.length === 0) {
    const p = { id: crypto.randomUUID(), name: 'Mon bébé', emoji: '👶', familyId: null };
    profiles = [p]; activeProfileId = p.id; saveProfiles();
  }
  if (!activeProfileId || !profiles.find(p => p.id === activeProfileId))
    activeProfileId = profiles[0].id;
    
  loadSyncQueues();
  try { lastBottleVol = parseInt(localStorage.getItem('bt_last_bottle_vol') || '0', 10) || 0; } catch { lastBottleVol = 0; }
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

// ── SYNC DOT ─────────────────────────────────────────────────────────────────
function setSyncDot(state) {
  document.getElementById('sync-dot').className = 'sync-dot ' + state;
}

// ── LOG ACTIONS ───────────────────────────────────────────────────────────────
async function logAction(log) {
  log.id = crypto.randomUUID();
  log.updated_at = new Date().toISOString(); // Assure la compatibilité Delta Sync
  if (familyId) log.family_id  = familyId;
  else          log.profile_id = activeProfileId;
  allLogs.push(log);
  renderCurrentTab();
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
  log.updated_at = new Date().toISOString();
  const idx = allLogs.findIndex(l => l.id === log.id);
  if (idx >= 0) allLogs[idx] = log;
  renderCurrentTab();
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
  renderCurrentTab();
  await dbDel(id);

  pendingDeletes.add(id); 
  pendingSyncIds.delete(id);
  saveSyncQueues();

  if (supabaseClient && navigator.onLine && familyId) {
    setSyncDot('syncing');
    const { error } = await supabaseClient.from('logs').delete().eq('id', id);
    if (!error) { pendingDeletes.delete(id); saveSyncQueues(); setSyncDot('ok'); setTimeout(() => setSyncDot(''), 2000); }
    else setSyncDot('error');
  }
}

// ── TIMER HELPERS ─────────────────────────────────────────────────────────────
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