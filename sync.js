// ── sync.js ───────────────────────────────────────────────────────────────────
// All Supabase interactions: init, full sync, realtime channels, timer remote
// ops, baby-name/emoji sync via the `families` table.
//
// Depends on globals from state.js:
//   familyId, activeProfileId, allLogs, pendingSyncIds,
//   breastActive, sleepActive,
//   activateBreastTimerLocal, stopBreastTimerLocal,
//   activateSleepTimerLocal, stopSleepTimerLocal,
//   renderAll, setSyncDot, showToast, getActiveProfile, updateHeaderProfile,
//   saveProfiles, profiles
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://vcufbfvqtfgrcjjxbhee.supabase.co';
const SUPABASE_KEY = 'sb_publishable_EUJrpx_XbBds3EPk1rCtmQ_3qTWTaOX';

let supabaseClient = null;
let _realtimeChannels = [];

function initSupabase() {
  if (!SUPABASE_URL || SUPABASE_URL === 'VOTRE_SUPABASE_URL') return;
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
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

    // 3. Récupérer l'historique complet depuis le serveur
    // Écraser la base locale permet de supprimer automatiquement les éventuels "zombies"
    const { data, error } = await supabaseClient
      .from('logs').select('*').eq('family_id', familyId);
    if (error) throw error;
    if (data) {
      allLogs = data;
      renderAll();
      await dbClear();
      for (const l of data) await dbPut(l);
    }

    // 4. Synchroniser les chronomètres en cours
    await syncTimersFromRemote();

    // 5. Synchroniser le profil (nom / emoji bébé)
    await syncBabyNameFromRemote();

    setSyncDot('ok');
    setTimeout(() => setSyncDot(''), 3000);
  } catch (e) {
    console.error('Sync error:', e);
    setSyncDot('error');
  }
}

// ── TIMER SYNC ───────────────────────────────────────────────────────────────
async function syncTimersFromRemote() {
  if (!supabaseClient || !familyId) return;
  const { data: timers } = await supabaseClient
    .from('active_timers').select('*').eq('family_id', familyId);
  if (!timers) return;

  ['left', 'right'].forEach(side => {
    const a = timers.find(t => t.type === 'feed' && t.side === side);
    if (a && !breastActive[side]) activateBreastTimerLocal(side, toMs(a.start_time));
    else if (!a && breastActive[side]) stopBreastTimerLocal(side);
  });
  const sa = timers.find(t => t.type === 'sleep');
  if (sa && !sleepActive)       activateSleepTimerLocal(toMs(sa.start_time));
  else if (!sa && sleepActive)  stopSleepTimerLocal();
}

/** Upsert or delete a timer row on Supabase. */
async function setRemoteTimer(type, side, startTime) {
  if (!supabaseClient || !navigator.onLine || !familyId) return;
  if (startTime !== null) {
    await supabaseClient.from('active_timers').upsert({
      family_id: familyId, type, side: side || null, start_time: startTime
    });
  } else {
    let q = supabaseClient.from('active_timers')
      .delete().eq('type', type).eq('family_id', familyId);
    if (side) q = q.eq('side', side);
    await q;
  }
}

// ── BABY NAME / EMOJI SYNC ───────────────────────────────────────────────────
/**
 * Push the active profile's name + emoji into the `families` table.
 * Called after every profile save and on createFamily.
 * Requires baby_name and baby_emoji columns (see 3.sql migration).
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

  // Active timers channel
  const timerCh = supabaseClient.channel('rt-timers-' + familyId)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'active_timers',
      filter: `family_id=eq.${familyId}`
    }, payload => {
      const { eventType, new: n, old: o } = payload;
      if (eventType === 'INSERT' || eventType === 'UPDATE') {
        if (!n) return;
        if (n.type === 'feed') activateBreastTimerLocal(n.side, toMs(n.start_time));
        else                   activateSleepTimerLocal(toMs(n.start_time));
      } else if (eventType === 'DELETE') {
        if (!o) return;
        if (o.type === 'feed') stopBreastTimerLocal(o.side);
        else                   stopSleepTimerLocal();
      }
    }).subscribe();

  // Logs channel
  const logCh = supabaseClient.channel('rt-logs-' + familyId)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'logs',
      filter: `family_id=eq.${familyId}`
    }, payload => {
      const { eventType, new: n, old: o } = payload;
      if (eventType === 'INSERT') {
        if (!allLogs.find(l => l.id === n.id)) { allLogs.push(n); dbPut(n); renderAll(); }
      } else if (eventType === 'DELETE') {
        allLogs = allLogs.filter(l => l.id !== o.id); dbDel(o.id); renderAll();
      } else if (eventType === 'UPDATE') {
        const idx = allLogs.findIndex(l => l.id === n.id);
        if (idx >= 0) allLogs[idx] = n; else allLogs.push(n);
        dbPut(n); renderAll();
      }
    }).subscribe();

  // Families channel (baby name + emoji changes from other device)
  const famCh = supabaseClient.channel('rt-families-' + familyId)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'families',
      filter: `id=eq.${familyId}`
    }, payload => {
      const { new: n } = payload;
      if (!n) return;
      const p = getActiveProfile();
      let changed = false;
      if (n.baby_name  && n.baby_name  !== p.name)  { p.name  = n.baby_name;  changed = true; }
      if (n.baby_emoji && n.baby_emoji !== p.emoji) { p.emoji = n.baby_emoji; changed = true; }
      if (changed) { saveProfiles(); updateHeaderProfile(); showToast(`Profil mis à jour : ${p.name}`); }
    }).subscribe();

  _realtimeChannels = [timerCh, logCh, famCh];
}

// ── FAMILY CREATION / JOIN ───────────────────────────────────────────────────
async function createFamily() {
  if (!SUPABASE_URL || SUPABASE_URL === 'VOTRE_SUPABASE_URL') {
    showToast('Configuration Supabase manquante'); return;
  }
  const newFamilyId = crypto.randomUUID();
  const tmp = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  const p = getActiveProfile();

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
