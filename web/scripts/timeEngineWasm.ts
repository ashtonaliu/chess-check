import { Chess } from "chess.js";
import { moveFeatures } from "../src/browser/findRate";
import { WasmChess, type ChessBindings, type MoveAt } from "../src/browser/wasmChess";

const totals = (values: number[]) => values.reduce((a, b) => a + b, 0);
const sanLength = (moves: string[]) => totals(moves.map(move => move.length));

export function time(bindings: ChessBindings, positions: MoveAt[], pgns: string[], passes: number) {
  const wasm = new WasmChess(bindings);
  const fens = positions.map(input => input.fen);
  const histories = pgns.map(pgn => {
    const board = new Chess();
    board.loadPgn(pgn);
    return { fen: board.getHeaders().FEN, san: board.history() };
  });
  const census = (board: Chess) => {
    const san = board.moves();
    return san.length + san.filter(move => move.includes("x")).length + board.fen().length;
  };
  const operations = {
    countsAndFen: {
      units: positions.length,
      js: () => totals(fens.map(fen => census(new Chess(fen)))),
      wasm: () => totals(wasm.positions(fens).map(row => row!.legal + row!.captures + row!.fen.length)),
    },
    uciToSan: {
      units: positions.length,
      js: () => totals(positions.map(({ fen, move }) => new Chess(fen).move({
        from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4],
      }).san.length)),
      wasm: () => totals(wasm.san(positions).map(san => san!.length)),
    },
    pgn: {
      units: pgns.length,
      js: () => totals(pgns.map(pgn => {
        const board = new Chess();
        board.loadPgn(pgn);
        return sanLength(board.history());
      })),
      wasm: () => totals(wasm.parsePgns(pgns).map(game => sanLength(game!.moves))),
    },
    replay: {
      units: histories.length,
      js: () => totals(histories.map(({ fen, san }) => {
        const board = new Chess(fen);
        let sum = census(board);
        for (const move of san) {
          board.move(move);
          sum += census(board);
        }
        return sum;
      })),
      wasm: () => totals(histories.map(({ fen, san }) => {
        const replay = wasm.replay(fen, san)!;
        try { return totals(replay.plies().map(row => row.legal + row.captures + row.fen.length)); }
        finally { replay.free(); }
      })),
    },
    findRateFeatures: {
      units: positions.length,
      js: () => totals(positions.map(({ fen, move }) => totals(Object.values(moveFeatures(fen, move)!)))),
      wasm: () => totals(wasm.features(positions).map(row => totals(row!))),
    },
  };
  return Object.fromEntries(Object.entries(operations).map(([name, { js, wasm, units }]) => {
    const checksum = js();
    if (checksum !== wasm()) throw new Error(`${name}: WebAssembly and chess.js disagree`);
    const times = { js: [] as number[], wasm: [] as number[] };
    for (let i = 0; i < passes; i++) {
      for (const path of (i % 2 ? ["wasm", "js"] : ["js", "wasm"]) as ("js" | "wasm")[]) {
        const start = performance.now();
        const out = (path === "js" ? js : wasm)();
        times[path].push((performance.now() - start) * 1000 / units);
        if (out !== checksum) throw new Error(`${name}: result changed during timing`);
      }
    }
    return [name, { checksum, ...times }];
  }));
}
