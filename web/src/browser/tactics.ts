// Tactic and piece analysis of blunders: a port of wf/tactics.py. Board
// geometry (which squares a piece attacks) is computed here, mirroring
// python-chess, and parity is tested on Lichess puzzle positions.
import { Chess, type Move } from "chess.js";
import { BLUNDER_DROP, type GameAnalysis, type MoveRow } from "./engine";

type PT = "p" | "n" | "b" | "r" | "q" | "k";
type Col = "w" | "b";
interface P { t: PT; c: Col; }
type Board = (P | null)[];   // index = file + 8 * rank (a1 = 0), as in python-chess

export const MOTIFS = ["mate", "backRankMate", "fork", "pin", "skewer", "discoveredAttack", "hangingPiece", "promotion"] as const;
export const REPORTED = ["mate", "fork", "skewer", "discoveredAttack", "hangingPiece", "promotion"] as const;
export const MOTIF_LABEL: Record<string, string> = { mate: "checkmate", backRankMate: "back-rank mate", fork: "fork",
  pin: "pin", skewer: "skewer", discoveredAttack: "discovered attack", hangingPiece: "hanging piece", promotion: "pawn promotion" };
export const PUZZLE_URL: Record<string, string> = Object.fromEntries(MOTIFS.map(m => [m, `https://lichess.org/training/${m}`]));
const VALUE: Record<PT, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const NAME: Record<PT, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const MATE_CP = 2000;

const sqIndex = (s: string) => (s.charCodeAt(0) - 97) + 8 * (Number(s[1]) - 1);
const sqName = (i: number) => String.fromCharCode(97 + (i % 8)) + String(Math.floor(i / 8) + 1);

function toBoard(c: Chess): Board {
  const b: Board = new Array(64).fill(null);
  c.board().forEach((row, r) => row.forEach((p, f) => { if (p) b[f + 8 * (7 - r)] = { t: p.type as PT, c: p.color as Col }; }));
  return b;
}

const DIRS = { r: [[0, 1], [0, -1], [1, 0], [-1, 0]], b: [[1, 1], [1, -1], [-1, 1], [-1, -1]] };
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [...DIRS.r, ...DIRS.b];

/** Squares attacked by the piece on sq (python-chess Board.attacks). */
function attacks(b: Board, sq: number): number[] {
  const p = b[sq];
  if (!p) return [];
  const f0 = sq % 8, r0 = Math.floor(sq / 8), out: number[] = [];
  const step = (df: number, dr: number) => { const f = f0 + df, r = r0 + dr; if (f >= 0 && f < 8 && r >= 0 && r < 8) out.push(f + 8 * r); };
  const ray = (df: number, dr: number) => {
    let f = f0 + df, r = r0 + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) { const s = f + 8 * r; out.push(s); if (b[s]) break; f += df; r += dr; }
  };
  if (p.t === "p") { const d = p.c === "w" ? 1 : -1; step(-1, d); step(1, d); }
  else if (p.t === "n") KNIGHT.forEach(([df, dr]) => step(df, dr));
  else if (p.t === "k") KING.forEach(([df, dr]) => step(df, dr));
  else {
    if (p.t === "r" || p.t === "q") DIRS.r.forEach(([df, dr]) => ray(df, dr));
    if (p.t === "b" || p.t === "q") DIRS.b.forEach(([df, dr]) => ray(df, dr));
  }
  return out;
}

const attackers = (b: Board, color: Col, sq: number) =>
  b.map((p, s) => (p && p.c === color && attacks(b, s).includes(sq) ? s : -1)).filter(s => s >= 0);
const defended = (b: Board, sq: number, color: Col) => attackers(b, color, sq).length > 0;
const other = (c: Col): Col => (c === "w" ? "b" : "w");

function inBadSpot(b: Board, sq: number): boolean {
  const p = b[sq]!;
  const att = attackers(b, other(p.c), sq);
  if (!att.length) return false;
  if (!defended(b, sq, p.c)) return true;
  return att.some(a => VALUE[b[a]!.t] < VALUE[p.t]);
}

function valuableTargets(b: Board, sq: number, color: Col): number[] {
  const piece = b[sq]!;
  return attacks(b, sq).filter(s => {
    const t = b[s];
    if (!t || t.c === color || t.t === "p") return false;
    return t.t === "k" || VALUE[t.t] > VALUE[piece.t] || !defended(b, s, t.c);
  });
}

