// Build Wasm with node web/test/rust-tactics.mjs, then run:
// (cd web && node --import tsx test/rust-reports.mts)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { GameAnalysis } from "../src/browser/engine";
import type { Game } from "../src/browser/games";
import { classifyGame, summarize } from "../src/browser/tactics";
import { createWasmClassifier } from "../src/browser/tacticsWasm";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tactics.json", import.meta.url), "utf8"));
const wasm = readFileSync(new URL("../rust/tactics/target/wasm32-unknown-unknown/release/chess_check_tactics.wasm", import.meta.url));
const initStart = performance.now();
const classify = await createWasmClassifier(Uint8Array.from(wasm).buffer);
const initMs = performance.now() - initStart;
const analyses: GameAnalysis[] = fixture.analyses;
const pgns = new Map<string, string>(fixture.games.map((game: Game) => [game.url, game.pgn]));

for (const game of analyses) {
  const pgn = pgns.get(game.url)!;
  assert.deepEqual(classifyGame(pgn, game, classify), classifyGame(pgn, game), game.url);
}
assert.deepEqual(summarize(analyses, pgns, 16, classify), summarize(analyses, pgns));
console.log(`Wasm and TypeScript match on ${analyses.length} saved game reports and their combined summary.`);

if (process.argv.includes("--benchmark")) {
  // Repeat the 25-game sample to approximate the number of games in a typical report.
  const games = Array.from({ length: 6 }, () => analyses).flat();
  const measure = (classifier?: typeof classify) => {
    const start = performance.now();
    summarize(games, pgns, 16, classifier);
    return performance.now() - start;
  };
  const ts: number[] = [];
  const rust: number[] = [];
  for (let i = 0; i < 9; i++) {
    if (i % 2 === 0) {
      ts.push(measure());
      rust.push(measure(classify));
    } else {
      rust.push(measure(classify));
      ts.push(measure());
    }
  }
  const median = (samples: number[]) => samples.sort((a, b) => a - b)[4].toFixed(1);
  console.log(`Wasm initialization (local bytes): ${initMs.toFixed(1)} ms.`);
  console.log(`Median full tactic summary (150 games, warm Wasm): TypeScript ${median(ts)} ms, Wasm ${median(rust)} ms.`);
}
