// ── sync.js ───────────────────────────────────────────────────────────────────
// All Supabase interactions: init, full sync, realtime channels, timer remote
// ops, baby-name/emoji sync via the `families` table.
//
// Depends on globals from state.js:
//   familyId, activeProfileId, allLogs, pendingSyncIds,
//   breastActive, sleepActive,
//   closeLocal, commitTimerChange, refreshTimerUI,
//   renderCurrentTab, setSyncDot, showToast, getActiveProfile, updateHeaderProfile,
//   saveProfiles, profiles
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://vcufbfvqtfgrcjjxbhee.supabase.co';
const SUPABASE_KEY = 'sb_publishable_EUJrpx_XbBds3EPk1rCtmQ_3qTWTaOX';

// 31-char alphabet: uppercase letters minus I, L, O + digits minus 0, 1.
// Avoids visually ambiguous characters when reading a code aloud or typing it.
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

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
  await ensureAnonAuth();
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: {
      headers: { 'x-family-id': familyId || '' }
    }
  });

  // CRITICAL: await the JWT update BEFORE calling setupRealtime().
  //
  // Supabase Realtime checks RLS via auth.jwt()->'user_metadata'->>'family_id'.
  // If the JWT doesn't carry family_id yet when the WebSocket is opened,
  // the server's RLS check silently fails and NO postgres_changes events are
  // ever delivered — timers and logs appear to never sync in real-time.
  if (familyId) {
    try {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (user && user.user_metadata?.family_id !== familyId) {
        await supabaseClient.auth.updateUser({ data: { family_id: familyId } });
      }
    } catch (e) {
      console.warn('[BabyTrack] JWT family_id update failed (offline?):', e.message);
    }
  }

  syncWithRemote();
  setupRealtime();
}

// ── PAGINATED LOG FETCH ──────────────────────────────────────────────────────
/**
 * Fetch all logs matching a given `updated_at` threshold, paginating by 1000
 * to never silently truncate.
 *
 * @param {string}  since        - ISO timestamp, e.g. '1970-01-01T00:00:00Z'
 * @param {boolean} excludeDeleted - true for initial sync (skip soft-deleted rows),
 *                                   false for delta sync (include them to propagate)
 * @returns {Array} flat array of all matching log rows
 */
