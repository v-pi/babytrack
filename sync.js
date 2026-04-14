// ── sync.js ───────────────────────────────────────────────────────────────────
// All Supabase interactions: init, full sync, realtime channels, timer remote
// ops, baby-name/emoji sync via the `families` table.
//
// Depends on globals from state.js:
//   familyId, activeProfileId, allLogs, pendingSyncIds,
//   breastActive, sleepActive,
//   activateBreastTimerLocal, stopBreastTimerLocal,
//   activateSleepTimerLocal, stopSleepTimerLocal,
//   renderCurrentTab, setSyncDot, showToast, getActiveProfile, updateHeaderProfile,
//   saveProfiles, profiles
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://vcufbfvqtfgrcjjxbhee.supabase.co';
const SUPABASE_KEY = 'sb_publishable_EUJrpx_XbBds3EPk1rCtmQ_3qTWTaOX';

let supabaseClient = null;
let _realtimeChannels = [];

// ── ANONYMOUS AUTH ────────────────────────────────────────────────────────────
// Called once at app start (see bottom of file).
// Signs in anonymously so every Supabase request carries a valid JWT.
// The session is persisted in localStorage by the Supabase SDK and is
// automatically refreshed — completely transparent to the user.
async function ensureAnonAuth() {
  if (!window.supabase) return;
  try {
    // Temporary client with no custom headers — only used to establish the
    // auth session. The session token is stored in localStorage under the
    // project-specific key 'sb-<ref>-auth-token' and picked up by all
    // subsequent createClient() calls automatically.
    const authClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data: { session } } = await authClient.auth.getSession();
    if (!session) {
      await authClient.auth.signInAnonymously();
    }
  } catch (e) {
    // Non-fatal: app works offline, auth will retry on next sync.
    console.warn('[BabyTrack] Anon auth skipped (offline?):', e.message);
  }
}

// ── SUPABASE CLIENT INIT ──────────────────────────────────────────────────────
async function initSupabase() {
  // Guarantee a session exists before creating the main client.
  // If the user is offline this is a fast no-op.
  await ensureAnonAuth();

  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: {
      // x-family-id is our second layer of access control (RLS policy).
      // The JWT from anon auth is the first layer — added automatically.
      headers: { 'x-family-id': familyId || '' }
    }
  });
  syncWithRemote();
  setupRealtime();
}

// ── FULL SYNC ────────────────────────────────────────────────────────────────
async function syncWithRemote() {
  if (!navigator.onLine || !supabaseClient || !familyId) return;
  setSyncDot('syncing');
  try {
    // 1. Exécuter les suppressions en attente (prioritaire)
    if (pendingDeletes.size > 0) {
      for (const id of pendingDeletes) {
        await supabaseClient.from('logs').delete().eq('id', id);
      }
      pendingDeletes.clear();
      saveSyncQueues();
    }

    // 2. Pousser les créations/modifications en attente
    if (pendingSyncIds.size > 0) {
      const toPush = allLogs.filter(l => pendingSyncIds.has(l.id));
      if (toPush.length > 0) {
        const { error } = await supabaseClient.from('logs')
          .upsert(toPush.map(l => ({ ...l, family_id: familyId })));
        if (!error) pendingSyncIds.clear();
      }
      saveSyncQueues();
    }

    // 3. Pousser les chronos en attente hors ligne
    await pushPendingTimers();

    // 4. Récupérer les ID pour détecter les suppressions externes (très léger en data)
    const { data: serverIds } = await supabaseClient.from('logs').select('id').eq('family_id', familyId);
    let uiChanged = false;
    
    if (serverIds) {
      const serverIdSet = new Set(serverIds.map(x => x.id));
      // Filtre les logs locaux effacés à distance (et pas en cours d'ajout chez nous)
      const toDelete = allLogs.filter(l => !serverIdSet.has(l.id) && !pendingSyncIds.has(l.id));
      for (const dLog of toDelete) {
        allLogs = allLogs.filter(l => l.id !== dLog.id);
        await dbDel(dLog.id);
        uiChanged = true;
      }
    }

    // 5. Delta Sync (récupérer uniquement ce qui a changé depuis la dernière fois)
    const syncKey = 'bt_last_sync_' + familyId;
    const lastSync = allLogs.length > 0 ? (localStorage.getItem(syncKey) || '1970-01-01T00:00:00Z') : '1970-01-01T00:00:00Z';
    
    const { data: recentData, error } = await supabaseClient
      .from('logs').select('*')
      .eq('family_id', familyId)
      .gte('updated_at', lastSync);
      
    if (error) throw error;

    if (recentData && recentData.length > 0) {
      for (const sLog of recentData) {
        const idx = allLogs.findIndex(l => l.id === sLog.id);
        // Eviter d'écraser une modif locale non encore envoyée (Race condition fix)
        if (!pendingSyncIds.has(sLog.id) && !pendingDeletes.has(sLog.id)) {
          if (idx >= 0) allLogs[idx] = sLog;
          else allLogs.push(sLog);
          await dbPut(sLog);
          uiChanged = true;
        }
      }
    }
    
    // MAJ de l'horodatage avec une marge de 5 secondes de sécurité
    localStorage.setItem(syncKey, new Date(Date.now() - 5000).toISOString());
    if (uiChanged) renderCurrentTab();

    // 6. Synchroniser les chronomètres en cours
    await syncTimersFromRemote();

    // 7. Synchroniser le profil
    await syncBabyNameFromRemote();

    setSyncDot('ok');
    setTimeout(() => setSyncDot(''), 3000);
  } catch (e) {
    console.error('Sync error:', e);
    setSyncDot('error');
  }
}

