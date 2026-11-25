import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { siteForId } from "../src/browser/sites";

test("the Chess.com adapter accepts finished-game evidence only for the requested game and player", async t => {
  const callback = JSON.parse(readFileSync(new URL("./fixtures/callback_187138001290.json", import.meta.url), "utf8"));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });

  const site = siteForId("chesscom")!;
  const id = String(callback.game.id);
  const url = new URL(`https://www.chess.com/game/live/${id}`);
  const signal = new AbortController().signal;
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  assert.equal(await site.lookupFinishedPage(id, url, signal), null);
  assert.deepEqual(fetch.mock.calls[0].arguments, [`/callback/live/game/${id}`, { credentials: "include", signal }]);

  fetch.mock.mockImplementation(async () => Response.json({ game: { ...callback.game, isFinished: false } }));
  assert.equal(await site.lookupFinishedPage(id, url, signal), null);
  fetch.mock.mockImplementation(async () => Response.json(callback));
  const page = await site.lookupFinishedPage(id, url, signal);
  assert.ok(page);

  const game = site.finishedGame(id, page.players.white, page.evidence);
  assert.ok(game && game !== "pending");
  assert.equal(game.site, "chesscom");
  assert.equal(site.finishedGame("123", page.players.white, page.evidence), "pending");
  assert.equal(site.finishedGame(id, "not-a-player", page.evidence), null);
});