async function fetchLogsPaginated(since, excludeDeleted) {
  const PAGE = 1000;
  let from = 0;
  const all = [];

  while (true) {
    let q = supabaseClient
      .from('logs').select('*')
      .eq('family_id', familyId)
      .gte('updated_at', since)
      .order('updated_at', { ascending: true })
      .range(from, from + PAGE - 1);

    if (excludeDeleted) q = q.eq('deleted', false);

    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;

    all.push(...data.map(normalizeLogRow));
    if (data.length < PAGE) break; // dernière page — pas la peine d'en demander une autre
    from += PAGE;
  }

  return all;
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
    await flushAllTimers();

    let uiChanged = false;

    // 5. Delta Sync — récupère tout ce qui a changé depuis la dernière synchro,
    // en paginant par tranches de 1000 pour ne jamais tronquer silencieusement.
    const syncKey = 'bt_last_sync_' + familyId;
    const isInitialSync = allLogs.length === 0;
    const lastSync = isInitialSync
      ? '1970-01-01T00:00:00Z'
      : (localStorage.getItem(syncKey) || '1970-01-01T00:00:00Z');

    const recentData = await fetchLogsPaginated(lastSync, isInitialSync);

    for (const sLog of recentData) {
      const idx = allLogs.findIndex(l => l.id === sLog.id);
      // Éviter d'écraser une modif locale non encore envoyée (race condition)
      if (!pendingSyncIds.has(sLog.id) && !pendingDeletes.has(sLog.id)) {
        if (sLog.deleted) {
          // Soft delete distant : retirer de l'UI et d'IDB
          if (idx >= 0) allLogs = allLogs.filter(l => l.id !== sLog.id);
          await dbDel(sLog.id);
        } else {
          if (idx >= 0) allLogs[idx] = sLog;
          else allLogs.push(sLog);
          await dbPut(sLog);
        }
        uiChanged = true;
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
// Modèle : le serveur porte, pour chaque (type, side), la session en cours (session_id).
// Chaque écriture locale est une job en file. Une seule job par clé, envoyée en série :
// deux écritures d'un même chrono ne peuvent plus se dépasser.
// La lecture serveur (syncTimersFromRemote) est la seule source d'état distant :
// le contenu des échos realtime n'est jamais utilisé directement.

const timerFlushing = {};   // clé -> true pendant l'envoi de sa file
let timerSeq        = 0;
let timerSyncBusy   = false;
let timerSyncAgain  = false;

/** Met une écriture en file. Remplace l'écriture précédente de la même clé. */
function queueTimerJob(job) {
  const key = timerKey(job.type, job.side);
  pendingTimers[key] = { ...job, seq: ++timerSeq };
  saveSyncQueues();
  flushTimerKey(key);
}

/** Envoie une job. Retourne true si le serveur l'a acceptée. */
async function sendTimerJob(job) {
  const dbSide = job.side || 'none';
  if (job.op === 'upsert') {
    const { error } = await supabaseClient.from('active_timers').upsert({
      family_id:   familyId,
      type:        job.type,
      side:        dbSide,
      session_id:  job.sid,
      origin:      job.origin,
      start_time:  job.start ?? job.origin,   // en pause, start_time = origin (convention existante)
      paused:      !!job.paused,
      accumulated: job.accumulated || 0,
    });
    return !error;
  }
  // Suppression conditionnelle à la session : une session plus récente, lancée depuis
  // un autre appareil, n'est jamais effacée par erreur.
  let q = supabaseClient.from('active_timers').delete()
    .eq('family_id', familyId).eq('type', job.type).eq('side', dbSide);
  if (job.sid) q = q.eq('session_id', job.sid);
  const { error } = await q;
  return !error;
}

/** Envoie la file d'une clé, en série. Une job reste en file tant que le serveur ne l'a pas acceptée. */
async function flushTimerKey(key) {
  if (timerFlushing[key]) return;                 // la boucle en cours prendra la nouvelle job
  if (!supabaseClient || !familyId || !navigator.onLine) return;
  timerFlushing[key] = true;
  let sent = false;
  try {
    let job;
    while ((job = pendingTimers[key])) {
      if (!(await sendTimerJob(job))) break;     // reste en file, réessayée à la prochaine synchro
      sent = true;
      // Comparaison d'identité : si une job plus récente est arrivée pendant l'envoi, elle reste.
      if (pendingTimers[key] === job) delete pendingTimers[key];
      saveSyncQueues();
    }
  } catch (e) {
    console.error('[BabyTrack] flush chrono :', e);
  } finally {
    timerFlushing[key] = false;
  }
  if (sent) syncTimersFromRemote();
}

async function flushAllTimers() {
  await Promise.all(Object.keys(pendingTimers).map(flushTimerKey));
}

/** Relit l'état serveur des chronos et le réconcilie avec l'état local. Une passe à la fois. */
async function syncTimersFromRemote() {
  if (!supabaseClient || !familyId || !navigator.onLine) return;
  if (timerSyncBusy) { timerSyncAgain = true; return; }
  timerSyncBusy = true;
  try {
    do {
      timerSyncAgain = false;
      const epoch = timerEpoch;
      const { data: rows, error } = await supabaseClient
        .from('active_timers').select('*').eq('family_id', familyId);
      if (error || !rows) break;
      // Une action locale a eu lieu pendant la lecture : la réponse peut être périmée, on relit.
      if (epoch !== timerEpoch) { timerSyncAgain = true; continue; }
      // Sessions locales terminées ailleurs : on récupère le log que l'autre appareil a déjà écrit.
      const endedElsewhere = await fetchEndedElsewhere(rows);
      if (!endedElsewhere) break;
      if (epoch !== timerEpoch) { timerSyncAgain = true; continue; }
      for (const row of endedElsewhere.values()) await storeServerLog(row);
      reconcileTimers(rows, endedElsewhere);
    } while (timerSyncAgain);
  } finally {
    timerSyncBusy = false;
  }
}

function normalizeRemoteRows(rows) {
  return rows.map(r => {
    const side   = r.side === 'none' ? null : r.side;
    const paused = !!r.paused;
    return {
      type:        r.type,
      side,
      key:         timerKey(r.type, side),
      sid:         r.session_id || null,
      origin:      r.origin != null ? toMs(r.origin) : toMs(r.start_time),
      start:       paused ? null : toMs(r.start_time),
      paused,
      accumulated: Number(r.accumulated) || 0,
    };
  });
}

function upsertJobFor(l) {
  const s = l.s;
  return {
    op: 'upsert', type: l.type, side: l.side, sid: s.sid, origin: s.origin,
    start: s.paused ? null : s.start, paused: !!s.paused, accumulated: s.accumulated || 0,
  };
}

/** Même session, état différent sur le serveur (pause ou reprise faite ailleurs) : on suit le serveur. */
function mergeRemoteState(l, r) {
  if (l.type !== 'feed') return;
  const s = l.s;
  const same = s.paused === r.paused && s.accumulated === r.accumulated && (r.paused || s.start === r.start);
  if (same) return;
  s.paused      = r.paused;
  s.accumulated = r.accumulated;
  s.start       = r.paused ? null : r.start;
  commitTimerChange(l.type, l.side);
}

/** Adopte une session distante : elle devient l'état local. */
function adoptRemote(r) {
  if (r.type === 'feed') {
    breastActive[r.side] = { sid: r.sid, origin: r.origin, start: r.start, accumulated: r.accumulated, paused: r.paused, seen: true };
  } else {
    sleepActive = { sid: r.sid, origin: r.origin, start: r.origin, accumulated: 0, paused: false, seen: true };
  }
  commitTimerChange(r.type, r.side);
}

/**
 * Sessions locales vues ici puis absentes du serveur : elles se sont terminées ailleurs.
 * Retourne, par sid, le log que l'autre appareil a déjà écrit (null en cas d'erreur réseau).
 * Un log supprimé (soft delete) compte aussi : il ne doit pas ressusciter.
 */
async function fetchEndedElsewhere(rows) {
  const onServer = new Set(rows.map(r => r.session_id));
  const gone = allLocalSessions().filter(l => l.s.seen && !onServer.has(l.s.sid) && !pendingTimers[l.key]);
  const found = new Map();
  for (const l of gone) {
    const { data, error } = await supabaseClient.from('logs').select('*').eq('id', l.s.sid).maybeSingle();
    if (error) return null;
    if (data) found.set(l.s.sid, normalizeLogRow(data));
  }
  return found;
}

/** Range dans allLogs et IndexedDB la version serveur d'un log (ou le retire s'il est supprimé). */
async function storeServerLog(row) {
  if (pendingSyncIds.has(row.id)) return;   // une modification locale non envoyée fait foi
  if (row.deleted) {
    allLogs = allLogs.filter(l => l.id !== row.id);
    await dbDel(row.id);
  } else {
    const idx = allLogs.findIndex(l => l.id === row.id);
    if (idx >= 0) allLogs[idx] = row; else allLogs.push(row);
    await dbPut(row);
  }
  renderCurrentTab();
}

/**
 * Compare l'état serveur à l'état local et converge vers une seule session active
 * (la plus récente). Les écritures en attente font foi : on n'applique rien sur leur clé.
 */
function reconcileTimers(rows, endedElsewhere = new Map()) {
  const remote = normalizeRemoteRows(rows);

  // 0. Session terminée ailleurs dont le log existe déjà : on la retire sans rien réécrire,
  // sinon l'heure de fin de l'autre appareil serait remplacée par celle de cette synchro.
  for (const l of allLocalSessions()) {
    if (endedElsewhere.has(l.s.sid)) dropLocalSession(l);
  }

  // 1. Chaque session distante
  for (const r of remote) {
    if (pendingTimers[r.key]) continue;

    // Session déjà terminée ici : son passage sur le serveur est un reliquat à retirer.
    if (r.sid && closedSessions.has(r.sid)) {
      queueTimerJob({ op: 'delete', type: r.type, side: r.side, sid: r.sid });
      continue;
    }

    // Session déjà connue : on applique ce qui a changé ailleurs (pause, reprise).
    const mine = r.sid ? allLocalSessions().find(l => l.s.sid === r.sid) : null;
    if (mine) {
      mine.s.seen = true;
      mergeRemoteState(mine, r);
      continue;
    }

    // Ligne sans session (ancien client) : on la revendique avec un sid.
    if (!r.sid) {
      queueTimerJob({ op: 'upsert', type: r.type, side: r.side, sid: crypto.randomUUID(),
        origin: r.origin, start: r.start, paused: r.paused, accumulated: r.accumulated });
      continue;
    }

    // Session inconnue : conflit avec la plus récente de nos sessions locales ?
    const top = newestLocal();
    if (top && isNewer(top.s, r)) {
      // La nôtre est plus récente : on la réécrit, et on retire la session distante.
      if (!pendingTimers[top.key]) queueTimerJob(upsertJobFor(top));
      if (r.key !== top.key) queueTimerJob({ op: 'delete', type: r.type, side: r.side, sid: r.sid });
      continue;
    }

    // La session distante gagne : nos sessions locales se terminent à son début.
    for (const l of allLocalSessions()) closeLocal(l, r.origin, l.key !== r.key);
    adoptRemote(r);
  }

  // 2. Une seule session active : si plusieurs, la plus récente gagne.
  const locals = allLocalSessions();
  if (locals.length > 1) {
    const top = newestLocal();
    for (const l of locals) if (l.key !== top.key) closeLocal(l, top.s.origin, true);
  }

  // 3. Session vue ici, absente du serveur : elle s'est terminée ailleurs.
  const remoteSids = new Set(remote.map(r => r.sid));
  for (const l of allLocalSessions()) {
    if (l.s.seen && !remoteSids.has(l.s.sid) && !pendingTimers[l.key]) closeLocal(l, Date.now(), false);
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
    // ── Active timers ─────────────────────────────────────────────────────
    // Le contenu de l'événement n'est pas utilisé : on relit l'état serveur (source de vérité).
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'active_timers',
      filter: `family_id=eq.${familyId}`
    }, () => { syncTimersFromRemote(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'logs', filter: `family_id=eq.${familyId}` }, ({ eventType, new: n, old: o }) => {
      if (eventType === 'INSERT' || eventType === 'UPDATE') {
        n = normalizeLogRow(n);   // Realtime envoie les bigint en chaînes
        if (pendingSyncIds.has(n.id)) return; // Ignorer l'écho de sa propre action
        if (n.deleted) {
          // Soft delete distant reçu en temps réel
          allLogs = allLogs.filter(l => l.id !== n.id);
          dbDel(n.id);
        } else {
          const idx = allLogs.findIndex(l => l.id === n.id);
          if (idx >= 0) allLogs[idx] = n; else allLogs.push(n);
          dbPut(n);
        }
        renderCurrentTab();
      } else if (eventType === 'DELETE') {
        // Hard delete (ex: reset complet de la famille via resetCurrentProfile)
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
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('[BabyTrack] Realtime connected for family', familyId);
        // Re-sync timers now that the channel is live. Catches any timer event
        // that fired in the gap between syncWithRemote() completing and the
        // WebSocket subscription being fully established.
        syncTimersFromRemote();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.error('[BabyTrack] Realtime error:', status, err);
        setSyncDot('error');
      } else if (status === 'CLOSED') {
        console.warn('[BabyTrack] Realtime channel closed');
      }
    });

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

  // Client normal
  const tmpClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. On donne l'autorisation au JWT d'écrire dans cette famille
  await tmpClient.auth.updateUser({ data: { family_id: newFamilyId } });

  // 2. Maintenant RLS nous autorise à créer la ligne
  await tmpClient.from('families').insert({
    id: newFamilyId, baby_name: p.name, baby_emoji: p.emoji
  }).maybeSingle();

  p.familyId = newFamilyId;
  saveProfiles();
  familyId = newFamilyId;

  document.getElementById('sync-modal').classList.remove('open');
  document.getElementById('btn-share').classList.add('shown');

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

/**
 * Generate a short invite code and store it in `invite_codes`.
 * Returns { raw, display, expiresAt } on success, null on failure.
 *
 * raw     — 7-char string stored in DB and embedded in URLs  e.g. "MJKNPQ4"
 * display — formatted for human reading                      e.g. "MJK-NPQ4"
 * expiresAt — ISO string, now + 10 minutes
 */
async function createInviteCode() {
  if (!supabaseClient || !familyId) return null;
  // Guard : si le JWT n'a pas encore family_id (race avec initSupabase),
  // on force le updateUser avant d'écrire.
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (user?.user_metadata?.family_id !== familyId) {
      await supabaseClient.auth.updateUser({ data: { family_id: familyId } });
    }
  } catch (_) {}
  // Generate 7 chars from INVITE_ALPHABET using rejection sampling to
  // avoid modulo bias (31 doesn't divide 256 evenly).
  const raw = (() => {
    const len = INVITE_ALPHABET.length; // 31
    const threshold = 256 - (256 % len); // 248 — values ≥ 248 are rejected
    let result = '';
    while (result.length < 7) {
      const arr = new Uint8Array(14); // over-generate to minimise rounds
      crypto.getRandomValues(arr);
      for (const b of arr) {
        if (b < threshold) result += INVITE_ALPHABET[b % len];
        if (result.length === 7) break;
      }
    }
    return result;
  })();

  const display   = raw.slice(0, 3) + '-' + raw.slice(3); // "XXX-XXXX"
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { error } = await supabaseClient.from('invite_codes').insert({
    code:      raw,
    family_id: familyId,
    expires_at: expiresAt
  });

  if (error) {
    console.error('[BabyTrack] createInviteCode error:', error);
    return null;
  }

  return { raw, display, expiresAt };
}

/**
 * Resolve a short invite code to a family_id and join that family.
 * Uses x-invite-code header so the RLS SELECT policy only returns the
 * matching row — no enumeration possible without the exact code.
 */
async function joinFamily() {
  const raw = document.getElementById('invite-code').value
    .trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (raw.length !== 7) { showToast('Code invalide — 7 caractères attendus'); return; }

  setSyncDot('syncing');
  await ensureAnonAuth();

  // Temp client carrying the invite code as a header.
  // The RLS SELECT policy on invite_codes matches `code = x-invite-code header`,
  // so this query returns exactly one row (or zero if wrong/expired).
  const tmp = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { 'x-invite-code': raw } }
  });

  const { data, error } = await tmp
    .from('invite_codes')
    .select('family_id')
    .eq('code', raw)
    .maybeSingle();

  if (error || !data) {
    setSyncDot('error');
    showToast('Code invalide ou expiré');
    return;
  }

  const p = getActiveProfile();
  p.familyId = data.family_id;
  saveProfiles();
  familyId = data.family_id;

  document.getElementById('sync-modal').classList.remove('open');
  document.getElementById('btn-share').classList.add('shown');
  setSyncDot('');
  initSupabase();
  showToast('Famille rejointe, synchronisation…');
}

function skipSync() {
  document.getElementById('sync-modal').classList.remove('open');
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
/**
 * Normalise a Supabase value to milliseconds.
 *
 * Supabase REST API  → bigint columns arrive as JS numbers  (e.g. 1745123456789)
 * Supabase Realtime  → bigint columns arrive as JSON strings (e.g. "1745123456789")
 *
 * new Date("1745123456789") returns Invalid Date in most browsers, so we must
 * detect numeric strings and convert them via Number() first.
 */
function toMs(v) {
  if (v === null || v === undefined || v === '') return Date.now();
  if (typeof v === 'number') return v;
  const n = Number(v);              // "1745123456789" → 1745123456789
  if (!isNaN(n) && n > 0) return n;
  return new Date(v).getTime();     // ISO strings e.g. "2025-04-22T10:00:00Z"
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