function lineMotifs(b: Board, sq: number, color: Col): Set<string> {
  const piece = b[sq];
  const found = new Set<string>();
  if (!piece || !"brq".includes(piece.t)) return found;
  const dirs = [...(piece.t !== "b" ? DIRS.r : []), ...(piece.t !== "r" ? DIRS.b : [])];
  const f0 = sq % 8, r0 = Math.floor(sq / 8);
  for (const [df, dr] of dirs) {
    const hits: [P, number][] = [];
    let f = f0 + df, r = r0 + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8 && hits.length < 2) {
      const s = f + 8 * r, p = b[s];
      if (p) { if (p.c === color) break; hits.push([p, s]); }
      f += df; r += dr;
    }
    if (hits.length === 2) {
      const [[front], [back, backSq]] = hits;
      if ((back.t === "k" || back.t === "q") && front.t !== "p" && VALUE[back.t] > VALUE[front.t]) found.add("pin");
      else if ((front.t === "k" || front.t === "q") && back.t !== "p" && VALUE[front.t] > VALUE[back.t]
        && (VALUE[back.t] > VALUE[piece.t] || !defended(b, backSq, back.c))) found.add("skewer");
    }
  }
  return found;
}

/** Tactic motifs of a move (python-chess Move semantics: from/to/promotion) in the position `fen`. */
export function motifs(fen: string, move: { from: string; to: string; promotion?: string }): Set<string> {
  const chess = new Chess(fen);
  const b = toBoard(chess);
  const color = chess.turn() as Col;
  const out = new Set<string>();
  const from = sqIndex(move.from), to = sqIndex(move.to);
  const mover = b[from];
  if (!mover) return out;
  let mv: Move;
  try { mv = chess.move({ from: move.from, to: move.to, promotion: move.promotion }); } catch { return out; }
  let captured = b[to];
  if (mv.flags.includes("e")) captured = { t: "p", c: other(color) };
  if (captured && captured.t !== "p" && !defended(b, to, other(color)) && VALUE[captured.t] >= 3) out.add("hangingPiece");
  if (move.promotion) out.add("promotion");
  const before = new Map<number, Set<number>>();
  b.forEach((p, s) => { if (p && p.c === color && "brq".includes(p.t) && s !== from) before.set(s, new Set(attacks(b, s))); });
  const a = toBoard(chess);
  if (chess.isCheckmate()) {
    out.add("mate");
    const king = a.findIndex(p => p?.t === "k" && p.c === other(color));
    const backRank = other(color) === "w" ? 0 : 7;
    const piece = a[to];
    if (king >= 0 && Math.floor(king / 8) === backRank && piece && (piece.t === "r" || piece.t === "q")
        && Math.floor(to / 8) === backRank) {
      const stepR = backRank === 0 ? 1 : -1, kf = king % 8;
      const front = [kf - 1, kf, kf + 1].filter(f => f >= 0 && f < 8).map(f => f + 8 * (backRank + stepR));
      if (front.filter(s => a[s] && a[s]!.c === other(color)).length >= 2) out.add("backRankMate");
    }
    return out;
  }
  const safe = !inBadSpot(a, to);
  if (mover.t !== "k" && safe && valuableTargets(a, to, color).length >= 2) out.add("fork");
  if (safe) lineMotifs(a, to, color).forEach(m => out.add(m));
  for (const [s, prev] of before) {
    const slider = a[s];
    if (!slider) continue;
    const hit = attacks(a, s).some(t => {
      if (prev.has(t)) return false;
      const p = a[t];
      return !!p && p.c !== color && p.t !== "p" && (p.t === "k" || VALUE[p.t] > VALUE[slider.t] || !defended(a, t, p.c));
    });
    if (hit) { out.add("discoveredAttack"); }
  }
  return out;
}

// ---------- per-blunder classification (wf/tactics.py classify_game) ----------

export interface DeepFields { deep_best?: string | null; deep_refutation?: string | null; deep_cp_before?: number; deep_cp_after?: number; deep_loss?: number; }
export interface BlunderRec {
  url: string; ply: number; move_no: number; san: string; is_me: boolean; phase: string; wp_loss: number;
  piece: string | null; allowed: string[]; missed: string[]; lost: string | null; refutation: string | null;
  best: string | null; fen: string; fork_by?: string; missed_fork_by?: string | null;
}

function sanMove(fen: string, san: string | null | undefined): Move | null {
  if (!san) return null;
  try { return new Chess(fen).move(san); } catch { return null; }
}
export type ClassifyMotifs = (moves: readonly Move[]) => readonly ReadonlySet<string>[];

const geometric = (found: ReadonlySet<string>) => {
  return REPORTED.filter(x => x !== "mate" && found.has(x)) as string[];
};

