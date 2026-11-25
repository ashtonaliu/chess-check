// Lichess game and NDJSON parsing tests, including 20-game parity with Phase A
// ingest (docs/lichess-plan.md Part 3).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseLichessGame, parseLichessNdjson, type LichessExport } from "../src/browser/lichess";

const parseClocks = (pgn: string) =>
  [...pgn.matchAll(/\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g)].map(m => +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]));

const BASE = ["https", "lichess.org"].join("://");

interface ParityExpected {
  game_id: string;
  url: string;
  white: string;
  black: string;
  white_rating_before: number;
  black_rating_before: number;
  time_control: string;
  time_class: string;
  eco: string;
  opening: string;
  result: string;
  moves: { ply: number; san: string; uci: string; clock_after: number | null }[];
}

interface ParityFixture {
  expected: ParityExpected[];
  exports: Record<string, LichessExport>;
}

const baseExport = (over: Partial<LichessExport> = {}): LichessExport => ({
  id: "AbCdEf12",
  variant: "standard",
  speed: "blitz",
  createdAt: 1_760_000_000_000,
  lastMoveAt: 1_760_000_120_000,
  status: "resign",
  winner: "white",
  moves: "e4 e5 Nf3 Nc6",
  clocks: [18000, 18000, 17850, 17700],
  clock: { initial: 180, increment: 2 },
  opening: { eco: "C44", name: "King's Knight Opening: Normal Variation" },
  players: {
    white: { user: { id: "alice", name: "Alice" }, rating: 1500, ratingDiff: 8 },
    black: { user: { id: "bob", name: "Bob" }, rating: 1520, ratingDiff: -8 },
  },
  ...over,
});

test("20-game parity with Phase A Lichess ingest on moves, ratings, result, speed, and clocks", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/lichess_parity.json", import.meta.url), "utf8"),
  ) as ParityFixture;
  assert.equal(fixture.expected.length, 20);

  for (const exp of fixture.expected) {
    const raw = fixture.exports[exp.game_id];
    assert.ok(raw, `missing export for ${exp.url}`);

    const whiteView = parseLichessGame(raw, exp.white);
    assert.ok(whiteView, `parseLichessGame failed for ${exp.url} (white=${exp.white})`);
    assert.equal(whiteView.url, exp.url, exp.url);
    assert.equal(whiteView.site, "lichess", exp.url);
    assert.deepEqual(whiteView.moves, exp.moves.map(m => m.san), exp.url);
    assert.equal(whiteView.myRating, exp.white_rating_before, exp.url);
    assert.equal(whiteView.oppRating, exp.black_rating_before, exp.url);
    assert.equal(whiteView.ratingSource, "pregame", exp.url);
    assert.equal(whiteView.timeClass, exp.time_class, exp.url);
    assert.equal(whiteView.timeControl, exp.time_control, exp.url);
    assert.equal(whiteView.eco, exp.eco, exp.url);
    assert.equal(whiteView.opening, exp.opening, exp.url);
    const expectedWhiteScore = exp.result === "1-0" ? 1 : exp.result === "0-1" ? 0 : 0.5;
    assert.equal(whiteView.score, expectedWhiteScore, exp.url);

    const parsedClocks = parseClocks(whiteView.pgn);
    assert.equal(parsedClocks.length, exp.moves.length, exp.url);
    for (let i = 0; i < exp.moves.length; i++) {
      const expectedSec = exp.moves[i].clock_after;
      if (expectedSec !== null) {
        assert.ok(Math.abs(parsedClocks[i] - expectedSec) <= 1, `${exp.url} ply ${i}`);
      }
    }

    const blackView = parseLichessGame(raw, exp.black);
    assert.ok(blackView, `parseLichessGame failed for ${exp.url} (black=${exp.black})`);
    assert.equal(blackView.myRating, exp.black_rating_before, exp.url);
    assert.equal(blackView.oppRating, exp.white_rating_before, exp.url);
    assert.equal(blackView.score, 1 - expectedWhiteScore, exp.url);
  }
});

test("every Lichess status maps to expected Chess.com-compatible result codes or null", () => {
  for (const pendingOrAborted of ["created", "started", "aborted", "noStart"]) {
    assert.equal(parseLichessGame(baseExport({ status: pendingOrAborted }), "Alice"), null, pendingOrAborted);
  }

  const winCases: [string, string][] = [
    ["mate", "checkmated"],
    ["resign", "resigned"],
    ["timeout", "timeout"],
    ["outoftime", "timeout"],
    ["cheat", "cheat"],
    ["variantEnd", "variantEnd"],
    ["unknownFinish", "unknownFinish"],
  ];
  for (const [status, loserCode] of winCases) {
    const w = parseLichessGame(baseExport({ status, winner: "white" }), "alice");
    assert.ok(w, status);
    assert.equal(w.score, 1, status);
    assert.equal(w.result, "win", status);
    assert.equal(w.oppResult, loserCode, status);

    const b = parseLichessGame(baseExport({ status, winner: "white" }), "bob");
    assert.ok(b, status);
    assert.equal(b.score, 0, status);
    assert.equal(b.result, loserCode, status);
    assert.equal(b.oppResult, "win", status);
  }

  const drawCases: [string, string][] = [
    ["draw", "agreed"],
    ["stalemate", "stalemate"],
    ["insufficientMaterialClaim", "insufficient"],
    ["timeout", "timevsinsufficient"],
    ["outoftime", "timevsinsufficient"],
    ["unknownFinish", "agreed"],
    ["variantEnd", "agreed"],
  ];
  for (const [status, drawCode] of drawCases) {
    const g = parseLichessGame(baseExport({ status, winner: undefined }), "alice");
    assert.ok(g, status);
    assert.equal(g.score, 0.5, status);
    assert.equal(g.result, drawCode, status);
    assert.equal(g.oppResult, drawCode, status);
  }
});

test("rejects non-standard variants, custom initialFen, and games user did not play", () => {
  assert.equal(parseLichessGame(baseExport({ variant: "chess960" }), "alice"), null);
  assert.equal(parseLichessGame(baseExport({ initialFen: "4k3/8/8/8/8/8/8/4K3 w - - 0 1" }), "alice"), null);
  assert.equal(parseLichessGame(baseExport(), "charlie"), null);
  assert.equal(parseLichessGame(null, "alice"), null);
});

test("maps Lichess speeds including correspondence to daily", () => {
  for (const speed of ["ultraBullet", "bullet", "blitz", "rapid", "classical"]) {
    const g = parseLichessGame(baseExport({ speed }), "alice");
    assert.equal(g?.timeClass, speed);
  }
  const daily = parseLichessGame(baseExport({ speed: "correspondence", clock: undefined, daysPerTurn: 3 }), "alice");
  assert.equal(daily?.timeClass, "daily");
  assert.equal(daily?.timeControl, "1/259200");
});

test("parseLichessNdjson skips malformed lines and non-matching games without throwing", () => {
  const ndjson = [
    JSON.stringify(baseExport({ id: "Game0001" })),
    "{bad json",
    "",
    JSON.stringify(baseExport({ id: "Game0002", status: "started" })),
    JSON.stringify(baseExport({ id: "Game0003", variant: "antichess" })),
    JSON.stringify(baseExport({ id: "Game0004" })),
  ].join("\n");
  const { games, skipped } = parseLichessNdjson(ndjson, "alice");
  assert.deepEqual(games.map(g => g.url), [`${BASE}/game/Game0001`, `${BASE}/game/Game0004`]);
  assert.equal(skipped, 3);
});
