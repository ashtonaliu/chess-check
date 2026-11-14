// Finished profiles saved in IndexedDB, so a profile survives Chrome restarts and extension
// reloads. A saved profile is used straight away and refreshed in the background, which with the
// engine cache only analyzes games played since it was saved.
import type { Profile } from "../browser/follow";

export interface Saved { profile: Profile; games: number; savedAt: number }

const DB = "chess-check-profiles", STORE = "profiles";

function open(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function loadProfile(key: string): Promise<Saved | null> {
  const db = await open();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as Saved | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function saveProfile(key: string, saved: Saved): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(saved, key);
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    } catch { resolve(); }
  });
}
