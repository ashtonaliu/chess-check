import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { parseGame, type Game } from "../src/browser/games";
import { withExpected } from "../src/browser/stats";
import type { Callback } from "../src/browser/callbackGame";

test("the recap shows archive details after the turning point and keeps polling through the first profile save", { timeout: 5000 }, async t => {
  const { promise: saving, resolve: saveStarted } = Promise.withResolvers<void>();
  const { promise: saved, resolve: finishSave } = Promise.withResolvers<void>();
  const { promise: archive, resolve: loadArchive } = Promise.withResolvers<Game[]>();
  const { promise: engine, resolve: finishEngine } = Promise.withResolvers<void>();
  const raw = JSON.parse(readFileSync(new URL("./fixtures/archive_187138001290.json", import.meta.url), "utf8"));
  const current = parseGame(raw, "ashton-iwnl")!;
  const playerGames = [
    { ...current, url: current.url + "2", endTime: current.endTime + 1 },
    current,
    { ...current, url: current.url + "1", endTime: current.endTime - 1 },
  ];
  const opponent = parseGame(raw, "dallen6")!;
  const opponentGames = Array.from({ length: 5 }, (_, i) =>
    ({ ...opponent, url: opponent.url + (i + 1), endTime: opponent.endTime - i - 1 }));
  const requests: string[] = [];
  const fixture = {
    builds: [] as number[],
    fetchGames: (username: string) => {
      requests.push(username);
      return username === "dallen6" ? Promise.resolve(opponentGames) : archive;
    },
    engine,
    withExpected,
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
      export const analyzeGame = async game => {
        await globalThis.__profileTest.engine;
        return { analysis: { url: game.url, color: game.color, moves: [], opening_eval: null }, blunders: [] };
      };
    `,
    "../browser/games": "export const fetchGames = globalThis.__profileTest.fetchGames;",
    "../browser/pipeline": `
      export const analyzeInBrowser = async ({ username, games, signal, prefetchedGames }) => {
        globalThis.__profileTest.builds.push(games);
        if (games === 150) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        const history = await prefetchedGames ?? [];
        return { username, gameRows: globalThis.__profileTest.withExpected(history), openings: [], tactics: null, games: history };
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
    const first = await handle(recap);
    assert.equal(first.status, "recap");
    assert.equal(first.recap.pending?.history, true);
    assert.equal(first.recap.opponentNote, null);
    // the player's archive waits for the turning point, so it does not slow that search
    await new Promise(resolve => setImmediate(resolve));
    const searching = await handle(recap);
    assert.equal(searching.status, "recap");
    assert.equal(searching.recap.pending?.turning, true);
    assert.equal(searching.recap.pending?.history, true);
    assert.deepEqual(requests, ["dallen6"], "only the opponent's archive is read during the search");
    assert.deepEqual(fixture.builds, []);

    finishEngine();
    await new Promise(resolve => setImmediate(resolve));
    await handle(recap);             // the turning point is in: the quick build reads the archive
    assert.deepEqual(requests.sort(), ["ashton-iwnl", "dallen6"]);
    assert.deepEqual(fixture.builds, [50]);

    loadArchive(playerGames);
    await saving;
    const early = await handle(recap);
    assert.equal(early.status, "recap");
    assert.equal(early.games, 0);
    assert.equal(early.retry, true);
    assert.equal(early.recap.pending?.turning, false);
    assert.equal(early.recap.pending?.history, false);
    assert.equal(early.recap.opening.history?.n, 1, "only the game before this one counts");
    assert.match(early.recap.opponentNote ?? "", /dallen6 has played/);
    assert.deepEqual(fixture.builds, [50], "the refresh waits for the first profile to be saved");

    finishSave();
    await new Promise(resolve => setImmediate(resolve));
    const complete = await handle(recap);
    assert.equal(complete.status, "recap");
    assert.equal(complete.games, 50);
    assert.equal(complete.partial, undefined);
    assert.deepEqual(complete.recap.opening, early.recap.opening);
    assert.deepEqual(fixture.builds, [50, 150]);
  } finally {
    loadArchive([]);
    finishEngine();
    finishSave();
    await handle({ type: "stop" });
  }
});
