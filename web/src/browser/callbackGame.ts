// A finished game straight from Chess.com's game endpoint (the one the game page loads), so a
// recap does not have to wait for the public archive, which can take a minute to list a game.
// The endpoint serves a live game only once it is over; until then it answers 404.
import { Chess } from "chess.js";
import type { Game } from "./games";
import { decodeTcn } from "./tcn";

export interface Callback {
  game: {
    id: number; isFinished?: boolean; moveList: string; moveTimestamps?: string; endTime?: number;
    pgnHeaders: Record<string, string | number>; ratingChangeWhite?: number; ratingChangeBlack?: number;
    colorOfWinner?: string | null; gameEndReason?: string;
  };
}

/** Chess.com's time classes from a time control like "180+2" (estimated length = base + 40 x increment). */
export function timeClassOf(tc: string): string {
  if (tc.includes("/")) return "daily";
  const [base, inc = "0"] = tc.split("+");
  const est = Number(base) + 40 * Number(inc);
  return est < 180 ? "bullet" : est < 600 ? "blitz" : "rapid";
}

const clock = (tenths: number) => {
  const s = tenths / 10, h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${sec < 10 ? "0" : ""}${Number.isInteger(sec) ? sec : sec.toFixed(1)}`;
};

/** The endpoint gives only an ECO code, and not always the archive's (one game was A84 here and
 *  A40 in the archive), so the opening name comes from the past game that shares the longest run
 *  of opening moves with this one, if it shares at least the first four. */
const MIN_SHARED = 4;
function openingFrom(eco: string, moves: string[], history: Game[]): [string, string] {
  let best: Game | null = null, bestLen = MIN_SHARED - 1;
  for (const g of history) {
    let n = 0;
    while (n < moves.length && n < g.moves.length && moves[n] === g.moves[n]) n++;
    if (n > bestLen || (n === bestLen && best && g.endTime > best.endTime)) { best = g; bestLen = n; }
  }
  return best ? [best.opening, best.family] : [`ECO ${eco}`, `ECO ${eco}`];
}

/** Name the opening once the archive is ready, without decoding the finished game again. */
export function nameCallbackOpening(game: Game, history: Game[]): Game {
  const [opening, family] = openingFrom(game.eco, game.moves, history);
  return opening === game.opening && family === game.family ? game : { ...game, opening, family };
}

// Chess.com sends SetUp "1" and this FEN even for standard games, so only the first four fields
// (placement, side to move, castling, en passant) are compared, never the move counters.
const START_POSITION = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";

/** True for standard chess from the usual starting position (not Chess960, odds or a set-up board). */
export function isStandardCallback(cb: Callback): boolean {
  const h = cb.game.pgnHeaders;
  const variant = String(h.Variant ?? "").trim().toLowerCase();
  if (variant && variant !== "standard") return false;
  return h.FEN === undefined || String(h.FEN).trim().split(/\s+/).slice(0, 4).join(" ") === START_POSITION;
}

/** The game as `user` saw it, or null if it is not finished, not standard chess, or `user` did not
 *  play in it. Ratings are the ones going into the game (the endpoint's ratings already include the
 *  game's change). */
export function gameFromCallback(cb: Callback, user: string, kind: "live" | "daily", history: Game[]): Game | null {
  const g = cb.game, h = g.pgnHeaders;
  if (!g.isFinished || !isStandardCallback(cb)) return null;
  const white = String(h.White), black = String(h.Black), u = user.toLowerCase();
  const color = white.toLowerCase() === u ? "white" : black.toLowerCase() === u ? "black" : null;
  if (!color) return null;
  const replay = new Chess();
  const stamps = (g.moveTimestamps ?? "").split(",").filter(Boolean).map(Number);
  decodeTcn(g.moveList).forEach((m, i) => {
    replay.move(m);
    if (i < stamps.length && Number.isFinite(stamps[i])) replay.setComment(`[%clk ${clock(stamps[i])}]`);
  });
  const result = String(h.Result ?? "*");
  replay.setHeader("White", white); replay.setHeader("Black", black); replay.setHeader("Result", result);
  if (h.ECO) replay.setHeader("ECO", String(h.ECO));
  if (h.TimeControl) replay.setHeader("TimeControl", String(h.TimeControl));
  const pre = (elo: unknown, change: unknown) => Number(elo) - (Number(change) || 0);
  const whitePre = pre(h.WhiteElo, g.ratingChangeWhite), blackPre = pre(h.BlackElo, g.ratingChangeBlack);
  const reason = g.gameEndReason ?? "";
  const winner = g.colorOfWinner ?? null;
  const myResult = winner === null ? reason : winner === color ? "win" : reason;
  const oppResult = winner === null ? reason : winner === color ? reason : "win";
  const moves = replay.history();
  const eco = String(h.ECO ?? "?");
  const [opening, family] = openingFrom(eco, moves, history);
  const tc = String(h.TimeControl ?? "");
  return {
    site: "chesscom", url: `https://www.chess.com/game/${kind}/${g.id}`, color, ratingSource: "pregame",
    myRating: color === "white" ? whitePre : blackPre, oppRating: color === "white" ? blackPre : whitePre,
    score: winner === null ? 0.5 : winner === color ? 1 : 0,
    timeClass: timeClassOf(tc), timeControl: tc, eco, opening, family, endTime: g.endTime ?? 0,
    opponent: color === "white" ? black : white, result: myResult, oppResult, moves, pgn: replay.pgn(),
  };
}