export function classifyGame(pgn: string, a: GameAnalysis, classify?: ClassifyMotifs): BlunderRec[] {
  const rows = a.moves as (MoveRow & DeepFields)[];
  if (!rows.some(row => row.wp_loss >= BLUNDER_DROP && (row.deep_loss ?? row.wp_loss) >= BLUNDER_DROP)) return [];
  const replay = new Chess();
  replay.loadPgn(pgn);
  const history = replay.history({ verbose: true });
  const out: BlunderRec[] = [];
  const candidates: Move[] = [];
  const apply: ((found: ReadonlySet<string>) => void)[] = [];
  const classifyLater = (move: Move, receive: (found: ReadonlySet<string>) => void) => {
    if (!classify) {
      receive(motifs(move.before, move));
      return;
    }
    candidates.push(move);
    apply.push(receive);
  };
  history.forEach((mv, i) => {
    const row = rows[i];
    if (!row) return;
    const loss = row.deep_loss ?? row.wp_loss;
    if (!(row.wp_loss >= BLUNDER_DROP && loss >= BLUNDER_DROP)) return;
    const fen = mv.before;
    const rec: BlunderRec = { url: a.url, ply: row.ply, move_no: row.move_no, san: row.san, is_me: row.is_me,
      phase: row.phase, wp_loss: loss, piece: NAME[mv.piece], allowed: [], missed: [],
      lost: null, refutation: null, best: row.best ?? null, fen };
    const best = sanMove(fen, row.deep_best !== undefined ? row.deep_best : row.best);
    rec.best = best ? best.san : null;
    if (best && !(best.from === mv.from && best.to === mv.to && (best.promotion ?? "") === (mv.promotion ?? ""))) {
      classifyLater(best, found => {
        rec.missed = geometric(found);
        if ((row.deep_cp_before ?? row.cp_before) >= MATE_CP) rec.missed.unshift("mate");
        if (rec.missed.includes("fork")) {
          rec.missed_fork_by = NAME[best.piece];
        }
      });
    }
    const afterFen = mv.after;
    const nxt = rows[i + 1];
    const refute = sanMove(afterFen, row.deep_refutation || (nxt ? nxt.best : null));
    if ((row.deep_cp_after ?? row.cp_after) <= -MATE_CP) rec.allowed.push("mate");
    if (refute) {
      rec.refutation = refute.san;
      classifyLater(refute, found => {
        rec.allowed.push(...geometric(found));
        const after = new Chess(afterFen);
        const cap = after.get(refute.to);
        if (cap && cap.color === mv.color) rec.lost = NAME[cap.type];
        if (rec.allowed.includes("fork")) rec.fork_by = NAME[refute.piece];
      });
    }
    out.push(rec);
  });
  if (classify && candidates.length) classify(candidates).forEach((found, i) => apply[i](found));
  return out;
}

