// ── js/db.js ─────────────────────────────────────────────────────────────────
// IndexedDB wrapper. Scoped to the current profile/family via global vars
// `familyId` and `activeProfileId` (set by app.js before any call).
//
// v4 migration: adds `by_family` and `by_profile` indexes so reads never
// load the full store into RAM — critical once logs reach 3 000–4 000 entries.
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = 'babytrack', DB_VER = 4, STORE = 'logs';
let db = null;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = e => {
      const d  = e.target.result;
      const tx = e.target.transaction;
      let store;

      // Create the object store on a fresh install, or reuse it on upgrade.
      if (!d.objectStoreNames.contains(STORE)) {
        store = d.createObjectStore(STORE, { keyPath: 'id' });
      } else {
        store = tx.objectStore(STORE);
      }

      // Idempotent: only create indexes if they don't exist yet.
      if (!store.indexNames.contains('by_family'))
        store.createIndex('by_family',  'family_id',  { unique: false });
      if (!store.indexNames.contains('by_profile'))
        store.createIndex('by_profile', 'profile_id', { unique: false });
    };

    req.onsuccess = e => { db = e.target.result; res(); };
    req.onerror   = () => rej(req.error);
  });
}

function dbPut(log) {
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(log);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

function dbDel(id) {
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

/**
 * Return only the logs belonging to the current family or profile.
 *
 * Family mode  → single indexed query on `by_family`  (O(matches), not O(total))
 * Profile mode → single indexed query on `by_profile`
 *               + a cheap full-scan fallback for pre-profile "legacy" logs
 *               (logs with neither field set — expected to be ~0 after v3).
 */
function dbGetAll() {
  return new Promise((res, rej) => {
    const tx    = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);

    if (familyId) {
      // Fast path: index lookup — only deserialises matching records.
      const req = store.index('by_family').getAll(familyId);
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    } else {
      // Profile path: indexed query + legacy fallback merged in one tx.
      const results = [];
      let pending = 2;
      const done = err => { if (err) rej(err); else if (--pending === 0) res(results); };

      const r1 = store.index('by_profile').getAll(activeProfileId);
      r1.onsuccess = () => { results.push(...(r1.result || [])); done(); };
      r1.onerror   = () => done(r1.error);

      // Legacy logs (pre-profile era): no family_id, no profile_id.
      // Expected count ≈ 0 for any user who opened the app after v3.
      const r2 = store.getAll();
      r2.onsuccess = () => {
        (r2.result || [])
          .filter(l => !l.family_id && !l.profile_id)
          .forEach(l => results.push(l));
        done();
      };
      r2.onerror = () => done(r2.error);
    }
  });
}

/**
 * Delete only the logs belonging to the current profile / family.
 * Uses the same index strategy to avoid loading unrelated records.
 */
function dbClear() {
  return new Promise((res, rej) => {
    const tx    = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);

    const index = familyId
      ? store.index('by_family').getAll(familyId)
      : store.index('by_profile').getAll(activeProfileId);

    index.onsuccess = () => {
      (index.result || []).forEach(l => store.delete(l.id));
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    };
    index.onerror = () => rej(index.error);
  });
}

