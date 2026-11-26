import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Chess } from "chess.js";

import { parseFenBoard, resolveBoardMove } from "../src/browser/boardMove";
import { moveFeatures } from "../src/browser/findRate";
import { parseGame } from "../src/browser/games";
import { WasmChess } from "../src/browser/wasmChess";

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const assets = new URL("../../extension/engine/", import.meta.url);
const bindings = await import(new URL("engine_core.js", assets).href);
bindings.initSync({ module: readFileSync(new URL("engine_core_bg.wasm", assets)) });
const wasm = new WasmChess(bindings);

test("WASM counts legal moves and captures, preserves FEN and formats every fixture UCI as chess.js SAN", () => {
  const fixture: { positions: [string, string][] } = json("../../engine-core/tests/fixtures/chess_js_parity.json");
  assert.equal(fixture.positions.length, 10_000);
  for (let start = 0; start < fixture.positions.length; start += 128) {
    const rows = fixture.positions.slice(start, start + 128);
    const stats = wasm.positions(rows.map(([fen]) => fen));
    const fens = [], expected = [], requests = [];
    for (const [i, [fen, packed]] of rows.entries()) {
      const chess = new Chess(fen);
      const san = chess.moves();
      assert.ok(stats[i], fen);
      assert.equal(stats[i].fen, chess.fen(), fen);
      assert.equal(stats[i].legal, san.length, fen);
      assert.equal(stats[i].captures, san.filter(m => m.includes("x")).length, fen);
      for (const move of packed.split(";").filter(Boolean)) {
        const [uci, san] = move.split(" ");
        requests.push({ fen, move: uci });
        expected.push(san);
      }
      if (san[0]) fens.push({ fen, move: san[0] });
    }
    assert.deepEqual(wasm.san(requests), expected);
    const after = wasm.advance(fens);
    for (const [i, row] of fens.entries()) {
      const board = new Chess(row.fen);
      board.move(row.move);
      assert.equal(after[i]?.fen, board.fen());
      assert.equal(after[i]?.mate, board.isCheckmate());
      assert.equal(after[i]?.over, board.isGameOver());
    }
  }
});

test("the WASM batches reproduce all 16 chess.js move features on the existing feature fixture", () => {
  const fixture: { feature_names: string[]; positions: [string, string, number[]][] } =
    json("../../engine-core/tests/fixtures/find_rate_features.json");
  assert.equal(fixture.positions.length, 10_000);
  for (let start = 0; start < fixture.positions.length; start += 256) {
    const batch = fixture.positions.slice(start, start + 256);
    const observed = wasm.features(batch.map(([fen, move]) => ({ fen, move })));
    for (const [i, [fen, move, expected]] of batch.entries()) {
      const js = moveFeatures(fen, move);
      assert.ok(js, `${fen} ${move}`);
      assert.deepEqual(observed[i], fixture.feature_names.map(key => js[key as keyof typeof js]), `${fen} ${move}`);
      assert.deepEqual(observed[i], expected);
    }
  }
});

test("archive PGNs and one-board replay match chess.js, including promotions and draw state", () => {
  const raw = ["archive_187138001290", "archive_promo", "archive_promo_capture"].map(name => json(`fixtures/${name}.json`));
  const repetition = "1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 (3. Nc3 Nc6) Nf6 4. Ng1 {offer} Ng8 1/2-1/2";
  const custom = '[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/p7/4K3 b - - 0 1"]\n\n1... a1=R+ *';
  const pgns = [...raw.map(game => game.pgn), repetition, custom];
  const parsed = wasm.parsePgns(pgns);
  for (const [i, pgn] of pgns.entries()) {
    const result = parsed[i];
    assert.ok(result);
    const ref = new Chess();
    ref.loadPgn(pgn);
    const history = ref.history({ verbose: true });
    assert.deepEqual(result.moves, history.map(move => move.san));
    if (i < raw.length) assert.deepEqual(parseGame(raw[i], raw[i].white.username, result), parseGame(raw[i], raw[i].white.username));
    const replay = wasm.replay(result.startFen, result.moves);
    assert.ok(replay);
    try {
      const board = new Chess(result.startFen);
      const summary = replay.plies();
      const ucis = history.map(m => m.lan);
      assert.deepEqual(replay.san(ucis), history.map(m => m.san));
      for (const [ply, at] of summary.entries()) {
        const legal = board.moves();
        assert.equal(at.fen, board.fen());
        assert.equal(at.legal, legal.length);
        assert.equal(at.captures, legal.filter(san => san.includes("x")).length);
        assert.equal(at.over, board.isGameOver(), `ply ${ply}`);
        assert.equal(at.capture, !!history[ply]?.captured);
        if (ply < history.length) board.move(history[ply].san);
      }
      assert.equal(summary.length, history.length + 1);
    } finally { replay.free(); }
  }
  assert.deepEqual(wasm.parsePgns(["1. e4 missing e5", "1. e4 } e5"]), [null, null]);
  assert.deepEqual(wasm.san([{ fen: new Chess().fen(), move: "e2e9" }, { fen: "bad", move: "e2e4" }]), [null, null]);
  assert.equal(wasm.replay(undefined, ["Ne9"]), null);
  assert.equal(wasm.replay(undefined, [""]), null);
  assert.equal(wasm.replay(undefined, ["e4", ""]), null);
});

test("the tactic summary is identical with the WebAssembly motif detector", async () => {
  const { summarize } = await import("../src/browser/tactics");
  const fx = json("fixtures/tactics.json");
  const pgns = new Map<string, string>(fx.games.map((g: { url: string; pgn: string }) => [g.url, g.pgn]));
  const viaJs = summarize(fx.analyses, pgns);
  const viaWasm = summarize(fx.analyses, pgns, 16, wasm);
  assert.ok(viaJs.blunders.length > 40, `${viaJs.blunders.length} blunders`);
  assert.deepEqual(viaWasm, viaJs);
});

test("the WebAssembly motif detector matches TypeScript on all 3,000 puzzle positions", async () => {
  const { motifs } = await import("../src/browser/tactics");
  const fx = json("fixtures/tactics.json");
  const positions: { fen: string; from: string; to: string; promotion: string | null }[] = fx.positions;
  const found = wasm.motifs(positions.map(p => ({ fen: p.fen, move: `${p.from}${p.to}${p.promotion ?? ""}` })));
  for (const [i, p] of positions.entries()) {
    const js = motifs(p.fen, { from: p.from, to: p.to, promotion: p.promotion ?? undefined });
    assert.deepEqual([...(found[i] ?? [])].sort(), [...js].sort(), `${p.fen} ${p.from}${p.to}`);
  }
});

test("resolveBoardMove uses WasmChess for normal, capture, castling, en passant, and promotion", () => {
  assert.equal(resolveBoardMove("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", parseFenBoard("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR"), wasm)?.san, "e4");
  assert.equal(resolveBoardMove("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1", parseFenBoard("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R4RK1"), wasm)?.san, "O-O");
  assert.equal(resolveBoardMove("rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3", parseFenBoard("rnbqkbnr/ppp1pppp/3P4/8/8/8/PPPP1PPP/RNBQKBNR"), wasm)?.san, "exd6");
  assert.equal(resolveBoardMove("3rk3/4P3/8/8/8/8/8/4K3 w - - 0 1", parseFenBoard("3Qk3/8/8/8/8/8/8/4K3"), wasm)?.san, "exd8=Q+");
});
