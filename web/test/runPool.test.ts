// The worker pool behind profile builds and recaps, with stand-in engines.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runPool } from "../src/browser/engine";
import { Pace, SharedPace } from "../src/browser/pace";

class FakeEngine {
  static live = 0;
  static made = 0;
  alive = true;
  constructor(private failInit = false) { FakeEngine.live++; FakeEngine.made++; }
  async init() { await tick(); if (this.failInit) throw new Error("Stockfish stopped"); }
  terminate() { if (this.alive) { this.alive = false; FakeEngine.live--; } }
}
const tick = () => new Promise(r => setTimeout(r, 2));
const reset = () => { FakeEngine.live = 0; FakeEngine.made = 0; };

test("a failed pool stops every worker, including one still waiting for a slot", async () => {
  reset();
  const shared = new SharedPace(new Pace({ max: 4, start: 1 }));
  const share = shared.join();
  let made = 0, ran = 0;
  await assert.rejects(runPool(10, { engineUrl: "", pace: share }, async () => { ran++; await tick(); },
    () => new FakeEngine(made++ === 0)), /Stockfish stopped/);
  await tick(); await tick();
  assert.equal(ran, 0, "no work after the first engine failed to start");
  assert.equal(FakeEngine.made, 1, "no engine started after the failure");
  assert.equal(FakeEngine.live, 0, "every engine shut down");
  assert.equal(shared.inUse, 0, "every slot given back");
});

test("a failing task stops the other workers too, and the pool returns only after they exit", async () => {
  reset();
  let ran = 0;
  await assert.rejects(runPool(20, { engineUrl: "", workers: 3 }, async (_e, t) => {
    ran++; await tick(); if (t === 1) throw new Error("bad position");
  }, () => new FakeEngine()), /bad position/);
  const after = ran;
  await tick(); await tick();
  assert.equal(ran, after, "nothing runs after the pool has failed");
  assert.equal(FakeEngine.live, 0);
});

test("with one slot, only one engine stays loaded however many builds share it", async () => {
  reset();
  const shared = new SharedPace(new Pace({ max: 4, start: 1 }));
  let most = 0, done = 0;
  const build = () => runPool(6, { engineUrl: "", pace: shared.join() }, async () => {
    most = Math.max(most, FakeEngine.live); await tick(); done++;
  }, () => new FakeEngine());
  await Promise.all([build(), build()]);
  assert.equal(done, 12);
  assert.equal(most, 1, "idle workers do not keep engines while waiting");
  assert.equal(FakeEngine.live, 0);
  assert.equal(shared.inUse, 0);
});

test("a worker keeps its engine from task to task while its slot stays free", async () => {
  reset();
  const shared = new SharedPace(new Pace({ max: 2, start: 2 }));
  await runPool(10, { engineUrl: "", pace: shared.join() }, () => tick(), () => new FakeEngine());
  assert.equal(FakeEngine.made, 2, "two engines for ten tasks, not one per task");
});

test("cancelling stops the pool and its engines", async () => {
  reset();
  const abort = new AbortController();
  const run = runPool(50, { engineUrl: "", workers: 2, signal: abort.signal }, async () => { await tick(); },
    () => new FakeEngine());
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(run, { name: "AbortError" });
  assert.equal(FakeEngine.live, 0);
});
