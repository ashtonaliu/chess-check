import assert from "node:assert/strict";
import { test } from "node:test";

test("a Play or unconfirmed tab keeps other tabs paused across service worker restarts", async t => {
  const home = "https://www.chess.com/home";
  const play = "https://www.chess.com/play/online";
  const game = "https://www.chess.com/game/live/187138001290";
  const tabs = new Map([[1, home], [2, home]]);
  const session: Record<string, unknown> = {};
  const sent: string[] = [];
  let listener: (msg: object, sender: object, reply: (value: unknown) => void) => void;
  let update: (id: number, change: { url?: string; status?: "loading" | "complete" }, tab: { id: number; url: string }) => void;
  let remove: (id: number) => void;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    storage: { session: { get: async () => session, set: async (value: object) => Object.assign(session, value) } },
    offscreen: { hasDocument: async () => true },
    runtime: {
      onMessage: { addListener: (entry: typeof listener) => { listener = entry; } },
      sendMessage: async ({ type }: { type: string }) => { sent.push(type); return { status: "ready" }; },
    },
    tabs: {
      query: async () => [...tabs].map(([id, url]) => ({ id, url })),
      onUpdated: { addListener: (entry: typeof update) => { update = entry; } },
      onRemoved: { addListener: (entry: typeof remove) => { remove = entry; } },
      onReplaced: { addListener: () => {} },
    },
    action: { onClicked: { addListener: () => {} } },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else Reflect.deleteProperty(globalThis, "chrome");
  });

  const send = (id: number, msg: object, frameUrl?: string) => new Promise(resolve => {
    const url = tabs.get(id);
    listener({ target: "bg", ...msg }, { tab: { id, url }, url: frameUrl ?? url, frameId: 0 }, resolve);
  });
  const navigate = (id: number, url: string) => {
    tabs.set(id, url);
    update(id, { url }, { id, url });
  };
  const ready = { status: "ready" };
  const paused = { status: "paused" };
  const warm = { type: "warm", username: "ashton-iwnl" };

  await import("../src/extension/background");
  assert.deepEqual(await send(2, warm), ready);
  navigate(1, play);
  assert.deepEqual(await send(2, warm), paused);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ["warm", "stop"]);

  const restarted = new URL("../src/extension/background.ts?restart", import.meta.url);
  await import(restarted.href);
  assert.deepEqual(await send(2, warm), paused);
  navigate(1, game);
  assert.deepEqual(await send(2, warm), paused);
  assert.deepEqual(await send(1, { type: "page-state", url: game, finished: true }), ready);
  assert.deepEqual(await send(2, warm), ready);

  update(1, { status: "loading" }, { id: 1, url: game });
  assert.deepEqual(await send(2, warm), ready, "a loading event for the confirmed game keeps analysis running");
  update(1, { status: "complete" }, { id: 1, url: game });
  assert.deepEqual(await send(1, { type: "recap" }), ready);

  const gameAtMove = `${game}?move=0`;
  tabs.set(1, gameAtMove);
  update(1, { url: gameAtMove, status: "loading" }, { id: 1, url: gameAtMove });
  assert.deepEqual(await send(2, warm), ready, "the move parameter preserves the game confirmation");
  assert.deepEqual(await send(1, { type: "page-state", url: gameAtMove, finished: false }), ready);
  assert.deepEqual(await send(2, warm), paused, "a fresh content script can invalidate the confirmation");
  assert.deepEqual(await send(1, { type: "page-state", url: gameAtMove, finished: true }), ready);
  assert.deepEqual(await send(2, warm), ready);

  navigate(1, "https://www.chess.com/game/live/187138001291");
  await send(1, { type: "page-state", url: gameAtMove, finished: true });
  assert.deepEqual(await send(2, warm), paused, "a different game requires its own confirmation");

  navigate(1, home);
  assert.deepEqual(await send(1, warm, game), ready, "the tab URL wins over the original frame URL");
  navigate(1, play);
  assert.deepEqual(await send(2, warm), paused);
  tabs.delete(1);
  remove(1);
  assert.deepEqual(await send(2, warm), ready);
});
