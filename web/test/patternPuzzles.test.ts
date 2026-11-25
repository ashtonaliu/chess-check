// Bundled Lichess CC0 pattern puzzle selection and recap card links.
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { test } from "node:test";

import type { Recap } from "../src/browser/recap";
import { PATTERN_PUZZLE_BAND, pickPatternPuzzles } from "../src/browser/patternPuzzles";
import { patternMarkup } from "../src/ui/recapCard";

const LICHESS_TRAINING = ["https:", "", "lichess.org", "training", ""].join("/");
const REPORTED_MOTIFS = ["mate", "fork", "skewer", "discoveredAttack", "hangingPiece", "promotion"];

test("bundled puzzle index stays under 150 KB and covers every reported motif", () => {
  const bytes = statSync(new URL("../src/browser/patternPuzzlesIndex.json", import.meta.url)).size;
  assert.ok(bytes > 0 && bytes < 150_000, `expected index < 150 KB, got ${bytes}`);
  for (const motif of REPORTED_MOTIFS) {
    const picked = pickPatternPuzzles(motif, "game-1");
    assert.equal(picked.length, 3, `${motif} should return 3 puzzles`);
    assert.equal(new Set(picked.map(p => p.id)).size, 3, `${motif} puzzles must not repeat`);
    for (const p of picked) {
      assert.ok(p.rating >= PATTERN_PUZZLE_BAND[0] && p.rating <= PATTERN_PUZZLE_BAND[1],
        `${motif} rating ${p.rating} outside ${PATTERN_PUZZLE_BAND}`);
      assert.equal(p.url, `${LICHESS_TRAINING}${p.id}`);
    }
  }
});

test("picking from the index spreads across bands, avoids repeats, and returns empty for unmapped motifs", () => {
  const small = {
    source: "test",
    bands: [[1200, 1399], [1400, 1599], [1600, 1799]] as const,
    motifs: {
      fork: [
        [["a1", 1250], ["a2", 1310]],
        [["b1", 1450], ["a1", 1490]],
        [["c1", 1650]],
      ],
    },
  };
  const picked = pickPatternPuzzles("fork", "seed-42", 3, small);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map(p => p.id)).size, 3);
  assert.deepEqual(pickPatternPuzzles("unknownMotif", "seed-42", 3, small), []);
  assert.deepEqual(pickPatternPuzzles("pin", "seed-42"), []);
  assert.deepEqual(pickPatternPuzzles("backRankMate", "seed-42"), []);
});

test("recap pattern markup renders up to three Lichess training links in new tabs", () => {
  const base = {
    url: ["https:", "", "www.chess.com", "game", "live", "187502325560"].join("/"),
    pattern: { kind: "missed", motif: "fork", count: 7, verdict: "pattern" },
  } as Recap;
  const html = patternMarkup(base);
  assert.match(html, /Practice this pattern \(Lichess puzzle rating 1200-1799\)/);
  const links = [...html.matchAll(/<a href="([^"]+)" target="_blank" rel="noopener">Puzzle \d+ \((\d+)\)<\/a>/g)];
  assert.equal(links.length, 3);
  const ids = new Set<string>();
  for (const [, href, ratingStr] of links) {
    assert.ok(href.startsWith(LICHESS_TRAINING), `unexpected href ${href}`);
    const id = href.slice(LICHESS_TRAINING.length);
    assert.ok(!ids.has(id), "duplicate puzzle link");
    ids.add(id);
    const rating = Number(ratingStr);
    assert.ok(rating >= 1200 && rating <= 1799);
  }

  // Unmapped motif shows the pattern text without puzzle links.
  const unmapped = patternMarkup({ ...base, pattern: { kind: "missed", motif: "pin", count: 4, verdict: "pattern" } } as Recap);
  assert.ok(unmapped.includes("Matches your pattern:"));
  assert.ok(!unmapped.includes("Practice this pattern"));
  assert.equal(patternMarkup({ ...base, pattern: null } as Recap), "");
});
