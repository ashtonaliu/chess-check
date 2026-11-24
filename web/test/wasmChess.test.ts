import assert from "node:assert/strict";
import { test } from "node:test";

import { WasmChess, type ChessBindings } from "../src/browser/wasmChess";

test("WasmChess.replay rejects empty move entries before joining with newlines", () => {
  // Stub bindings matching Rust's str::lines(), which drops a trailing empty line.
  const calls: string[] = [];
  const bindings = {
    GameReplay: class {
      constructor(_fen: string | undefined, history: string) { calls.push(history); }
      positions() { return "[]"; }
      formatUci() { return "[]"; }
      free() {}
    },
  } as unknown as ChessBindings;
  const wasm = new WasmChess(bindings);
  assert.equal(wasm.replay(undefined, [""]), null);
  assert.equal(wasm.replay(undefined, ["e4", ""]), null);
  assert.deepEqual(calls, []);
});
