// ── state.js ──────────────────────────────────────────────────────────────────
// État global, profils, persistance des sessions de chrono, CRUD des logs.
// Aucun rendu DOM ici : données et helpers d'état uniquement.
// ─────────────────────────────────────────────────────────────────────────────

const EMOJIS = ['👶','🧒','🐣','🌟','🌈','🦋','🐧','🐻','🦊','🐼','🍭','🌸'];

// ── ÉTAT GLOBAL ──────────────────────────────────────────────────────────────
let profiles         = [];
let activeProfileId  = null;
let familyId         = null;
let allLogs          = [];
let pendingSyncIds   = new Set(); // Logs à ajouter/modifier sur le serveur
let pendingDeletes   = new Set(); // Legacy : non alimenté, conservé pour compatibilité
let pendingTimers    = {};        // Une écriture en attente par chrono : { 'feed_left': job } (sync.js)
let closedSessions   = new Set(); // sid des sessions déjà terminées sur cet appareil
let timerEpoch       = 0;         // Incrémenté à chaque action locale sur un chrono
let breastActive     = { left: null, right: null };
let sleepActive      = null;
let ticks            = {};
let editingLog       = null;
let editingProfileId = null;
let currentTab       = 'feed';
let diaperSelection  = { wet: false, dirty: false };
let lastBottleVol    = 0;
let toastTO;
let tlDate   = todayStart();
let histDate = { feed: todayStart(), bottle: todayStart(), sleep: todayStart(), diaper: todayStart() };
let statsRangeDays = 30; // Fenêtre (en jours) utilisée par les graphs de l'onglet Stats
const TICK_LAST_FEED   = 'last-feed-global';
const TICK_LAST_BOTTLE = 'last-bottle-global';

// ── SESSIONS DE CHRONO ───────────────────────────────────────────────────────
// Une session = une période de chrono, identifiée par un sid (UUID créé au démarrage).
//   sid         : identifiant unique, aussi id du log produit à l'arrêt
//   origin      : début de la session, inchangé par pause et reprise
//   start       : début du segment courant (null en pause)
//   accumulated : durée des segments précédents (ms)
//   paused      : true en pause (chrono de tétée uniquement)
//   seen        : true une fois la session observée sur le serveur
function timerKey(type, side) { return type + '_' + (side || 'none'); }

/** Session locale d'un type/côté, ou null. Retourne { type, side, key, s } ; s est l'objet de session. */
function localSession(type, side) {
  if (type === 'feed') {
    return breastActive[side] ? { type, side, key: timerKey(type, side), s: breastActive[side] } : null;
  }
  return sleepActive ? { type: 'sleep', side: null, key: 'sleep_none', s: sleepActive } : null;
}

function allLocalSessions() {
  return [localSession('feed', 'left'), localSession('feed', 'right'), localSession('sleep', null)].filter(Boolean);
}

/** Vrai si la session a gagne sur b : début plus tardif, à égalité sid le plus grand. */
function isNewer(a, b) {
  return a.origin > b.origin || (a.origin === b.origin && a.sid > b.sid);
}

function newestLocal() {
  return allLocalSessions().reduce((best, l) => (!best || isNewer(l.s, best.s) ? l : best), null);
}

function markClosed(sid) {
  closedSessions.add(sid);
  if (closedSessions.size > 200) closedSessions = new Set([...closedSessions].slice(-200));
}

/** Session persistée (ancien ou nouveau format) → session valide avec un sid stable. */
function normalizeSession(o, type, side) {
  const job    = pendingTimers[timerKey(type, side)];
  const origin = Number(o.origin ?? o.start) || Date.now();
  const paused = type === 'feed' && !!o.paused;
  return {
    sid:         o.sid || (job && job.op === 'upsert' ? job.sid : null) || crypto.randomUUID(),
    origin,
    start:       paused ? null : (Number(o.start) || origin),
    accumulated: type === 'feed' ? (Number(o.accumulated) || 0) : 0,
    paused,
    seen:        !!o.seen,
  };
}

// ── FILES D'ATTENTE (sauvegarde locale) ──────────────────────────────────────
// Format d'une écriture de chrono (job) :
//   { op:'upsert', type, side, sid, origin, start, paused, accumulated }
//   { op:'delete', type, side, sid }   sid null = suppression inconditionnelle (legacy)
function migrateLegacyJob(pt) {
  if (!pt) return null;
  if (pt.op) return pt;                                                 // déjà au nouveau format
  if (pt.startTime === null || pt.startTime === undefined)
    return { op: 'delete', type: pt.type, side: pt.side || null, sid: null };
  return {
    op: 'upsert', type: pt.type, side: pt.side || null, sid: crypto.randomUUID(),
    origin: pt.startTime, start: pt.paused ? null : pt.startTime,
    paused: !!pt.paused, accumulated: pt.accumulated || 0,
  };
}