// ---------- summary with verdicts (wf/tactics.py summarize) ----------

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9 after one refinement). */
export function normPpf(p: number): number {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const lo = 0.02425, hi = 1 - lo;
  let x: number;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p <= hi) { const q = p - 0.5, r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  else { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  // one Halley step against the erfc-based CDF
  const e = 0.5 * erfc(-x / Math.SQRT2) - p, u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}
function erfc(x: number): number {   // Numerical Recipes erfc, |error| < 1.2e-7
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

const Z90 = 1.645;
export function ratioInterval(a: number, nA: number, b: number, nB: number, z = Z90): [number, number, number] {
  if (nA === 0 || nB === 0 || a + b === 0) return [NaN, NaN, NaN];
  const t = a + b, p = a / t, denom = 1 + z * z / t;
  const centre = (p + z * z / (2 * t)) / denom;
  const half = z * Math.sqrt(p * (1 - p) / t + z * z / (4 * t * t)) / denom;
  const loP = Math.max(centre - half, 0), hiP = Math.min(centre + half, 1), expo = nB / nA;
  const toRatio = (q: number) => (q >= 1 ? Infinity : q / (1 - q) * expo);
  return [b ? (a / nA) / (b / nB) : Infinity, toRatio(loP), toRatio(hiP)];
}
export function verdict(a: number, nA: number, b: number, nB: number, zFamily: number): string {
  let [, lo, hi] = ratioInterval(a, nA, b, nB, zFamily);
  if (lo > 1 || hi < 1) return "pattern";
  [, lo, hi] = ratioInterval(a, nA, b, nB, Z90);
  if (lo > 1 || hi < 1) return "worth watching";
  return "no difference";
}

function pieceOf(san: string): PT {
  if (san.startsWith("O-O")) return "k";
  return ({ N: "n", B: "b", R: "r", Q: "q", K: "k" } as Record<string, PT>)[san[0]] ?? "p";
}

export interface MotifStat { kind: string; motif: string; me: number; opp: number; ratio: number; ci_low: number; ci_high: number; verdict: string; higher: boolean; }
export interface PieceStat { piece: string; moves: number; blunders: number; rate: number; opp_moves: number; opp_blunders: number; opp_rate: number; ratio: number; ci_low: number; ci_high: number; verdict: string; }
export interface TacticSummary {
  games: number; moves_me: number; moves_opp: number; motifs: MotifStat[]; pieces: PieceStat[];
  examples: Record<string, BlunderRec>; n_tests: number; flagged: number; confirmed: number; deep: boolean; deep_depth: number;
  forks_allowed_by: Record<string, number>; pieces_lost: Record<string, number>; blunders: BlunderRec[];
}

export function summarize(analyses: GameAnalysis[], pgns: Map<string, string>, deepDepth = 16, classify?: ClassifyMotifs): TacticSummary {
  const recs = analyses.flatMap(a => classifyGame(pgns.get(a.url)!, a, classify));
  const all = analyses.flatMap(a => a.moves);
  const movesMe = all.filter(m => m.is_me).length, movesOpp = all.filter(m => !m.is_me).length;
  const count = (sel: (m: MoveRow) => boolean) => {
    const c: Record<string, number> = {};
    for (const m of all) if (sel(m)) { const n = NAME[pieceOf(m.san)]; c[n] = (c[n] ?? 0) + 1; }
    return c;
  };
  const piecesMe = count(m => m.is_me), piecesOpp = count(m => !m.is_me);
  const out: TacticSummary = { games: analyses.length, moves_me: movesMe, moves_opp: movesOpp, motifs: [], pieces: [],
    examples: {}, n_tests: 0, flagged: 0, confirmed: 0, deep: false, deep_depth: deepDepth, forks_allowed_by: {},
    pieces_lost: {}, blunders: [] };
  for (const kind of ["allowed", "missed"] as const) {
    for (const m of REPORTED) {
      const a = recs.filter(r => r.is_me && r[kind].includes(m)).length;
      const b = recs.filter(r => !r.is_me && r[kind].includes(m)).length;
      if (a + b === 0) continue;
      const [ratio, lo, hi] = ratioInterval(a, movesMe, b, movesOpp);
      out.motifs.push({ kind, motif: m, me: a, opp: b, ratio, ci_low: lo, ci_high: hi, verdict: "", higher: false });
    }
  }
  for (const p of ["pawn", "knight", "bishop", "rook", "queen", "king"]) {
    const a = recs.filter(r => r.is_me && r.piece === p).length, b = recs.filter(r => !r.is_me && r.piece === p).length;
    const nA = piecesMe[p] ?? 0, nB = piecesOpp[p] ?? 0;
    if (!nA) continue;
    const [ratio, lo, hi] = nB ? ratioInterval(a, nA, b, nB) : [NaN, NaN, NaN];
    out.pieces.push({ piece: p, moves: nA, blunders: a, rate: a / nA, opp_moves: nB, opp_blunders: b,
      opp_rate: nB ? b / nB : NaN, ratio, ci_low: lo, ci_high: hi, verdict: "" });
  }
  const n = out.motifs.length + out.pieces.length;
  const zFam = normPpf(1 - 0.10 / (2 * Math.max(n, 1)));
  for (const m of out.motifs) { m.verdict = verdict(m.me, movesMe, m.opp, movesOpp, zFam); m.higher = m.ratio > 1; }
  for (const p of out.pieces) p.verdict = p.opp_moves ? verdict(p.blunders, p.moves, p.opp_blunders, p.opp_moves, zFam) : "no difference";
  out.n_tests = n;
  out.flagged = all.filter(m => m.wp_loss >= BLUNDER_DROP).length;
  out.confirmed = recs.length;
  out.deep = all.some(m => (m as MoveRow & DeepFields).deep_loss !== undefined);
  for (const r of recs) if (r.is_me && r.fork_by) out.forks_allowed_by[r.fork_by] = (out.forks_allowed_by[r.fork_by] ?? 0) + 1;
  for (const r of recs) if (r.is_me && r.lost) out.pieces_lost[r.lost] = (out.pieces_lost[r.lost] ?? 0) + 1;
  const mine = recs.filter(r => r.is_me);
  for (const r of mine.slice().sort((x, y) => y.wp_loss - x.wp_loss)) {   // stable, like Python's sorted
    for (const kind of ["allowed", "missed"] as const) for (const m of r[kind]) out.examples[`${kind}:${m}`] ??= r;
  }
  out.blunders = mine;
  return out;
}

export { sqName };
