// Post-game recap logic on real games (fixture from scripts/make_tactics_fixture.py).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { GameAnalysis } from "../src/browser/engine";
import type { Game } from "../src/browser/games";
import { buildRecap, opponentNote, upset } from "../src/browser/recap";
import { withExpected } from "../src/browser/stats";
import { classifyGame, summarize } from "../src/browser/tactics";

const fx = JSON.parse(readFileSync(new URL("./fixtures/tactics.json", import.meta.url), "utf8"));
const games = fx.games as Game[];
const analyses = fx.analyses as GameAnalysis[];

test("upset labels follow the pre-game expected score", () => {
  assert.equal(upset(1, 0.30), "Big upset win");
  assert.equal(upset(1, 0.42), "Upset win");
  assert.equal(upset(1, 0.70), "Win as the favorite");
  assert.equal(upset(0, 0.70), "Upset loss");
  assert.equal(upset(0, 0.30), "Loss to a stronger player");
  assert.equal(upset(0.5, 0.30), "Draw against a stronger player");
  assert.equal(upset(0.5, 0.50), "Draw");
});

test("recap of a real game: expected score, opening history without the game itself, turning point", () => {
  const history = withExpected(games);
  const tactics = summarize(analyses, new Map(games.map(g => [g.url, g.pgn])));
  const i = analyses.findIndex(a => a.moves.some(m => m.is_me && ((m as any).deep_loss ?? m.wp_loss) >= 20));
  const g = games[i], a = analyses[i];
  const r = buildRecap(g, a, classifyGame(g.pgn, a), history, [], tactics);
  const exp = 1 / (1 + 10 ** ((g.oppRating - g.myRating) / 400));
  assert.ok(Math.abs(r.expected - exp) < 1e-12);
  assert.ok(Math.abs(r.surprise - (g.score - exp)) < 1e-12);
  // history counts only *other* games in the same opening and color
  const others = games.filter(x => x.url !== g.url && x.family === g.family && x.color === g.color).length;
  assert.equal(r.opening.history?.n ?? 0, others);
  // turning point is the user's largest confirmed loss in that game
  const losses = a.moves.filter(m => m.is_me).map(m => (m as any).deep_loss ?? m.wp_loss);
  assert.ok(r.turning && Math.abs(r.turning.loss - Math.max(...losses)) < 1e-9);
  assert.equal(r.clean, false);
  // a pattern match counts this game on top of the profile's count, and only for problems
  if (r.pattern) {
    const stat = tactics.motifs.find(s => s.kind === r.pattern!.kind && s.motif === r.pattern!.motif)!;
    assert.ok(stat.higher && stat.verdict !== "no difference");
    assert.equal(r.pattern.count, stat.me + 1);
  }
});

test("opponent note: their record in this opening as their color, from their own games", () => {
  const mk = (family: string, color: "white" | "black", score: number): Game => ({
    url: `u${Math.random()}`, color, myRating: 1700, oppRating: 1700, score, timeClass: "blitz", timeControl: "180",
    eco: "", opening: family, family, endTime: 0, result: "", oppResult: "", moves: [], pgn: "" });
  const opp = [
    ...Array.from({ length: 6 }, () => mk("Scotch Game", "white", 1)),
    ...Array.from({ length: 4 }, () => mk("Italian Game", "white", 0)),
    ...Array.from({ length: 5 }, () => mk("Sicilian Defense", "black", 0.5)),
  ];
  const note = opponentNote("rival", opp, "Scotch Game", "white")!;
  assert.match(note, /Scotch Game as White in 6 of their last 10 games as White, scoring 100% against an expected 50%/);
  const fresh = opponentNote("rival", opp, "London System", "white")!;
  assert.match(fresh, /new territory for rival: none of their last 10 games as White\. They usually play the Scotch Game \(6 games\)/);
  assert.equal(opponentNote("rival", opp.slice(0, 3), "Scotch Game", "white"), null);   // too few games to say
});