function loadSyncQueues() {
  try {
    pendingSyncIds = new Set(JSON.parse(localStorage.getItem('bt_pending_sync') || '[]'));
    pendingDeletes = new Set(JSON.parse(localStorage.getItem('bt_pending_del') || '[]'));
    closedSessions = new Set(JSON.parse(localStorage.getItem('bt_closed_sessions') || '[]'));
    const raw = JSON.parse(localStorage.getItem('bt_pending_timers') || '{}');
    pendingTimers = {};
    for (const key of Object.keys(raw)) {
      const job = migrateLegacyJob(raw[key]);
      if (job) pendingTimers[key] = job;
    }
  } catch {
    pendingSyncIds = new Set(); pendingDeletes = new Set();
    pendingTimers  = {};        closedSessions  = new Set();
  }
  saveSyncQueues(); // fige les sid de migration : ils ne doivent pas changer à chaque chargement
}

function saveSyncQueues() {
  localStorage.setItem('bt_pending_sync',    JSON.stringify([...pendingSyncIds]));
  localStorage.setItem('bt_pending_del',     JSON.stringify([...pendingDeletes]));
  localStorage.setItem('bt_pending_timers',  JSON.stringify(pendingTimers));
  localStorage.setItem('bt_closed_sessions', JSON.stringify([...closedSessions]));
}

// ── PROFILS ──────────────────────────────────────────────────────────────────
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

// ── STATS RANGE (durée des graphs) ────────────────────────────────────────────
function loadStatsRange() {
  const v = parseInt(localStorage.getItem('bt_stats_range_days'), 10);
  statsRangeDays = (Number.isFinite(v) && v >= 2 && v <= 365) ? v : 30;
}

function saveStatsRange() {
  localStorage.setItem('bt_stats_range_days', String(statsRangeDays));
}

// ── SYNC DOT ─────────────────────────────────────────────────────────────────
function setSyncDot(state) {
  document.getElementById('sync-dot').className = 'sync-dot ' + state;
}

// ── LOG ACTIONS ───────────────────────────────────────────────────────────────
async function logAction(log) {
  // Un id fourni (sid d'une session) fait qu'une seconde écriture réécrit la même ligne.
  log.id = log.id || crypto.randomUUID();
  log.updated_at = new Date().toISOString(); // Assure la compatibilité Delta Sync
  if (familyId) log.family_id  = familyId;
  else          log.profile_id = activeProfileId;
  const idx = allLogs.findIndex(l => l.id === log.id);
  if (idx >= 0) allLogs[idx] = log; else allLogs.push(log);
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
  // Soft delete : on retire de l'UI et d'IDB immédiatement,
  // mais on marque deleted=true dans Supabase plutôt que de supprimer la ligne.
  // Ainsi le delta sync des autres appareils capte le changement via updated_at.
  allLogs = allLogs.filter(l => l.id !== id);
  renderCurrentTab();
  await dbDel(id);

  // On réutilise pendingSyncIds (pas pendingDeletes) car c'est un upsert, pas un DELETE.
  pendingSyncIds.add(id);
  saveSyncQueues();

  if (supabaseClient && navigator.onLine && familyId) {
    setSyncDot('syncing');
    const { error } = await supabaseClient.from('logs')
      .update({ deleted: true, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (!error) { pendingSyncIds.delete(id); saveSyncQueues(); setSyncDot('ok'); setTimeout(() => setSyncDot(''), 2000); }
    else setSyncDot('error');
  }
}

// ── TIMER HELPERS ─────────────────────────────────────────────────────────────
function startTick(id, fn) { if (ticks[id]) clearInterval(ticks[id]); ticks[id] = setInterval(fn, 1000); fn(); }
function stopTick(id)      { clearInterval(ticks[id]); delete ticks[id]; }
function stopAllTicks()    { Object.keys(ticks).forEach(stopTick); }

// ── PERSISTANCE DES SESSIONS ─────────────────────────────────────────────────
function saveSession() {
  localStorage.setItem('bt_session_' + activeProfileId, JSON.stringify({ breastActive, sleepActive }));
}

function loadSession() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem('bt_session_' + activeProfileId) || 'null'); } catch { s = null; }
  breastActive = { left: null, right: null };
  sleepActive  = null;
  if (!s) return;
  ['left', 'right'].forEach(side => {
    if (s.breastActive && s.breastActive[side]) breastActive[side] = normalizeSession(s.breastActive[side], 'feed', side);
  });
  if (s.sleepActive) sleepActive = normalizeSession(s.sleepActive, 'sleep', null);
}
