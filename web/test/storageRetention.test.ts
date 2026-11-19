import assert from "node:assert/strict";
import { test } from "node:test";
import { enginePruneKeys, pruneTransaction } from "../src/browser/cacheRetention";
import { profilePruneKeys } from "../src/extension/profileStore";
import { rememberRecap, reviewDependencies } from "../src/extension/storageRetention";

test("the recap cache keeps the last used complete recaps", () => {
  const recaps = new Map<string, number>();
  rememberRecap(recaps, "first", 1, 2);
  rememberRecap(recaps, "second", 2, 2);
  rememberRecap(recaps, "first", recaps.get("first")!, 2);
  rememberRecap(recaps, "third", 3, 2);
  assert.deepEqual([...recaps], [["first", 1], ["third", 3]]);
});

test("shallow and deep caches have separate limits and keep protected games", () => {
  const keys = [
    "v1_20_d8", "v2_20_d8", "v1_30_d8", "v1_90_d8", "v1_91_d8",
    "deep_v1_20_d14", "deep_v1_90_d14", "deep_v1_91_d14", "deep_v1_100_d14",
    "end_20", "end_90", "end_91", "end_100", "end_200", "unrelated",
  ];
  const dates = new Map([["20", 1], ["90", 90], ["91", 80], ["100", 100], ["200", 200]]);
  assert.deepEqual(new Set(enginePruneKeys(keys, dates, new Set(["20"]), 3)), new Set([
    "v1_91_d8", "v1_30_d8", "deep_v1_91_d14", "end_91", "end_200",
  ]));
});

test("legacy engine entries without dates use game ID order and dates survive while either cache needs them", () => {
  assert.deepEqual(new Set(enginePruneKeys(
    ["v1_9_d8", "v1_10_d8", "deep_v1_9_d14", "end_9", "end_10"], new Map([["9", 499], ["10", 500]]), new Set(), 1,
  )), new Set(["v1_9_d8"]));
  assert.deepEqual(enginePruneKeys(["v1_10_d8", "v1_9_d8"], new Map(), new Set(), 1), ["v1_9_d8"]);
});

test("incomplete review cards protect matching legacy profiles for their account", () => {
  const url = (id: string) => `https://www.chess.com/game/live/${id}`;
  const { games, legacyByUser } = reviewDependencies({
    accounts: ["alice"],
    "queue:alice": [{ url: url("29"), fen: "position", timeClass: "blitz" }, { url: url("10"), timeClass: "blitz" }],
    "queue:bob": [{ url: url("11"), fen: "position" }, { url: url("9"), done: true }],
  });
  assert.deepEqual(games, new Set(["29", "10", "11"]));
  assert.deepEqual(legacyByUser, new Map([["alice", new Set(["10"])], ["bob", new Set(["11"])]]));
  const profiles = [
    { key: "alice|rapid", lastUsed: 1, gameIds: new Set(["10"]) },
    { key: "bob|blitz", lastUsed: 2, gameIds: new Set(["11"]) },
    { key: "alice|bullet", lastUsed: 3, gameIds: new Set(["30"]) },
    { key: "eve|blitz", lastUsed: 4, gameIds: new Set(["10"]) },
    { key: "eve|bullet", lastUsed: 5, gameIds: new Set(["41"]) },
  ];
  const current = new Set(["alice|bullet"]);
  assert.deepEqual(profilePruneKeys(profiles, current, legacyByUser, 4), ["eve|blitz"]);
  assert.deepEqual(profilePruneKeys(profiles, current, legacyByUser, 2), ["eve|bullet", "eve|blitz"]);
});

test("stop aborts an open pruning transaction and an already stopped cleanup can't start one", async () => {
  const stop = new AbortController();
  let transactions = 0;
  const tx = { abort() { this.onabort?.(); }, onabort: undefined as (() => void) | undefined, objectStore() {} };
  const db = { transaction() { transactions++; return tx; } } as unknown as IDBDatabase;
  const pruning = pruneTransaction(db, "games", stop.signal, () => {});
  stop.abort();
  await assert.rejects(pruning, { name: "AbortError" });
  await assert.rejects(pruneTransaction(db, "games", stop.signal, () => {}), { name: "AbortError" });
  assert.equal(transactions, 1);
});
