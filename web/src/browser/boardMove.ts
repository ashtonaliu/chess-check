// Offscreen board-move resolution (via WasmChess with chess.js fallback) and Stockfish score grading.
import { Chess } from "chess.js";
import {
  ALSO_WORKS_MAX_LOSS, boardToPlacement, candidateMovesFromDiff, formatBoardGrade,
  isBoardAnswerFound, isStoredBestMove, parseFenBoard,
  type BoardGradeResult, type BoardPieces, type BoardReading, type PieceCode,
} from "./boardPlacement";
import { winPct } from "./engine";
import type { WasmChess } from "./wasmChess";

export {
  ALSO_WORKS_MAX_LOSS, boardToPlacement, candidateMovesFromDiff, formatBoardGrade,
  isBoardAnswerFound, isStoredBestMove, parseFenBoard,
  type BoardGradeResult, type BoardPieces, type BoardReading, type PieceCode,
};

export interface ResolvedBoardMove {
  uci: string;
  san: string;
  afterFen: string;
  mate: boolean;
  over: boolean;
}

/** Resolve a rendered board state to the unique legal move from `startFen`, verifying that
 *  applying the move produces the exact target board placement. Uses WasmChess when available. */
export function resolveBoardMove(startFen: string, after: BoardPieces | string,
                                 wasm?: WasmChess | null): ResolvedBoardMove | null {
  const targetPlacement = typeof after === "string"
    ? after.trim().split(/\s+/)[0] ?? ""
    : boardToPlacement(after);
  const candidates = candidateMovesFromDiff(startFen, targetPlacement);
  if (!candidates.length) return null;

  for (const uci of candidates) {
    if (wasm) {
      const [san] = wasm.san([{ fen: startFen, move: uci }]);
      if (!san) continue;
      const [next] = wasm.advance([{ fen: startFen, move: san }]);
      if (!next) continue;
      if (next.fen.split(" ")[0] === targetPlacement) {
        return { uci, san, afterFen: next.fen, mate: next.mate, over: next.over };
      }
    } else {
      try {
        const chess = new Chess(startFen);
        const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        if (!move) continue;
        const afterFen = chess.fen();
        if (afterFen.split(" ")[0] === targetPlacement) {
          return { uci, san: move.san, afterFen, mate: chess.isCheckmate(), over: chess.isGameOver() };
        }
      } catch { /* illegal move */ }
    }
  }
  return null;
}

/** Grade a non-best move given Stockfish centipawn scores (mover's POV) before and after the move. */
export function gradeEvaluatedMove(playedSan: string, bestSan: string,
                                   cpBefore: number, cpAfter: number): BoardGradeResult {
  if (isStoredBestMove(playedSan, bestSan)) {
    return { kind: "correct", san: playedSan, best: bestSan };
  }
  const bestPct = winPct(cpBefore);
  const keptPct = winPct(cpAfter);
  const lossPct = Math.max(bestPct - keptPct, 0);
  if (lossPct <= ALSO_WORKS_MAX_LOSS) {
    return { kind: "also-works", san: playedSan, best: bestSan, keptPct, lossPct };
  }
  return { kind: "missed", san: playedSan, best: bestSan, keptPct, lossPct };
}
