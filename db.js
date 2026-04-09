// ── js/db.js ─────────────────────────────────────────────────────────────────
// IndexedDB wrapper. Scoped to the current profile/family via global vars
// `familyId` and `activeProfileId` (set by app.js before any call).
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = 'babytrack', DB_VER = 3, STORE = 'logs';
let db = null;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE))
        d.createObjectStore(STORE, { keyPath: 'id' });
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

function dbGetAll() {
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      const filtered = all.filter(l =>
        (familyId && l.family_id === familyId) ||
        (!familyId && l.profile_id === activeProfileId) ||
        (!l.family_id && !l.profile_id)   // legacy logs
      );
      res(filtered);
    };
    req.onerror = () => rej(req.error);
  });
}

/** Clear only the logs belonging to the current profile / family. */
function dbClear() {
  return new Promise(async res => {
    const all = await new Promise(r => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => r(req.result || []);
      req.onerror   = () => r([]);
    });
    const toDelete = all.filter(l =>
      (familyId && l.family_id === familyId) ||
      (!familyId && l.profile_id === activeProfileId)
    );
    const tx = db.transaction(STORE, 'readwrite');
    for (const l of toDelete) tx.objectStore(STORE).delete(l.id);
    tx.oncomplete = res;
    tx.onerror    = res;
  });
}
