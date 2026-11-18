// The browser's find-rate model must reproduce Python's features and probabilities.
// Fixture: scripts/eval_find_rate.py evaluate (300 held-out positions).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { findProbability, findRate, moveFeatures } from "../src/browser/findRate";

const fx = JSON.parse(readFileSync(new URL("./fixtures/find_rate.json", import.meta.url), "utf8")) as
  { fen: string; best: string; rating: number; features: Record<string, number>; p: number }[];

test("move features match python-chess on 300 held-out positions", () => {
  for (const row of fx) assert.deepEqual(moveFeatures(row.fen, row.best), row.features, `${row.fen} ${row.best}`);
});

test("probabilities match scikit-learn", () => {
  for (const row of fx) {
    const p = findProbability(moveFeatures(row.fen, row.best)!, row.rating);
    assert.ok(Math.abs(p - row.p) < 1e-4, `${row.fen}: ${p} vs ${row.p}`);
  }
});

test("SAN works as well as UCI, and an illegal move gives null", () => {
  const fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
  assert.equal(findRate(fen, "Nc6", 1600), findRate(fen, "b8c6", 1600));
  assert.equal(findRate(fen, "Ke7e5", 1600), null);
  assert.equal(findRate("not a fen", "e4", 1600), null);
});

test("no estimate for ratings the model does not cover", () => {
  const fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  assert.equal(findRate(fen, "Nf3", 800), null, "not the 1200 figure labeled as 800");
  assert.equal(findRate(fen, "Nf3", 2400), null);
  assert.ok(findRate(fen, "Nf3", 1500)! > 0);
});