// ── TIMER SYNC ───────────────────────────────────────────────────────────────
async function pushPendingTimers() {
  if (!supabaseClient || !navigator.onLine || !familyId) return;
  for (const key of Object.keys(pendingTimers)) {
    const pt = pendingTimers[key];
    const dbSide = pt.side || 'none';
    let err;
    if (pt.startTime !== null) {
      const { error } = await supabaseClient.from('active_timers').upsert({
        family_id: familyId, type: pt.type, side: dbSide, start_time: pt.startTime
      });
      err = error;
    } else {
      const { error } = await supabaseClient.from('active_timers')
        .delete().eq('family_id', familyId).eq('type', pt.type).eq('side', dbSide);
      err = error;
    }
    if (!err) {
      delete pendingTimers[key];
      saveSyncQueues();
    }
  }
}

async function setRemoteTimer(type, side, startTime) {
  const key = type + '_' + (side || 'none');
  pendingTimers[key] = { type, side, startTime };
  saveSyncQueues();
  pushPendingTimers(); // Lance la synchro en fond, ou garde en attente si hors ligne
}

async function syncTimersFromRemote() {
  if (!supabaseClient || !familyId) return;
  const { data: timers } = await supabaseClient
    .from('active_timers').select('*').eq('family_id', familyId);
  if (!timers) return;

  // Sync Allaitement
  ['left', 'right'].forEach(side => {
    if (pendingTimers['feed_' + side]) return; // On ignore si un chrono local est en attente
    const a = timers.find(t => t.type === 'feed' && t.side === side);
    if (a && !breastActive[side]) activateBreastTimerLocal(side, toMs(a.start_time));
    else if (!a && breastActive[side]) stopBreastTimerLocal(side);
  });

  // Sync Sommeil
  if (!pendingTimers['sleep_none']) {
    const sa = timers.find(t => t.type === 'sleep' && (t.side === 'none' || !t.side));
    if (sa && !sleepActive)       activateSleepTimerLocal(toMs(sa.start_time));
    else if (!sa && sleepActive)  stopSleepTimerLocal();
  }
}

// ── BABY NAME / EMOJI SYNC ───────────────────────────────────────────────────
/**
 * Push the active profile's name + emoji into the `families` table.
 * Called after every profile save and on createFamily.
 */
async function pushBabyNameToRemote() {
  if (!supabaseClient || !navigator.onLine || !familyId) return;
  const p = getActiveProfile();
  await supabaseClient.from('families').upsert({
    id: familyId,
    baby_name:  p.name,
    baby_emoji: p.emoji
  });
}

/**
 * Pull baby name + emoji from `families` and update the local profile if
 * they differ. This keeps both devices in sync when one parent renames the baby.
 */
async function syncBabyNameFromRemote() {
  if (!supabaseClient || !familyId) return;
  const { data } = await supabaseClient
    .from('families').select('baby_name,baby_emoji').eq('id', familyId).maybeSingle();
  if (!data) return;
  const p = getActiveProfile();
  let changed = false;
  if (data.baby_name  && data.baby_name  !== p.name)  { p.name  = data.baby_name;  changed = true; }
  if (data.baby_emoji && data.baby_emoji !== p.emoji) { p.emoji = data.baby_emoji; changed = true; }
  if (changed) { saveProfiles(); updateHeaderProfile(); }
}

