import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

import type { Callback } from "../src/browser/callbackGame";

test("a recap keeps polling during the first profile save so it can start the full refresh", { timeout: 5000 }, async t => {
  const { promise: saving, resolve: saveStarted } = Promise.withResolvers<void>();
  const { promise: saved, resolve: finishSave } = Promise.withResolvers<void>();
  const fixture = {
    builds: [] as number[],
    saveProfile: async () => { saveStarted(); await saved; },
  };
  Object.defineProperty(globalThis, "__profileTest", { configurable: true, value: fixture });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "__profileTest");
    Reflect.deleteProperty(globalThis, "window");
  });

  const stubs: Record<string, string> = {
    "../browser/follow": `
      export const analyzeGame = async game => ({
        analysis: { url: game.url, color: game.color, moves: [], opening_eval: null }, blunders: []
      });
    `,
    "../browser/games": "export const fetchGames = async () => [];",
    "../browser/pipeline": `
      export const analyzeInBrowser = async ({ username, games, signal }) => {
        globalThis.__profileTest.builds.push(games);
        if (games === 150) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        return { username, gameRows: [], openings: [], tactics: null, games: [] };
      };
    `,
    "./profileStore": `
      export const loadProfile = async () => null;
      export const saveProfile = globalThis.__profileTest.saveProfile;
      export const profileGameIds = () => new Set();
      export const pruneProfiles = async () => new Set();
      export const touchProfile = async () => {};
    `,
  };
  // Keep the actual recap handler and worker budget, with a controllable storage save.
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const stub = context.parentURL?.endsWith("/extension/offscreen.ts") && stubs[specifier];
      if (stub) return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
      return next(specifier, context);
    },
  });
  const { handle } = await import("../src/extension/offscreen").finally(() => hooks.deregister());
  const callback = JSON.parse(readFileSync(new URL("./fixtures/callback_187138001290.json", import.meta.url), "utf8")) as Callback;
  const recap = { type: "recap", username: "ashton-iwnl", kind: "live", gameId: "187138001290", callback } as const;
  try {
    await handle(recap);             // start the finished game's analysis
    await handle(recap);             // start the quick build
    await saving;
    const duringSave = await handle(recap);
    assert.equal(duringSave.status, "recap");
    assert.equal(duringSave.games, 0);
    assert.equal(duringSave.retry, true);
    assert.deepEqual(fixture.builds, [50]);

    finishSave();
    await new Promise(resolve => setImmediate(resolve));
    const complete = await handle(recap);
    assert.equal(complete.status, "recap");
    assert.equal(complete.games, 50);
    assert.equal(complete.partial, undefined);
    assert.deepEqual(fixture.builds, [50, 150]);
  } finally {
    finishSave();
    await handle({ type: "stop" });
  }
});
