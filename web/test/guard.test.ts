// The extension's fair-play guard: a recap only for games the public API lists as finished.
import assert from "node:assert/strict";
import { test } from "node:test";

import { canShowRecap, gameUrlFromPage } from "../src/extension/guard";

test("game pages map to canonical game URLs; anything else is not a game", () => {
  assert.equal(gameUrlFromPage("https://www.chess.com/game/live/187005539854"), "https://www.chess.com/game/live/187005539854");
  assert.equal(gameUrlFromPage("https://www.chess.com/game/live/187005539854?move=12"), "https://www.chess.com/game/live/187005539854");
  assert.equal(gameUrlFromPage("https://www.chess.com/analysis/game/live/187005539854/review"), "https://www.chess.com/game/live/187005539854");
  assert.equal(gameUrlFromPage("https://www.chess.com/game/daily/9001"), "https://www.chess.com/game/daily/9001");
  for (const u of ["https://www.chess.com/play/online", "https://www.chess.com/home", "https://lichess.org/game/live/1",
                   "https://evil.com/www.chess.com/game/live/1", "https://www.chess.com/game/live/abc", "not a url", null, undefined]) {
    assert.equal(gameUrlFromPage(u as string), null, String(u));
  }
});

test("a game in progress (not yet in the public API) never gets a recap", () => {
  const finished = new Set(["https://www.chess.com/game/live/1", "https://www.chess.com/game/live/2"]);
  assert.equal(canShowRecap("https://www.chess.com/game/live/2", finished), true);
  assert.equal(canShowRecap("https://www.chess.com/game/live/3", finished), false);   // still being played
  assert.equal(canShowRecap(null, finished), false);
  assert.equal(canShowRecap("https://www.chess.com/game/live/3", new Set()), false);
});
