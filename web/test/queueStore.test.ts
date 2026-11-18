// Review-queue changes from several tabs: none may undo another.
import assert from "node:assert/strict";
import { test } from "node:test";

import { addItems, grade, type ReviewItem } from "../src/browser/reviewQueue";
import { queueKey, updateQueue, type QueueDeps } from "../src/extension/queueStore";

const NOW = 1_800_000_000_000;
const item = (id: string): ReviewItem => ({ id, url: `https://www.chess.com/game/live/${id.split(":")[0]}`, ply: 1, label: "1.e4",
  san: "e4", best: "d4", loss: 40, tactics: [], opponent: "x", endTime: 1, step: 0, due: NOW });

/** Storage whose reads and writes take a moment, so two tabs' changes interleave. */
function slowStorage() {
  const data = new Map<string, ReviewItem[]>();
  const tick = () => new Promise(r => setTimeout(r, 5));
  return { data,
    load: async (k: string) => { await tick(); return structuredClone(data.get(k) ?? []); },
    save: async (k: string, q: ReviewItem[]) => { await tick(); data.set(k, structuredClone(q)); } };
}
/** A per-name lock like navigator.locks.request: callbacks for one name run one at a time. */
function locks() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    tails.set(name, run.catch(() => {}));
    return run;
  };
}

test("a grade in one tab and a new position from another tab both survive", async () => {
  const store = slowStorage();
  store.data.set(queueKey("me"), [item("1:1")]);
  const deps: QueueDeps = { ...store, lock: locks() };
  // tab A grades the position while tab B, at the same moment, adds one from a game it just finished
  await Promise.all([
    updateQueue(deps, "me", q => grade(q, "1:1", true, NOW)),
    updateQueue(deps, "Me", q => addItems(q, [item("2:1")])),
  ]);
  const q = store.data.get(queueKey("me"))!;
  assert.deepEqual(q.map(i => i.id), ["1:1", "2:1"]);
  assert.equal(q[0].step, 1, "the grade was not undone");
});

test("without the lock the same interleaving loses a change (why the lock is there)", async () => {
  const store = slowStorage();
  store.data.set(queueKey("me"), [item("1:1")]);
  const deps: QueueDeps = { ...store, lock: null };
  await Promise.all([
    updateQueue(deps, "me", q => grade(q, "1:1", true, NOW)),
    updateQueue(deps, "me", q => addItems(q, [item("2:1")])),
  ]);
  const q = store.data.get(queueKey("me"))!;
  assert.ok(q.length === 1 || q[0].step === 0, "one of the two changes is lost");
});
