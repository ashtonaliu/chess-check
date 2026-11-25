import assert from "node:assert/strict";
import { test } from "node:test";

test("a UCI timing uses the last reported time and follows its engine run", async t => {
  const setGlobal = (key: string, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  };
  setGlobal("__CC_PROFILE__", true);
  class Worker {
    onmessage?: (event: { data: string }) => void;
    postMessage(command: string) {
      const lines = command === "uci" ? ["uciok"] : command === "isready" ? ["readyok"]
        : command === "go depth 8" ? ["info depth 1 score cp 8 time 2", "info depth 8 score cp 12 time 7 nodes 100",
          "info string ignored time 300", "bestmove e2e4"]
        : command === "go depth 14" ? ["info depth 14 score cp 15 nodes 500", "bestmove e2e4"] : [];
      queueMicrotask(() => lines.forEach(data => this.onmessage?.({ data })));
    }
    terminate() {}
  }
  setGlobal("Worker", Worker);
  const { startEngineTiming, finishEngineTiming, runPool } = await import("../src/browser/engine");
  const signal = new AbortController().signal;
  const run = startEngineTiming(signal, { kind: "profile", requested: 150 });
  await runPool(1, { engineUrl: "stub", signal, workers: 1 }, async engine => {
    assert.equal((await engine.analyse("stub", 8)).cp, 12);
    await engine.analyse("stub", 14);
  });
  finishEngineTiming(run, 150);
  const searches = performance.getEntriesByName("cc:uci search") as PerformanceMeasure[];
  assert.deepEqual(searches.map(s => s.detail), [{ stockfishMs: 7, run: run.id }, { stockfishMs: null, run: run.id }]);
  assert.ok(searches.every(s => s.duration >= 0 && s.startTime >= run.start));
  const [done] = performance.getEntriesByName("cc:engine timing complete") as PerformanceMeasure[];
  assert.equal(done.detail.games, 150);
  assert.equal(done.detail.id, run.id);
});
