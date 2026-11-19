// Finished profiles saved in IndexedDB, so a profile survives Chrome restarts and extension
// reloads. A saved profile is used straight away and refreshed in the background, which with the
// engine cache only analyzes games played since it was saved.
import type { Profile } from "../browser/follow";
import { excessKeys, pruneTransaction } from "../browser/cacheRetention";
import { gameId } from "../browser/ids";

export interface Saved { profile: Profile; games: number; savedAt: number }

const DB = "chess-check-profiles", STORE = "profiles";
const USED = "used:";

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
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        const saved = req.result as Saved | undefined;
        if (saved) store.put(Date.now(), USED + key);
        resolve(saved ?? null);
        db.close();
      };
      req.onerror = () => { db.close(); resolve(null); };
    } catch { db.close(); resolve(null); }
  });
}

async function write(key: string, value: Saved | number): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = tx.onabort = () => { db.close(); resolve(); };
    } catch { db.close(); resolve(); }
  });
}

export const saveProfile = (key: string, saved: Saved) => write(key, saved);
export const touchProfile = (key: string) => write(USED + key, Date.now());

interface ProfileEntry {
  key: string; gameIds: ReadonlySet<string>; lastUsed: number;
}

export function profilePruneKeys(entries: ProfileEntry[], current: ReadonlySet<string>,
                                 legacyQueueGames: ReadonlyMap<string, ReadonlySet<string>>, limit: number): string[] {
  const keep = new Set(current);
  for (const entry of entries) {
    const user = entry.key.split("|")[0];
    const legacy = legacyQueueGames.get(user);
    if (legacy && [...legacy].some(id => entry.gameIds.has(id))) keep.add(entry.key);
  }
  return excessKeys([...entries].sort((a, b) => b.lastUsed - a.lastUsed).map(entry => entry.key), limit, keep);
}

export function profileGameIds(profile: Profile): Set<string> {
  return new Set([...(profile.games ?? []), ...(profile.rows ?? [])].map(game => gameId(game.url)));
}

/** The games behind profiles left on disk still need their engine results for a refresh. */
export async function pruneProfiles(current: () => ReadonlySet<string>, legacyQueueGames: ReadonlyMap<string, ReadonlySet<string>>,
                                    limit: number, signal: AbortSignal): Promise<Set<string>> {
  signal.throwIfAborted();
  const db = await open();
  if (!db) throw new Error("Could not read saved profiles");
  const gameIds = new Set<string>();
  try {
    await pruneTransaction(db, STORE, signal, store => {
      const entries: ProfileEntry[] = [];
      const used = new Map<string, number>();
      const scan = store.openCursor();
      scan.onsuccess = () => {
        const cursor = scan.result;
        if (cursor) {
          const key = String(cursor.key);
          if (key.startsWith(USED)) used.set(key.slice(USED.length), cursor.value as number);
          else {
            const { profile, savedAt } = cursor.value as Saved;
            entries.push({ key, gameIds: profileGameIds(profile), lastUsed: savedAt });
          }
          cursor.continue();
          return;
        }
        for (const entry of entries) entry.lastUsed = Math.max(entry.lastUsed, used.get(entry.key) ?? 0);
        const drop = new Set(profilePruneKeys(entries, current(), legacyQueueGames, limit));
        for (const entry of entries) {
          if (drop.has(entry.key)) store.delete(entry.key);
          else {
            used.delete(entry.key);
            for (const id of entry.gameIds) gameIds.add(id);
          }
        }
        for (const key of used.keys()) store.delete(USED + key);
      };
    });
    return gameIds;
  } finally { db.close(); }
}
