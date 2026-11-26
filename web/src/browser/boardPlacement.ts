// Lightweight board placement, diffing, and grading display helpers with zero chess.js dependency,
// so the extension's content script can read boards and format results without bundling chess.js.

export type PieceCode =
  | "wP" | "wN" | "wB" | "wR" | "wQ" | "wK"
  | "bP" | "bN" | "bB" | "bR" | "bQ" | "bK";

export type BoardPieces = Record<string, PieceCode>;

export interface BoardReading {
  element: Element;
  pieces: BoardPieces;
  placement: string;
}

export type BoardGradeResult =
  | { kind: "not-a-move" }
  // the move played in the game, which is also what stepping forward through the game shows
  | { kind: "game-move"; san: string }
  | { kind: "correct"; san: string; best: string }
  | { kind: "also-works"; san: string; best: string; keptPct: number; lossPct: number }
  | { kind: "missed"; san: string; best: string; keptPct: number; lossPct: number };

/** An alternative move within this many win-percentage points of the best move counts as found. */
export const ALSO_WORKS_MAX_LOSS = 5;

const FILES = "abcdefgh";
const FEN_TO_CODE: Record<string, PieceCode> = {
  P: "wP", N: "wN", B: "wB", R: "wR", Q: "wQ", K: "wK",
  p: "bP", n: "bN", b: "bB", r: "bR", q: "bQ", k: "bK",
};
const CODE_TO_FEN: Record<PieceCode, string> = {
  wP: "P", wN: "N", wB: "B", wR: "R", wQ: "Q", wK: "K",
  bP: "p", bN: "n", bB: "b", bR: "r", bQ: "q", bK: "k",
};

/** Parse the board-placement field of a FEN (or a bare placement string) into a square-to-piece map. */
export function parseFenBoard(fen: string): BoardPieces {
  const placement = fen.trim().split(/\s+/)[0] ?? "";
  const ranks = placement.split("/");
  const pieces: BoardPieces = {};
  if (ranks.length !== 8) return pieces;
  for (let r = 0; r < 8; r++) {
    let file = 0;
    const rankNum = 8 - r;
    for (const ch of ranks[r]) {
      if (ch >= "1" && ch <= "8") {
        file += Number(ch);
      } else {
        const code = FEN_TO_CODE[ch];
        if (code && file < 8) pieces[`${FILES[file]}${rankNum}`] = code;
        file++;
      }
    }
  }
  return pieces;
}

/** Serialize a square-to-piece map into a canonical FEN piece-placement string. */
export function boardToPlacement(pieces: BoardPieces): string {
  const rows: string[] = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = "";
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const code = pieces[`${FILES[f]}${rank}`];
      if (!code) {
        empty++;
      } else {
        if (empty) { row += String(empty); empty = 0; }
        row += CODE_TO_FEN[code];
      }
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  return rows.join("/");
}

/** Extract candidate UCI move(s) that could turn `startFen` into `after` in one move. */
export function candidateMovesFromDiff(startFen: string, after: BoardPieces | string): string[] {
  const parts = startFen.trim().split(/\s+/);
  const turn = parts[1] === "b" ? "b" : "w";
  const before = parseFenBoard(startFen);
  const next = typeof after === "string" ? parseFenBoard(after) : after;
  if (boardToPlacement(before) === boardToPlacement(next)) return [];

  const vacated: string[] = [];
  const gained: string[] = [];
  const squares = new Set([...Object.keys(before), ...Object.keys(next)]);
  for (const sq of squares) {
    const b = before[sq];
    const a = next[sq];
    if (b === a) continue;
    if (b?.[0] === turn) vacated.push(sq);
    if (a?.[0] === turn) gained.push(sq);
  }

  // Normal move, capture, en passant, or promotion: 1 mover square vacated, 1 mover square gained.
  if (vacated.length === 1 && gained.length === 1) {
    const from = vacated[0];
    const to = gained[0];
    const moved = before[from];
    const landed = next[to];
    if (moved[1] === "P" && landed[1] !== "P") {
      const promo = landed[1].toLowerCase();
      if (promo === "q" || promo === "r" || promo === "b" || promo === "n") {
        return [`${from}${to}${promo}`];
      }
      return [];
    }
    return [`${from}${to}`];
  }

  // Castling: king and rook both vacate and land on new squares.
  if (vacated.length === 2 && gained.length === 2) {
    const kingFrom = vacated.find(sq => before[sq] === `${turn}K`);
    const kingTo = gained.find(sq => next[sq] === `${turn}K`);
    if (kingFrom && kingTo) return [`${kingFrom}${kingTo}`];
  }

  return [];
}

const cleanSan = (san: string) => san.trim().replace(/[+#!?]+$/g, "");

export const isStoredBestMove = (playedSan: string, bestSan: string): boolean =>
  cleanSan(playedSan) === cleanSan(bestSan);

export const isBoardAnswerFound = (result: BoardGradeResult): boolean =>
  result.kind === "correct" || result.kind === "also-works";

/** Panel message for a graded board answer. */
export function formatBoardGrade(result: Exclude<BoardGradeResult, { kind: "not-a-move" | "game-move" }>): string {
  if (result.kind === "correct") return "Correct";
  if (result.kind === "also-works") return `Also works: ${result.san} keeps ${Math.round(result.keptPct)}%`;
  return `${result.san} loses ${Math.round(result.lossPct)}%. Better was ${result.best}.`;
}
