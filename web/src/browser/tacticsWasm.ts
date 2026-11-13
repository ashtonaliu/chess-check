import { Chess } from "chess.js";
import { MOTIFS, motifs, type ClassifyMotifs } from "./tactics";

declare const CHESS_CHECK_RUST_TACTICS: number;

const BOARD_SIZE = 64;
const RECORD_SIZE = 2 * BOARD_SIZE + 3;

interface TacticsExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  reserve_records: (count: number) => number;
  classify_records: () => void;
}

function writeBoard(chess: Chess, output: Uint8Array, offset: number) {
  for (const [rank, row] of chess.board().entries()) {
    for (const [file, piece] of row.entries()) {
      const symbol = piece?.color === "w" ? piece.type.toUpperCase() : piece?.type;
      output[offset + (7 - rank) * 8 + file] = symbol ? symbol.charCodeAt(0) : 0;
    }
  }
}

const squareIndex = (square: string) => square.charCodeAt(0) - 97 + 8 * (Number(square[1]) - 1);

export async function createWasmClassifier(bytes: ArrayBuffer): Promise<ClassifyMotifs> {
  const { instance } = await WebAssembly.instantiate(bytes);
  const wasm = instance.exports as TacticsExports;
  return moves => {
    try {
      const pointer = wasm.reserve_records(moves.length);
      const records = new Uint8Array(wasm.memory.buffer, pointer, moves.length * RECORD_SIZE);
      for (const [i, move] of moves.entries()) {
        const start = i * RECORD_SIZE;
        const chess = new Chess(move.before);
        writeBoard(chess, records, start);
        chess.move({ from: move.from, to: move.to, promotion: move.promotion });
        writeBoard(chess, records, start + BOARD_SIZE);
        records.set([squareIndex(move.from), squareIndex(move.to), Number(chess.isCheckmate())],
          start + 2 * BOARD_SIZE);
      }
      wasm.classify_records();
      return Array.from(records.subarray(0, moves.length), mask =>
        new Set(MOTIFS.filter((_, bit) => mask & (1 << bit))));
    } catch {
      return moves.map(move => motifs(move.before, move));
    }
  };
}

const classifiers = new Map<string, Promise<ClassifyMotifs | undefined>>();

export function loadWasmClassifier(engineUrl: string): Promise<ClassifyMotifs | undefined> {
  if (typeof CHESS_CHECK_RUST_TACTICS === "undefined" || CHESS_CHECK_RUST_TACTICS !== 1) {
    return Promise.resolve(undefined);
  }
  const url = new URL("chess_check_tactics.wasm", engineUrl).href;
  let classifier = classifiers.get(url);
  if (!classifier) {
    classifier = fetch(url).then(async response =>
      response.ok ? createWasmClassifier(await response.arrayBuffer()) : undefined
    ).catch(() => undefined);
    classifiers.set(url, classifier);
  }
  return classifier;
}