// ── REALTIME ─────────────────────────────────────────────────────────────────
function setupRealtime() {
  if (!supabaseClient) return;
  _realtimeChannels.forEach(ch => supabaseClient.removeChannel(ch));
  _realtimeChannels = [];

  const ch = supabaseClient.channel('rt-' + familyId)
    // ── Active timers ──────────────────────────────────────────────────────
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'active_timers',
      filter: `family_id=eq.${familyId}`
    }, ({ eventType, new: n, old: o }) => {
      if (eventType === 'INSERT' || eventType === 'UPDATE') {
        if (!n || pendingTimers[n.type + '_' + n.side]) return; // Ignorer si local override
        if (n.type === 'feed') activateBreastTimerLocal(n.side, toMs(n.start_time));
        else                   activateSleepTimerLocal(toMs(n.start_time));
      } else if (eventType === 'DELETE') {
        if (!o || pendingTimers[o.type + '_' + o.side]) return;
        if (o.side === 'none' || o.type === 'sleep') stopSleepTimerLocal();
        else stopBreastTimerLocal(o.side);
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'logs', filter: `family_id=eq.${familyId}` }, ({ eventType, new: n, old: o }) => {
      if (eventType === 'INSERT' || eventType === 'UPDATE') {
        if (pendingSyncIds.has(n.id)) return; // Ignorer l'écho de sa propre action
        const idx = allLogs.findIndex(l => l.id === n.id);
        if (idx >= 0) allLogs[idx] = n; else allLogs.push(n);
        dbPut(n); renderCurrentTab();
      } else if (eventType === 'DELETE') {
        if (pendingDeletes.has(o.id)) return;
        allLogs = allLogs.filter(l => l.id !== o.id); dbDel(o.id); renderCurrentTab();
      }
    })
    // ── Families (nom / emoji bébé depuis l'autre appareil) ───────────────
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'families',
      filter: `id=eq.${familyId}`
    }, ({ new: n }) => {
      if (!n) return;
      const p = getActiveProfile();
      let changed = false;
      if (n.baby_name  && n.baby_name  !== p.name)  { p.name  = n.baby_name;  changed = true; }
      if (n.baby_emoji && n.baby_emoji !== p.emoji) { p.emoji = n.baby_emoji; changed = true; }
      if (changed) { saveProfiles(); updateHeaderProfile(); showToast(`Profil mis à jour : ${p.name}`); }
    })
    .subscribe();

  _realtimeChannels = [ch];
}

// ── FAMILY CREATION / JOIN ───────────────────────────────────────────────────
async function createFamily() {
  if (!SUPABASE_URL || SUPABASE_URL === 'VOTRE_SUPABASE_URL') {
    showToast('Configuration Supabase manquante'); return;
  }
  const newFamilyId = crypto.randomUUID();
  const p = getActiveProfile();

  // Ensure the anon session exists before the INSERT so the trigger's
  // auth.uid() check passes and auth_user_id can be populated.
  await ensureAnonAuth();

  const tmp = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { 'x-family-id': newFamilyId } }
  });

  await tmp.from('families').insert({
    id: newFamilyId, baby_name: p.name, baby_emoji: p.emoji
  }).maybeSingle();

  p.familyId = newFamilyId;
  saveProfiles();
  familyId = newFamilyId;

  document.getElementById('sync-modal').classList.remove('open');
  document.getElementById('btn-share').style.display = 'block';

  initSupabase();

  if (allLogs.length > 0) {
    setSyncDot('syncing');
    await supabaseClient.from('logs').upsert(
      allLogs.map(l => ({ ...l, id: l.id || crypto.randomUUID(), family_id: newFamilyId }))
    );
    setSyncDot('ok'); setTimeout(() => setSyncDot(''), 2000);
  }
  showToast('Famille créée !');
}

async function joinFamily() {
  const code = document.getElementById('invite-code').value.trim();
  if (!code || code.length < 20) { showToast('Code invalide'); return; }
  const p = getActiveProfile();
  p.familyId = code;
  saveProfiles();
  familyId = code;
  document.getElementById('sync-modal').classList.remove('open');
  document.getElementById('btn-share').style.display = 'block';
  initSupabase();
  showToast('Famille rejointe, synchronisation…');
}

function skipSync() {
  document.getElementById('sync-modal').classList.remove('open');
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
/** Normalise a Supabase timestamp (ISO string or ms number) to ms. */
function toMs(v) {
  if (!v) return Date.now();
  if (typeof v === 'number') return v;
  return new Date(v).getTime();
}

// ── AUTO-INIT ANON AUTH ON PAGE LOAD ─────────────────────────────────────────
// Runs as soon as this script is parsed. Establishes the JWT session in the
// background so it is ready before the user ever taps "Créer ma famille".
// Safe to call multiple times (no-op if a session already exists).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ensureAnonAuth);
} else {
  ensureAnonAuth();
}
