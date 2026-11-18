// The extension's fair-play guard: a recap only for games the public API lists as finished.
import assert from "node:assert/strict";
import { test } from "node:test";

import { canReview, canShowRecap, gameIdFromApiUrl, gameIdFromPage } from "../src/extension/guard";

test("every Chess.com game address form maps to the game ID", () => {
  const id = "187138001290";
  for (const u of [
    `https://www.chess.com/game/${id}`,                       // current live-game pages (the address that broke v0.1)
    `https://www.chess.com/live/game/${id}`,                  // what Chess.com rewrites /game/<id> to after loading
    `https://www.chess.com/game/${id}?tab=review`,
    `https://www.chess.com/game/live/${id}`,
    `https://www.chess.com/game/live/${id}?move=12`,
    `https://www.chess.com/analysis/game/live/${id}/review`,
    `https://chess.com/game/${id}`,
  ]) assert.equal(gameIdFromPage(u), id, u);
  assert.equal(gameIdFromPage("https://www.chess.com/game/daily/9001"), "9001");
  assert.equal(gameIdFromPage("https://www.chess.com/daily/game/9001"), "9001");
});

test("pages that are not games, and look-alikes, give no game", () => {
  for (const u of ["https://www.chess.com/play/online", "https://www.chess.com/home", "https://www.chess.com/game/",
                   "https://lichess.org/game/123", "https://evil.com/www.chess.com/game/123",
                   "https://www.chess.com.evil.com/game/123", "https://www.chess.com/game/live/abc",
                   "https://www.chess.com/games/archive", "https://www.chess.com/live/game/", "https://www.chess.com/live", "not a url", null, undefined]) {
    assert.equal(gameIdFromPage(u as string), null, String(u));
  }
});

test("API game URLs give their ID", () => {
  assert.equal(gameIdFromApiUrl("https://www.chess.com/game/live/187138001290"), "187138001290");
  assert.equal(gameIdFromApiUrl("https://www.chess.com/game/daily/9001"), "9001");
});

test("a game in progress (not yet in the public API) never gets a recap", () => {
  const finished = new Set(["1", "2"]);
  assert.equal(canShowRecap("2", finished), true);
  assert.equal(canShowRecap("3", finished), false);   // still being played
  assert.equal(canShowRecap(null, finished), false);
  assert.equal(canShowRecap("3", new Set()), false);
});

test("the review queue stays off the play page and off a game until it is confirmed over", () => {
  assert.equal(canReview("https://www.chess.com/home", false), true);
  assert.equal(canReview("https://www.chess.com/puzzles", false), true);
  assert.equal(canReview("https://www.chess.com/play/online", false), false);
  assert.equal(canReview("https://www.chess.com/play/online", true), false);
  assert.equal(canReview("https://www.chess.com/play", false), false);
  assert.equal(canReview("https://www.chess.com/game/187502325560", false), false);   // may be in progress
  assert.equal(canReview("https://www.chess.com/game/live/187502325560?move=43", true), true);
  assert.equal(canReview("not a url", true), false);
});
