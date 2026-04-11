// ── sync.js (Phase 2) ─────────────────────────────────────────────────────────
// Interactions Supabase : init, sync complète, canaux realtime, timers distants,
// sync nom/emoji bébé via la table `families`.
// Références DOM remplacées par window.app (Alpine) depuis la Phase 1.
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

// ── SYNC COMPLÈTE ─────────────────────────────────────────────────────────────
async function syncWithRemote() {
  if (!navigator.onLine || !supabaseClient || !familyId) return;
  setSyncDot('syncing');
  try {
    if (pendingDeletes.size > 0) {
      for (const id of pendingDeletes)
        await supabaseClient.from('logs').delete().eq('id', id);
      pendingDeletes.clear(); saveSyncQueues();
    }
    if (pendingSyncIds.size > 0) {
      const toPush = allLogs.filter(l => pendingSyncIds.has(l.id));
      if (toPush.length > 0) {
        const { error } = await supabaseClient.from('logs')
          .upsert(toPush.map(l => ({ ...l, family_id: familyId })));
        if (!error) pendingSyncIds.clear();
      }
      saveSyncQueues();
    }
    const { data, error } = await supabaseClient
      .from('logs').select('*').eq('family_id', familyId);
    if (error) throw error;
    if (data) {
      allLogs = data; renderAll();
      await dbClear();
      for (const l of data) await dbPut(l);
    }
    await syncTimersFromRemote();
    await syncBabyNameFromRemote();
    setSyncDot('ok');
    setTimeout(() => setSyncDot(''), 3000);
  } catch (e) {
    console.error('Sync error:', e);
    setSyncDot('error');
  }
}

// ── SYNC TIMERS ───────────────────────────────────────────────────────────────
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
  const sa = timers.find(t => t.type === 'sleep' && (t.side === 'none' || !t.side));
  if (sa && !sleepActive)      activateSleepTimerLocal(toMs(sa.start_time));
  else if (!sa && sleepActive) stopSleepTimerLocal();
}

async function setRemoteTimer(type, side, startTime) {
  if (!supabaseClient || !navigator.onLine || !familyId) return;
  const dbSide = side || 'none';
  if (startTime !== null) {
    await supabaseClient.from('active_timers').upsert({
      family_id: familyId, type, side: dbSide, start_time: startTime
    });
  } else {
    await supabaseClient.from('active_timers').delete()
      .eq('family_id', familyId).eq('type', type).eq('side', dbSide);
  }
}

// ── SYNC NOM / EMOJI BÉBÉ ─────────────────────────────────────────────────────
async function pushBabyNameToRemote() {
  if (!supabaseClient || !navigator.onLine || !familyId) return;
  const p = getActiveProfile();
  await supabaseClient.from('families').upsert({ id: familyId, baby_name: p.name, baby_emoji: p.emoji });
}

async function syncBabyNameFromRemote() {
  if (!supabaseClient || !familyId) return;
  const { data } = await supabaseClient
    .from('families').select('baby_name,baby_emoji').eq('id', familyId).maybeSingle();
  if (!data) return;
  const p = getActiveProfile(); let changed = false;
  if (data.baby_name  && data.baby_name  !== p.name)  { p.name  = data.baby_name;  changed = true; }
  if (data.baby_emoji && data.baby_emoji !== p.emoji) { p.emoji = data.baby_emoji; changed = true; }
  if (changed) { saveProfiles(); updateHeaderProfile(); }
}

// ── REALTIME ─────────────────────────────────────────────────────────────────
function setupRealtime() {
  if (!supabaseClient) return;
  _realtimeChannels.forEach(ch => supabaseClient.removeChannel(ch));
  _realtimeChannels = [];

  const timerCh = supabaseClient.channel('rt-timers-' + familyId)
    .on('postgres_changes', { event:'*', schema:'public', table:'active_timers', filter:`family_id=eq.${familyId}` },
      ({ eventType, new:n, old:o }) => {
        if (eventType === 'INSERT' || eventType === 'UPDATE') {
          if (!n) return;
          if (n.type === 'feed') activateBreastTimerLocal(n.side, toMs(n.start_time));
          else                   activateSleepTimerLocal(toMs(n.start_time));
        } else if (eventType === 'DELETE') {
          if (!o) return;
          if (o.side === 'none' || o.type === 'sleep') stopSleepTimerLocal();
          else stopBreastTimerLocal(o.side);
        }
      }).subscribe();

  const logCh = supabaseClient.channel('rt-logs-' + familyId)
    .on('postgres_changes', { event:'*', schema:'public', table:'logs', filter:`family_id=eq.${familyId}` },
      ({ eventType, new:n, old:o }) => {
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

  const famCh = supabaseClient.channel('rt-families-' + familyId)
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'families', filter:`id=eq.${familyId}` },
      ({ new:n }) => {
        if (!n) return;
        const p = getActiveProfile(); let changed = false;
        if (n.baby_name  && n.baby_name  !== p.name)  { p.name  = n.baby_name;  changed = true; }
        if (n.baby_emoji && n.baby_emoji !== p.emoji) { p.emoji = n.baby_emoji; changed = true; }
        if (changed) { saveProfiles(); updateHeaderProfile(); showToast(`Profil mis à jour : ${p.name}`); }
      }).subscribe();

  _realtimeChannels = [timerCh, logCh, famCh];
}

// ── CRÉATION / REJOINDRE FAMILLE ──────────────────────────────────────────────
async function createFamily() {
  if (!SUPABASE_URL || SUPABASE_URL === 'VOTRE_SUPABASE_URL') {
    showToast('Configuration Supabase manquante'); return;
  }
  const newFamilyId = crypto.randomUUID();
  const tmp = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  const p = getActiveProfile();
  await tmp.from('families').insert({ id:newFamilyId, baby_name:p.name, baby_emoji:p.emoji }).maybeSingle();
  p.familyId = newFamilyId; saveProfiles(); familyId = newFamilyId;
  if (window.app) { window.app.syncModalOpen = false; window.app.showShareBtn = true; }
  initSupabase();
  if (allLogs.length > 0) {
    setSyncDot('syncing');
    await supabaseClient.from('logs').upsert(
      allLogs.map(l => ({ ...l, id:l.id||crypto.randomUUID(), family_id:newFamilyId }))
    );
    setSyncDot('ok'); setTimeout(() => setSyncDot(''), 2000);
  }
  showToast('Famille créée !');
}

async function joinFamily() {
  const code = document.getElementById('invite-code').value.trim();
  if (!code || code.length < 20) { showToast('Code invalide'); return; }
  const p = getActiveProfile();
  p.familyId = code; saveProfiles(); familyId = code;
  if (window.app) { window.app.syncModalOpen = false; window.app.showShareBtn = true; }
  initSupabase();
  showToast('Famille rejointe, synchronisation…');
}

function skipSync() {
  if (window.app) window.app.syncModalOpen = false;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function toMs(v) {
  if (!v) return Date.now();
  if (typeof v === 'number') return v;
  return new Date(v).getTime();
}
