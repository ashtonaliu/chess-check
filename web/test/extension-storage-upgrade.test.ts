import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import "fake-indexeddb/auto";
import { restorePossessives } from "../src/browser/games";
import { loadProfile, pruneProfiles, type Saved } from "../src/extension/profileStore";
import { loadStoredQueue, queueKey, updateQueue } from "../src/extension/queueStore";
import { profileKey } from "../src/extension/storageKeys";
import { reviewDependencies } from "../src/extension/storageRetention";

const snapshot = JSON.parse(readFileSync(new URL("./fixtures/extension-storage-0.8.json", import.meta.url), "utf8"));

function openSnapshot(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("chess-check-profiles", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("profiles");
      for (const [key, value] of Object.entries(snapshot.indexedDB)) store.put(value, key);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

test("0.8.x profile and review queue load under the Chess.com keys", async () => {
  const db = await openSnapshot();
  const record = snapshot.indexedDB["example|blitz"] as Saved;
  const originalQueue = snapshot.chromeStorage["queue:example"];
  const current = profileKey("chesscom", "Example", "blitz");
  const other = profileKey("lichess", "Example", "blitz");
  assert.equal(await loadProfile(other), null);
  assert.deepEqual(await pruneProfiles(() => new Set([current]), new Map(), 0, new AbortController().signal),
    new Set(["12345"]));

  // Saved Chess.com names lost their apostrophes; loading restores them to match new games.
  const named = <T extends { opening: string; family: string }>(game: T) =>
    ({ ...game, site: "chesscom", opening: restorePossessives(game.opening), family: restorePossessives(game.family) });
  const expected = { ...record, profile: { ...record.profile,
    rows: record.profile.rows.map(named), games: record.profile.games!.map(named) } };
  assert.equal(record.profile.rows[0].opening, "Kings Pawn Opening");
  assert.equal((await loadProfile(current))!.profile.rows[0].opening, "King's Pawn Opening");
  assert.deepEqual(await loadProfile(current), expected);
  assert.deepEqual(await loadProfile(current), expected);
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = db.transaction("profiles").objectStore("profiles").getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  assert.deepEqual(keys, [current, `used:${current}`]);
  db.close();

  const data: Record<string, unknown> = structuredClone(snapshot.chromeStorage);
  const storage = {
    get: async (keys: string[] | null) => Object.fromEntries((keys ?? Object.keys(data)).map(key => [key, data[key]])),
    set: async (patch: Record<string, unknown>) => { Object.assign(data, patch); },
  };
  const chesscom = queueKey("Example", "chesscom");
  assert.deepEqual(await loadStoredQueue(chesscom, storage), originalQueue);
  assert.deepEqual(await loadStoredQueue(queueKey("Example", "lichess"), storage), []);
  const deps = { load: (key: string) => loadStoredQueue(key, storage),
    save: async (key: string, queue: Awaited<ReturnType<typeof loadStoredQueue>>) => storage.set({ [key]: queue }), lock: null };
  const changed = await updateQueue(deps, "Example", queue => queue.map(item => ({ ...item, step: 3 })), "chesscom");
  assert.deepEqual(changed, [{ ...originalQueue[0], step: 3 }]);
  assert.deepEqual(data[chesscom], changed);

  await updateQueue(deps, "Example", () => [], "chesscom");
  assert.deepEqual(await loadStoredQueue(chesscom, storage), []);
  assert.deepEqual(reviewDependencies(data).games, new Set());
});
