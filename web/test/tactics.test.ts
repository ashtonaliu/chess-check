// The TypeScript tactic detector, summary and facts must match wf/tactics.py.
// Fixture: scripts/make_tactics_fixture.py (Lichess puzzle positions, CC0, and real games).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { GameAnalysis } from "../src/browser/engine";
import { buildFacts, pyFixed } from "../src/browser/facts";
import type { Game } from "../src/browser/games";
import { withExpected } from "../src/browser/stats";
import { motifs, normPpf, ratioInterval, summarize } from "../src/browser/tactics";

const fx = JSON.parse(readFileSync(new URL("./fixtures/tactics.json", import.meta.url), "utf8"));
const num = (x: unknown) => (x === "Infinity" ? Infinity : x === null ? NaN : (x as number));
const close = (a: number, b: number, tol: number, what: string) =>
  assert.ok((Number.isNaN(a) && Number.isNaN(b)) || a === b || Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test("motif detector matches python-chess on 3,000 Lichess puzzle positions", () => {
  const bad: string[] = [];
  for (const p of fx.positions) {
    const got = [...motifs(p.fen, { from: p.from, to: p.to, promotion: p.promotion ?? undefined })].sort();
    if (got.join() !== p.motifs.join()) bad.push(`${p.fen} ${p.from}${p.to}: ${got} vs ${p.motifs}`);
  }
  assert.equal(bad.length, 0, bad.slice(0, 5).join("\n"));
});

test("inverse normal and rate-ratio intervals", () => {
  close(normPpf(0.95), 1.6448536, 1e-6, "ppf .95");
  close(normPpf(1 - 0.1 / 36), 2.7729213, 1e-6, "bonferroni z (scipy: 2.772921294608663)");
  const [r, lo, hi] = ratioInterval(17, 12000, 4, 12100);
  close(r, (17 / 12000) / (4 / 12100), 1e-12, "ratio");
  assert.ok(lo > 1 && hi > lo);
});

test("tactic summary matches Python on real games", () => {
  const pgns = new Map<string, string>(fx.games.map((g: Game) => [g.url, g.pgn]));
  const s = summarize(fx.analyses as GameAnalysis[], pgns);
  const py = fx.summary;
  assert.equal(s.flagged, py.flagged);
  assert.equal(s.confirmed, py.confirmed);
  assert.equal(s.n_tests, py.n_tests);
  assert.deepEqual(s.forks_allowed_by, py.forks_allowed_by);
  assert.deepEqual(s.pieces_lost, py.pieces_lost);
  assert.deepEqual(s.motifs.map(m => [m.kind, m.motif, m.me, m.opp, m.verdict]),
                   py.motifs.map((m: any) => [m.kind, m.motif, m.me, m.opp, m.verdict]));
  s.motifs.forEach((m, i) => {
    close(m.ratio, num(py.motifs[i].ratio), 1e-9, `${m.motif} ratio`);
    close(m.ci_low, num(py.motifs[i].ci_low), 1e-9, `${m.motif} lo`);
    close(m.ci_high, num(py.motifs[i].ci_high), 1e-9, `${m.motif} hi`);
  });
  assert.deepEqual(s.pieces.map(p => [p.piece, p.moves, p.blunders, p.opp_blunders, p.verdict]),
                   py.pieces.map((p: any) => [p.piece, p.moves, p.blunders, p.opp_blunders, p.verdict]));
});

test("coach facts with tactics match Python exactly", () => {
  const pgns = new Map<string, string>(fx.games.map((g: Game) => [g.url, g.pgn]));
  const analyses = fx.analyses as GameAnalysis[];
  const facts = buildFacts(withExpected(fx.games as Game[]), analyses, null, summarize(analyses, pgns));
  assert.deepEqual(facts.map(f => [f.id, f.text]), fx.facts.map((f: any) => [f.id, f.text]));
});

test("Python-style fixed formatting rounds exact halves to even", () => {
  // expected values from Python: format(x, ".2f") etc.
  assert.deepEqual([pyFixed(1.125, 2), pyFixed(1.135, 2), pyFixed(0.25, 1), pyFixed(2.675, 2), pyFixed(0.375, 2),
                    pyFixed(-0.125, 2), pyFixed(3.5, 0), pyFixed(4.5, 0)],
                   ["1.12", "1.14", "0.2", "2.67", "0.38", "-0.12", "4", "4"]);
});
