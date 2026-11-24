// Post-game recap logic on real games (fixture from scripts/make_tactics_fixture.py).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { winPct, type GameAnalysis } from "../src/browser/engine";
import type { Game } from "../src/browser/games";
import { buildRecap, opponentNote, upset } from "../src/browser/recap";
import { pregameExpected, withExpected } from "../src/browser/stats";
import { classifyGame, summarize } from "../src/browser/tactics";

const fx = JSON.parse(readFileSync(new URL("./fixtures/tactics.json", import.meta.url), "utf8"));
const games = fx.games as Game[];
const analyses = fx.analyses as GameAnalysis[];

test("the pre-game expected score is recalibrated per time class and counts colour", () => {
  // equal ratings: White is a little ahead, Black a little behind, and the two add up to 1
  const w = pregameExpected(1500, 1500, "white", "blitz"), b = pregameExpected(1500, 1500, "black", "blitz");
  assert.ok(w > 0.51 && w < 0.52, String(w));
  assert.ok(Math.abs(w + b - 1) < 1e-12);
  // a 200-point favourite: Elo says 76%, the recalibrated formula much less, and bullet shrinks more than blitz
  const elo = 1 / (1 + 10 ** (-200 / 400));
  const blitz = pregameExpected(1700, 1500, "white", "blitz"), bullet = pregameExpected(1700, 1500, "white", "bullet");
  assert.ok(elo > 0.75 && blitz < 0.65 && bullet < blitz, `${elo} ${blitz} ${bullet}`);
  // daily (no fitted formula) keeps Elo
  assert.equal(pregameExpected(1700, 1500, "white", "daily"), elo);
});

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
  const r = buildRecap(g, a, classifyGame(g.pgn, a), history, tactics);
  const exp = pregameExpected(g.myRating, g.oppRating, g.color, g.timeClass);   // recalibrated, with colour
  assert.ok(Math.abs(r.expected - exp) < 1e-12);
  assert.ok(Math.abs(r.surprise - (g.score - exp)) < 1e-12);
  // history counts only *earlier* games in the same opening and color, never the game itself or later ones
  const earlier = games.filter(x => x.url !== g.url && x.endTime < g.endTime && x.family === g.family && x.color === g.color).length;
  assert.equal(r.opening.history?.n ?? 0, earlier);
  // turning point is the user's largest confirmed loss in that game
  const losses = a.moves.filter(m => m.is_me).map(m => (m as any).deep_loss ?? m.wp_loss);
  assert.ok(r.turning && Math.abs(r.turning.loss - Math.max(...losses)) < 1e-9);
  assert.equal(r.clean, false);
  // a pattern match is only for problems, and this profile already contains this game, so its count
  // is not added again
  if (r.pattern) {
    const stat = tactics.motifs.find(s => s.kind === r.pattern!.kind && s.motif === r.pattern!.motif)!;
    assert.ok(stat.higher && stat.verdict !== "no difference");
    assert.equal(r.pattern.count, stat.me);
  }
});

test("the turning point uses before and after scores from the depth that set its loss", () => {
  const a = analyses[0];
  const m = { ...a.moves[0], is_me: true, cp_before: 230, cp_after: -135, wp_loss: 32 };
  const build = (moves: GameAnalysis["moves"]) => buildRecap(games[0], { ...a, moves }, [], [], null).turning;
  assert.deepEqual(build([m])?.chances, { before: winPct(230), after: winPct(-135) });

  const deep = { ...m, deep_cp_before: 100, deep_cp_after: -100, deep_loss: 18 };
  assert.deepEqual(build([deep])?.chances, { before: winPct(100), after: winPct(-100) });
  const old = { ...m, deep_loss: 18 };
  assert.equal(build([old])?.chances, undefined);
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
  assert.match(note, /Scotch Game as White in 6 of their last 10 games as White, scoring 100% against an expected 52%/);
  const fresh = opponentNote("rival", opp, "London System", "white")!;
  assert.match(fresh, /new territory for rival: none of their last 10 games as White\. They usually play the Scotch Game \(6 games\)/);
  assert.equal(opponentNote("rival", opp.slice(0, 3), "Scotch Game", "white"), null);   // too few games to say
});

test("pre-game ratings come from the previous game in the same time class", async () => {
  const { withPregameRatings } = await import("../src/browser/games");
  const g = (url: string, timeClass: string, my: number, opp: number) => ({ url, timeClass, myRating: my, oppRating: opp }) as Game;
  // newest first; archive ratings are after each game
  const out = withPregameRatings([
    g("4", "blitz", 1508, 1492),    // won 8: went in at 1500 (after game 2), the opponent at 1500
    g("3", "rapid", 1700, 1650),    // the only rapid game: nothing earlier, kept as stored
    g("2", "blitz", 1500, 1510),    // lost 10 from 1510
    g("1", "blitz", 1510, 1480),    // the oldest blitz game: kept as stored
  ]);
  assert.deepEqual(out.map(x => [x.myRating, x.oppRating]), [[1500, 1500], [1700, 1650], [1510, 1500], [1510, 1480]]);
  assert.deepEqual(out.map(x => x.ratingSource), ["estimated", "after-game", "estimated", "after-game"]);
});

test("a recap's opening record ignores later games, matched by game ID across URL forms", () => {
  const history = withExpected(games);
  const i = analyses.findIndex(a => a.moves.some(m => m.is_me && ((m as any).deep_loss ?? m.wp_loss) >= 20));
  const g = { ...games[i], url: games[i].url.replace("/game/live/", "/game/") + "?move=3" };
  const later = history.map(r => ({ ...r, endTime: r.endTime + 10 ** 9 }));   // every game "after" this one
  const r = buildRecap(g, analyses[i], [], later, null);
  assert.equal(r.opening.history, null);
  assert.equal(r.opening.flag, null);                // the badge uses the same earlier-games slice
});

test("odds are labeled by where the ratings came from, and hidden when only post-game ratings exist", () => {
  const i = analyses.findIndex(a => a.moves.some(m => m.is_me));
  const base = { ...games[i], score: 1 };
  const exact = buildRecap({ ...base, ratingSource: "pregame" }, analyses[i], [], [], null);
  const est = buildRecap({ ...base, ratingSource: "estimated" }, analyses[i], [], [], null);
  const none = buildRecap({ ...base, ratingSource: "after-game", myRating: 1500, oppRating: 1900 }, analyses[i], [], [], null);
  assert.equal(exact.odds, "exact");
  assert.equal(est.odds, "estimated");
  assert.equal(est.expected, exact.expected);
  assert.equal(none.odds, "unknown");
  assert.equal(none.verdict, "Win");          // not "Big upset win": the ratings already include the result
  assert.equal(none.surprise, 0);
});
