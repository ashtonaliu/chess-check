// How often blitz players near a rating find the best move in a position where only one move works.
// A port of scripts/eval_find_rate.py's move model (checked against Python in test/findRate.test.ts).
// It describes the position: the clock is held at the training median.
import { Chess, type Move, type Square } from "chess.js";

import { FIND_RATE_MODEL as M } from "./findRateModel";
import { inRateRange } from "./rateRange";

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PIECE: Record<string, number> = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };

export interface MoveFeatures {
  piece: number; is_capture: number; captured_value: number; gives_check: number; is_promotion: number;
  is_castle: number; backward: number; sideways: number; was_attacked: number; lands_attacked: number;
  in_check: number; legal_moves: number; captures_available: number; checks_available: number;
  material_balance: number; non_pawn_material: number;
}

/** What kind of move `best` is (SAN or UCI), from the position alone. Null if it is not legal. */
export function moveFeatures(fen: string, best: string): MoveFeatures | null {
  let board: Chess;
  try { board = new Chess(fen); } catch { return null; }
  const me = board.turn(), opp = me === "w" ? "b" : "w";
  const legal = board.moves({ verbose: true });
  const move: Move | undefined = legal.find(m => m.san === best || m.lan === best || `${m.from}${m.to}${m.promotion ?? ""}` === best);
  if (!move) return null;
  let material = 0, nonPawn = 0;
  for (const row of board.board()) for (const sq of row) {
    if (!sq) continue;
    material += VALUE[sq.type] * (sq.color === me ? 1 : -1);
    if (sq.type !== "p" && sq.type !== "k") nonPawn += VALUE[sq.type];
  }
  const rank = (s: Square) => Number(s[1]);
  const forward = (rank(move.to) - rank(move.from)) * (me === "w" ? 1 : -1);
  const wasAttacked = board.isAttacked(move.from, opp);
  const inCheck = board.inCheck();
  const after = new Chess(fen);
  after.move(move.san);
  return {
    piece: PIECE[move.piece],
    is_capture: move.captured ? 1 : 0,
    captured_value: move.captured ? VALUE[move.captured] : 0,
    gives_check: /[+#]$/.test(move.san) ? 1 : 0,
    is_promotion: move.promotion ? 1 : 0,
    is_castle: move.flags.includes("k") || move.flags.includes("q") ? 1 : 0,
    backward: forward < 0 ? 1 : 0,
    sideways: forward === 0 ? 1 : 0,
    was_attacked: wasAttacked ? 1 : 0,
    lands_attacked: after.isAttacked(move.to, opp) ? 1 : 0,
    in_check: inCheck ? 1 : 0,
    legal_moves: legal.length,
    captures_available: legal.filter(m => m.captured).length,
    checks_available: legal.filter(m => /[+#]$/.test(m.san)).length,
    material_balance: material,
    non_pawn_material: nonPawn,
  };
}

/** The model's probability for these features at this rating (clock at the training median). */
export function findProbability(f: MoveFeatures, rating: number): number {
  const c = M.coef, r = (rating - 1500) / 400;
  const clock = M.clockRef;
  let z = M.intercept + c.rating * r + c.rating2 * r * r + c.clock * clock + c.low_clock * (clock < 0.1 ? 1 : 0)
    + c.is_capture * f.is_capture + c.gives_check * f.gives_check + c.is_promotion * f.is_promotion + c.is_castle * f.is_castle
    + c.backward * f.backward + c.sideways * f.sideways + c.was_attacked * f.was_attacked + c.lands_attacked * f.lands_attacked
    + c.in_check * f.in_check + c.captured_value * f.captured_value / 9 + c.log_legal * Math.log1p(f.legal_moves)
    + c.captures_available * Math.log1p(f.captures_available) + c.checks_available * Math.log1p(f.checks_available)
    + c.non_pawn * f.non_pawn_material / 62 + c.material * Math.min(Math.max(f.material_balance, -15), 15) / 15;
  z += (c as Record<string, number>)[`piece_${f.piece}`] ?? 0;
  return 1 / (1 + Math.exp(-z));
}

/** How often players near `rating` find `best` in `fen`, or null if the move cannot be read or the
 *  rating is outside the range the model covers (an estimate for 1200 would be wrong to show as
 *  one for players near 800). */
export function findRate(fen: string, best: string, rating: number): number | null {
  if (!inRateRange(rating)) return null;
  const f = moveFeatures(fen, best);
  return f ? findProbability(f, rating) : null;
}
