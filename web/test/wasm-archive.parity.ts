// Real-archive checks for the WebAssembly path: the PGN parser against chess.js on 400 finished
// Chess.com games, and the engine pass and blunder recheck end to end with each backend.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Chess } from "chess.js";

import { analyseGames, recheckBlunders, type GameAnalysis } from "../src/browser/engine";
import { parseGame } from "../src/browser/games";
import { configureWasmChess, getWasmChess, WasmChess } from "../src/browser/wasmChess";

interface RawGame { url: string; pgn: string; white: { username: string; result: string }; black: { username: string; result: string } }
const archive: { games: RawGame[] } = JSON.parse(readFileSync(new URL("./fixtures/archive_pgns.json", import.meta.url), "utf8"));
const assets = new URL("../../extension/engine/", import.meta.url);
const moduleUrl = new URL("engine_core.js", assets).href;
const wasmBytes = readFileSync(new URL("engine_core_bg.wasm", assets));
const bindings = await import(moduleUrl);
bindings.initSync({ module: wasmBytes });
const wasm = new WasmChess(bindings);

test("the WebAssembly PGN parser matches chess.js on 400 real archive games", () => {
  assert.equal(archive.games.length, 400);
  const results = new Set(archive.games.flatMap(g => [g.white.result, g.black.result]));
  for (const result of ["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]) {
    assert.ok(results.has(result), `the fixture covers ${result}`);
  }
  const parsed = wasm.parsePgns(archive.games.map(g => g.pgn));
  for (const [i, raw] of archive.games.entries()) {
    const result = parsed[i];
    assert.ok(result, raw.url);
    const ref = new Chess();
    ref.loadPgn(raw.pgn);
    const tags = ref.getHeaders();
    assert.deepEqual(result.moves, ref.history(), `${raw.url} SAN history`);
    assert.equal(result.eco, tags.ECO, `${raw.url} ECO`);
    assert.equal(result.ecoUrl, tags.ECOUrl, `${raw.url} ECOUrl`);
    assert.equal(result.startFen, tags.FEN, `${raw.url} FEN`);
    // The Game record the extension stores is the same either way.
    assert.deepEqual(parseGame(raw as never, raw.white.username, result), parseGame(raw as never, raw.white.username), raw.url);
  }
});

// A stand-in for Stockfish whose answers depend only on the position and depth, so both backends
// see identical searches. Its scores swing widely, which flags many moves for the recheck.
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}

class WorkerStub {
  onmessage?: (message: { data: string }) => void;
  private fen = "";
  postMessage(command: string) {
    if (command.startsWith("position fen ")) { this.fen = command.slice("position fen ".length); return; }
    queueMicrotask(() => {
      const send = (data: string) => this.onmessage?.({ data });
      if (command === "uci") send("uciok");
      else if (command === "isready") send("readyok");
      else if (command.startsWith("go depth ")) {
        const depth = command.slice("go depth ".length);
        const board = new Chess(this.fen);
        const moves = board.moves({ verbose: true }).map(m => m.lan).sort();
        const h = hash(`${this.fen}|${depth}`);
        if (!moves.length) {
          send(`info depth ${depth} score ${board.inCheck() ? "mate 0" : "cp 0"} nodes 1`);
          send("bestmove (none)");
          return;
        }
        const best = moves[h % moves.length];
        board.move(best);
        const replies = board.moves({ verbose: true }).map(m => m.lan).sort();
        const pv = replies.length ? `${best} ${replies[(h >>> 8) % replies.length]}` : best;
        const score = h % 11 === 0 ? `mate ${1 + (h % 4)}` : `cp ${(h % 1201) - 600}`;
        send(`info depth ${depth} score ${score} nodes ${100 + (h % 5000)} pv ${pv}`);
        send(`bestmove ${best}`);
      }
    });
  }
  terminate() {}
}

async function build(games: ReturnType<typeof parseGame>[]): Promise<GameAnalysis[]> {
  const analyses = await analyseGames(games.map(g => g!), { depth: 8, engineUrl: "", workers: 1 });
  await recheckBlunders(analyses, { engineUrl: "", workers: 1 });
  return analyses;
}

test("the engine pass and recheck give identical move rows with chess.js and WebAssembly", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: WorkerStub });
  t.after(() => {
    configureWasmChess(undefined);
    if (original) Object.defineProperty(globalThis, "Worker", original);
    else Reflect.deleteProperty(globalThis, "Worker");
  });
  const raw = archive.games.slice(0, 60);
  const parsed = wasm.parsePgns(raw.map(g => g.pgn));
  const viaJs = raw.map(g => parseGame(g as never, g.white.username));
  const viaWasm = raw.map((g, i) => parseGame(g as never, g.white.username, parsed[i]));
  assert.deepEqual(viaWasm, viaJs);

  configureWasmChess(undefined);
  const expected = await build(viaJs);
  configureWasmChess(moduleUrl, wasmBytes);
  // A module that failed to load would fall back to chess.js and make this comparison trivial.
  assert.ok(await getWasmChess(), "the WebAssembly module loaded");
  const actual = await build(viaWasm);

  const rows = expected.reduce((n, a) => n + a.moves.length, 0);
  const rechecked = expected.reduce((n, a) => n + a.moves.filter(m => "deep_loss" in m).length, 0);
  assert.ok(rows > 3000 && rechecked > 300, `${rows} rows, ${rechecked} rechecked`);
  t.diagnostic(`${raw.length} games, ${rows} move rows, ${rechecked} rechecked`);
  for (const [i, analysis] of expected.entries()) assert.deepEqual(actual[i], analysis, raw[i].url);
});
