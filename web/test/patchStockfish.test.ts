// The build's one change to Stockfish.js: its zero-length sleeps yield without the 4 ms timer minimum.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// @ts-expect-error plain JavaScript build script
import { ENGINE, patch, SLEEP, YIELD } from "../scripts/patchStockfish.mjs";

const source = readFileSync(new URL(`../node_modules/stockfish/bin/${ENGINE}.js`, import.meta.url), "utf8");

test("the installed engine has the sleep exactly once, and the patch changes only that", () => {
  const out = patch(source);
  assert.equal(out.split(YIELD).length - 1, 1);
  assert.equal(out.includes(SLEEP), false);
  assert.equal(out.length - source.length, YIELD.length - SLEEP.length);
  assert.equal(out.replace(YIELD, SLEEP), source);
});

test("a different engine version fails the build instead of shipping unpatched", () => {
  assert.throws(() => patch("no sleep here"), /found it 0 times/);
  assert.throws(() => patch(SLEEP + SLEEP), /found it 2 times/);
});

test("the replacement yields once for a zero sleep and waits for a longer one", async () => {
  // run the replacement the way the engine does: e is the requested sleep in ms
  const make = new Function("e", `return (${YIELD})`) as (e: number) => () => Promise<void>;
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) await make(0)();
  const zero = (performance.now() - t0) / 200;
  assert.ok(zero < 2, `a zero sleep took ${zero.toFixed(2)} ms on average`);
  const t1 = performance.now();
  await make(30)();
  assert.ok(performance.now() - t1 >= 25);
});
