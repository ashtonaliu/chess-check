// The extension's finished-game lookup: by ID across recent months, not just the latest games.
import assert from "node:assert/strict";
import { test } from "node:test";

import { findGame } from "../src/browser/games";

const PGN = '[White "me"]\n[Black "them"]\n[Result "1-0"]\n[ECO "D00"]\n\n1. d4 d5 1-0';
const game = (id: number, end: number) => ({
  url: `https://www.chess.com/game/live/${id}`, pgn: PGN, rules: "chess", time_class: "bullet", time_control: "60", end_time: end,
  white: { username: "me", rating: 1700, result: "win" }, black: { username: "them", rating: 1700, result: "checkmated" },
});

test("a finished game is found by ID even after many newer games, and an unknown ID is not", async () => {
  const oct = [game(100, 1)];
  const nov = Array.from({ length: 60 }, (_, i) => game(200 + i, 10 + i));   // 60 newer games
  const base = "https://api.chess.com/pub/player/me/games";
  const pages: Record<string, unknown> = {
    [`${base}/archives`]: { archives: [`${base}/2026/10`, `${base}/2026/11`] },
    [`${base}/2026/10`]: { games: oct }, [`${base}/2026/11`]: { games: nov },
  };
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string) => new Response(JSON.stringify(pages[u]), { status: pages[u] ? 200 : 404 })) as typeof fetch;
  try {
    assert.equal((await findGame("me", "100"))?.url, "https://www.chess.com/game/live/100");
    assert.equal((await findGame("me", "205"))?.url, "https://www.chess.com/game/live/205");
    assert.equal(await findGame("me", "999"), null);   // not finished, or not this player's game
  } finally { globalThis.fetch = real; }
});
