import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openingTable, withExpected } from "../src/browser/stats";
import { createWasmOpeningModel } from "../src/browser/openingsWasm";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const bytes = readFileSync(new URL("../rust/openings/target/wasm32-unknown-unknown/release/chess_check_openings.wasm", import.meta.url));
const model = await createWasmOpeningModel(Uint8Array.from(bytes).buffer);
// Reject a trap rather than letting openingTable's runtime fallback hide it.
let calls = 0;
let failure: unknown;
const strict: typeof model = (...args) => {
  calls++;
  try {
    return model(...args);
  } catch (error) {
    failure = error;
    throw error;
  }
};

const fixture = load("parity");
for (const games of [fixture.games, load("tactics").games, fixture.games.slice(0, 1), []]) {
  const rows = withExpected(games);
  const ts = openingTable(rows, 1);
  const wasm = openingTable(rows, 1, strict);
  assert.equal(wasm.length, ts.length);
  for (const [i, expected] of ts.entries()) {
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      const actual = wasm[i][key];
      const value = expected[key];
      if (typeof actual === "number" && typeof value === "number" && Number.isFinite(value)) {
        assert.ok(Math.abs(actual - value) <= 1e-9, `${expected.family} ${key}: ${actual} vs ${value}`);
      } else {
        assert.equal(actual, value, key);
      }
    }
  }
}
const rows = withExpected(fixture.games);
const wasm = openingTable(rows, 3, strict);
assert.equal(failure, undefined);
assert.ok(calls > 0);
assert.equal(wasm.length, fixture.opening_table.length);
for (const row of wasm) {
  const expected = fixture.opening_table.find(r => r.color === row.color && r.family === row.family);
  assert.ok(expected);
  assert.equal(row.verdict, expected.verdict);
  for (const [key, tolerance] of [["shrunk", 1e-9], ["p_below", 1e-6], ["ci_low", 0.001001], ["ci_high", 0.001001]] as const) {
    assert.ok(Math.abs(row[key] - expected[key]) <= tolerance, `${row.family} ${key}`);
  }
}
console.log("Opening reports match TypeScript and the Python fixture.");
const samples = withExpected(fixture.games.slice(0, 150));
const times = [[], []] as number[][];
for (let run = 0; run < 7; run++) {
  for (const i of [run % 2, 1 - run % 2]) {
    const start = performance.now();
    openingTable(samples, 3, i ? strict : undefined);
    times[i].push(performance.now() - start);
  }
}
assert.equal(failure, undefined);
console.log("Median opening table for 150 saved games (TypeScript, Wasm):",
  times.map(values => values.sort((a, b) => a - b)[3].toFixed(1)).join(", "), "ms");
