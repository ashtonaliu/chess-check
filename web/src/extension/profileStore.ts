// Finished profiles saved in IndexedDB, so a profile survives Chrome restarts and extension
// reloads. A saved profile is used straight away and refreshed in the background, which with the
// engine cache only analyzes games played since it was saved.
import type { Profile } from "../browser/follow";
import { excessKeys, pruneTransaction } from "../browser/cacheRetention";
import { restorePossessives } from "../browser/games";
import { gameCacheId } from "../browser/ids";
import { DEFAULT_SITE, type SiteId } from "../browser/site";
import { legacyProfileKey, qualifyProfileKey } from "./storageKeys";

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

function withSite(saved: Saved): Saved {
  // Older profiles have no site, and their Chess.com opening names lack apostrophes ("Kings
  // Fianchetto Opening"), which would split an opening's record from newly named games.
  const stamp = <T extends { site: SiteId; opening: string; family: string }>(game: T): T => {
    const site = game.site || DEFAULT_SITE;
    return site === "chesscom"
      ? { ...game, site, opening: restorePossessives(game.opening), family: restorePossessives(game.family) }
      : game.site ? game : { ...game, site };
  };
  const { profile } = saved;
  const openings = (profile.openings ?? []).map(o => (profile.site ?? DEFAULT_SITE) === "chesscom"
    ? { ...o, family: restorePossessives(o.family) } : o);
  return { ...saved, profile: { ...profile, rows: profile.rows.map(stamp), openings,
    ...(profile.games ? { games: profile.games.map(stamp) } : {}) } };
}

export async function loadProfile(key: string): Promise<Saved | null> {
  key = qualifyProfileKey(key);
  const db = await open();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const legacy = legacyProfileKey(key);
      let saved: Saved | null = null;
      tx.oncomplete = () => { db.close(); resolve(saved); };
      tx.onerror = tx.onabort = () => { db.close(); resolve(null); };
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result) {
          saved = req.result as Saved;
          store.put(Date.now(), USED + key);
        } else if (legacy) {
          const old = store.get(legacy);
          old.onsuccess = () => {
            if (!old.result) return;
            saved = withSite(old.result as Saved);
            store.put(saved, key);
            store.put(Date.now(), USED + key);
            store.delete(legacy);
            store.delete(USED + legacy);
          };
        }
      };
    } catch { db.close(); resolve(null); }
  });
}

async function write(key: string, value: Saved | number): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.put(value, key);
      const legacy = legacyProfileKey(key);
      if (typeof value !== "number" && legacy) {
        store.delete(legacy);
        store.delete(USED + legacy);
      }
      tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
    } catch { db.close(); resolve(); }
  });
}

export const saveProfile = (key: string, saved: Saved) => write(qualifyProfileKey(key), saved);
export const touchProfile = (key: string) => write(USED + qualifyProfileKey(key), Date.now());

interface ProfileEntry {
  key: string; gameIds: ReadonlySet<string>; lastUsed: number;
}

export function profilePruneKeys(entries: ProfileEntry[], current: ReadonlySet<string>,
                                 legacyQueueGames: ReadonlyMap<string, ReadonlySet<string>>, limit: number): string[] {
  const keep = new Set(entries.filter(entry => current.has(qualifyProfileKey(entry.key))
    || current.has(entry.key)).map(entry => entry.key));
  for (const entry of entries) {
    const qualified = qualifyProfileKey(entry.key);
    const player = qualified.slice(0, qualified.lastIndexOf("|"));
    const legacy = legacyQueueGames.get(player) ?? legacyQueueGames.get(legacyProfileKey(player) ?? "");
    if (legacy && [...legacy].some(id => entry.gameIds.has(id))) keep.add(entry.key);
  }
  return excessKeys([...entries].sort((a, b) => b.lastUsed - a.lastUsed).map(entry => entry.key), limit, keep);
}

export function profileGameIds(profile: Profile): Set<string> {
  return new Set([...(profile.games ?? []), ...(profile.rows ?? [])].map(game => gameCacheId(game.url)));
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
