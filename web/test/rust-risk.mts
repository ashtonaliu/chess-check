import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { features, playerRisk, predict, rowsOf, type Risk, type Row } from "../src/browser/model";
import { createWasmRiskModel } from "../src/browser/riskWasm";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const fixture = load("model");
const bytes = readFileSync(new URL("../rust/risk/target/wasm32-unknown-unknown/release/chess_check_risk.wasm", import.meta.url));
const fit = await createWasmRiskModel(Uint8Array.from(bytes).buffer);
const rows: Row[] = fixture.rows;
const { X, y } = features(rows);
const opponents = rows.flatMap((row, i) => row.is_me ? [] : [i]);
const model = fit(opponents.map(i => X[i]), opponents.map(i => y[i]));
for (const [i, x] of X.entries()) {
  assert.ok(Math.abs(predict(model, x) - fixture.full_fit_proba[i]) < 1e-8, `Probability at row ${i}`);
}

function compare(actual: Risk | null, expected: Risk | null, tolerance: number) {
  if (!actual || !expected) {
    assert.equal(actual, expected);
    return;
  }
  const compareBucket = (a: typeof actual | Risk["buckets"][number], b: typeof expected | Risk["buckets"][number]) => {
    for (const key of ["actual", "moves"] as const) assert.equal(a[key], b[key]);
    for (const key of ["expected", "ratio", "ci_low", "ci_high"] as const) {
      assert.ok(Math.abs(a[key] - b[key]) <= tolerance, `${key}: ${a[key]} vs ${b[key]}`);
    }
  };
  compareBucket(actual, expected);
  assert.equal(actual.buckets.length, expected.buckets.length);
  for (const [i, bucket] of actual.buckets.entries()) {
    assert.equal(bucket.label, expected.buckets[i].label);
    compareBucket(bucket, expected.buckets[i]);
  }
}

compare(playerRisk(rows, 5, undefined, fit), fixture.risk, 1e-4);
const savedRows = rowsOf(load("tactics").analyses);
for (const sample of [rows, savedRows, []]) {
  compare(playerRisk(sample, 5, undefined, fit), playerRisk(sample), 1e-9);
}
console.log("Rust risk reports match TypeScript and the Python fixture.");

const samples = Array.from({ length: 6 }, (_, i) =>
  savedRows.map(row => ({ ...row, url: `${i}:${row.url}` }))).flat();
const times = [[], []] as number[][];
for (let run = 0; run < 7; run++) {
  for (const i of [run % 2, 1 - run % 2]) {
    const start = performance.now();
    assert.ok(playerRisk(samples, 5, undefined, i ? fit : undefined));
    times[i].push(performance.now() - start);
  }
}
console.log("Median risk stage for 150 games (TypeScript, Wasm):",
  times.map(values => values.sort((a, b) => a - b)[3].toFixed(1)).join(", "), "ms");
