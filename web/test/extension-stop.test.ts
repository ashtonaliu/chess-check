import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { Callback } from "../src/browser/callbackGame";

test("Play cancels a finished-game search and an in-flight warmup", async t => {
  // The offscreen module also supports a window without the extension messaging APIs.
  const globals = ["window", "Worker"] as const;
  const original = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() => globals.forEach((key, i) => {
    const property = original[i];
    if (property) Object.defineProperty(globalThis, key, property);
    else Reflect.deleteProperty(globalThis, key);
  }));

  let starts = 0, terminations = 0;
  class WaitingWorker {
    constructor() { starts++; }
    postMessage() {}
    terminate() { terminations++; }
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: WaitingWorker });

  const archiveSignals: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const signal = init.signal!;
    archiveSignals.push(signal);
    return new Promise<Response>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });

  const { handle } = await import("../src/extension/offscreen");
  const callback = JSON.parse(readFileSync(new URL("./fixtures/callback_187138001290.json", import.meta.url), "utf8")) as Callback;
  const recap = { type: "recap", username: "ashton-iwnl", kind: "live", gameId: "187138001290", callback } as const;
  const unfinished = { ...callback, game: { ...callback.game, isFinished: false } };
  assert.deepEqual(await handle({ ...recap, callback: unfinished }), { status: "pending" });
  assert.equal(starts, 0);
  assert.deepEqual(archiveSignals, []);
  const warmup = handle({ type: "warm", username: recap.username });
  try {
    assert.equal((await handle(recap)).status, "recap");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 1);
    assert.equal(archiveSignals.length, 2, "player and opponent lookups had both started");

    assert.equal((await handle({ type: "stop" })).status, "ready");
    assert.equal(terminations, 1);
    assert.ok(archiveSignals.every(signal => signal.aborted));
    assert.equal((await warmup).status, "error");

    assert.equal((await handle(recap)).status, "recap");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 2, "returning to the finished game starts a fresh search");
  } finally {
    await handle({ type: "stop" });
    await warmup;
  }
});
