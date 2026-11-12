// The TypeScript statistics must reproduce the Python implementation.
// Fixture: scripts/make_parity_fixture.py (Python's inputs and outputs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { Game } from "../src/browser/games";
import { openingNames } from "../src/browser/games";
import { expectedScore, normCdf, openingTable, overall, withExpected, worstBranch } from "../src/browser/stats";

const fx = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf8"));
const rows = withExpected(fx.games as Game[]);
const close = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test("expected score and normal CDF", () => {
  close(expectedScore(1500, 1500), 0.5, 1e-12, "even");
  close(expectedScore(1900, 1500), 0.90909, 1e-4, "+400");
  close(normCdf(1.645), 0.95002, 1e-5, "cdf");
});

test("opening family names match Python", () => {
  for (const [slug, [full, family]] of fx.opening_names) {
    assert.deepEqual(openingNames(slug), [full, family], slug);
  }
});

test("overall numbers match Python", () => {
  const o = overall(rows);
  assert.equal(o.games, fx.overall.games);
  close(o.score, fx.overall.score, 1e-12, "score");
  close(o.expected, fx.overall.expected, 1e-12, "expected");
});

test("opening table matches Python (shrinkage, intervals, verdicts)", () => {
  const ts = openingTable(rows);
  assert.equal(ts.length, fx.opening_table.length);
  const py = new Map(fx.opening_table.map((r: any) => [`${r.color}|${r.family}`, r]));
  for (const r of ts) {
    const p: any = py.get(`${r.color}|${r.family}`);
    assert.ok(p, `missing ${r.family}`);
    assert.equal(r.n, p.n);
    close(r.mean_resid, p.mean_resid, 1e-12, `${r.family} mean_resid`);
    close(r.shrunk, p.shrunk, 1e-9, `${r.family} shrunk`);
    close(r.p_below, p.p_below, 1e-6, `${r.family} p_below`);
    // interval endpoints come from a 0.001 grid; allow one step
    close(r.ci_low, p.ci_low, 1.001e-3, `${r.family} ci_low`);
    close(r.ci_high, p.ci_high, 1.001e-3, `${r.family} ci_high`);
    assert.equal(r.verdict, p.verdict, `${r.family} verdict`);
  }
});

test("worst branches match Python", () => {
  for (const { color, family, branch } of fx.branches) {
    const b = worstBranch(rows, color, family);
    if (branch === null) { assert.equal(b, null, family); continue; }
    assert.ok(b, `${family}: expected a branch`);
    assert.equal(b.moves, branch.moves, family);
    assert.equal(b.n, branch.n, family);
  }
});
