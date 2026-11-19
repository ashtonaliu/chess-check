/** Entries are ordered newest first. Protected entries count toward the limit and always stay. */
export function excessKeys<K>(newestFirst: K[], limit: number, protectedKeys: ReadonlySet<K>): K[] {
  let room = Math.max(0, limit - newestFirst.filter(key => protectedKeys.has(key)).length);
  return newestFirst.filter(key => {
    if (protectedKeys.has(key)) return false;
    if (room > 0) { room--; return false; }
    return true;
  });
}

/** Order engine records by game end time. Older caches only have the ID in the key. */
export function enginePruneKeys(keys: IDBValidKey[], endTimes: ReadonlyMap<string, number>,
                                protectedGames: ReadonlySet<string>, limit: number): string[] {
  const shallow: string[] = [], deep: string[] = [];
  const gameByKey = new Map<string, string>();
  const savedGames = new Set<string>(), protectedKeys = new Set<string>();
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const match = /^(deep_)?v\d+_(\d+)_d\d+$/.exec(key);
    if (!match) continue;
    const id = match[2];
    gameByKey.set(key, id);
    (match[1] ? deep : shallow).push(key);
    if (protectedGames.has(id)) protectedKeys.add(key);
  }
  const newestFirst = (a: string, b: string) => {
    const idA = gameByKey.get(a)!, idB = gameByKey.get(b)!;
    return (endTimes.get(idB) ?? 0) - (endTimes.get(idA) ?? 0) || Number(idB) - Number(idA);
  };
  const drop = new Set([
    ...excessKeys(shallow.sort(newestFirst), limit, protectedKeys),
    ...excessKeys(deep.sort(newestFirst), limit, protectedKeys),
  ]);
  for (const [key, id] of gameByKey) if (!drop.has(key)) savedGames.add(id);
  for (const id of endTimes.keys()) if (!savedGames.has(id)) drop.add(`end_${id}`);
  return [...drop];
}

/** Complete a cleanup in one transaction, rolling back if a game starts before it commits. */
export async function pruneTransaction(db: IDBDatabase, store: string, signal: AbortSignal,
                                       prune: (store: IDBObjectStore) => void): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const cancel = () => { try { tx.abort(); } catch { /* already finished */ } };
    signal.addEventListener("abort", cancel, { once: true });
    tx.oncomplete = () => { signal.removeEventListener("abort", cancel); resolve(); };
    tx.onabort = () => { signal.removeEventListener("abort", cancel); reject(tx.error ?? signal.reason); };
    prune(tx.objectStore(store));
  });
}
