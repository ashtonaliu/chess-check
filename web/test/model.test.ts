// The in-browser blunder model must reproduce scikit-learn on real games.
// Fixture: scripts/make_model_fixture.py.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { FEATURES, features, fitLogReg, groupFolds, playerRisk, poissonRatioInterval, predict, type Row } from "../src/browser/model";

const fx = JSON.parse(readFileSync(new URL("./fixtures/model.json", import.meta.url), "utf8"));
const rows = fx.rows as Row[];
const close = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

test("feature names and order match Python", () => {
  assert.deepEqual([...FEATURES], fx.features);
});

test("GroupKFold fold assignment is reproduced exactly", () => {
  assert.deepEqual(groupFolds(rows.map(r => r.url)), fx.folds);
});

test("logistic regression reaches scikit-learn's optimum", () => {
  const { X, y } = features(rows);
  const opp = rows.map((r, i) => i).filter(i => !rows[i].is_me);
  const m = fitLogReg(opp.map(i => X[i]), opp.map(i => y[i]));
  let worst = 0;
  X.forEach((x, i) => { worst = Math.max(worst, Math.abs(predict(m, x) - fx.full_fit_proba[i])); });
  assert.ok(worst < 1e-6, `max probability difference ${worst}`);
});

test("player risk matches scikit-learn (overall and per clock band)", () => {
  const r = playerRisk(rows)!;
  const p = fx.risk;
  assert.equal(r.moves, p.moves);
  assert.equal(r.actual, p.actual);
  close(r.expected, p.expected, 1e-4, "expected blunders");
  close(r.ci_low, p.ci_low, 1e-6, "ci_low");
  close(r.ci_high, p.ci_high, 1e-6, "ci_high");
  assert.equal(r.buckets.length, p.buckets.length);
  r.buckets.forEach((b, i) => {
    assert.equal(b.label, p.buckets[i].label);
    assert.equal(b.actual, p.buckets[i].actual);
    close(b.expected, p.buckets[i].expected, 1e-4, `${b.label} expected`);
  });
});

test("Poisson interval is close to the exact chi-square interval", () => {
  // exact 90% bounds for a = 13: 7.690 .. 20.669
  const [lo, hi] = poissonRatioInterval(13, 1);
  assert.ok(Math.abs(lo - 7.690) < 0.01 && Math.abs(hi - 20.669) < 0.01, `${lo} ${hi}`);
});
