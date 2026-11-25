// Fetch-free Lichess game and NDJSON parsing (docs/lichess-plan.md Part 3).
import { Chess } from "chess.js";
import { openingNames, type Game } from "./games";

const LICHESS_HOST = "https://lichess.org";
const SKIPPED_STATUSES = new Set(["created", "started", "aborted", "noStart"]);
const FINISHED_STATUSES = new Set([
  "mate",
  "resign",
  "stalemate",
  "timeout",
  "draw",
  "outoftime",
  "cheat",
  "unknownFinish",
  "insufficientMaterialClaim",
  "variantEnd",
]);

export interface LichessPlayer {
  user?: { id?: string; name?: string };
  rating?: number;
  ratingDiff?: number;
}

export interface LichessExport {
  id: string;
  rated?: boolean;
  variant?: string;
  speed?: string;
  perf?: string;
  createdAt?: number;
  lastMoveAt?: number;
  status?: string;
  winner?: "white" | "black";
  initialFen?: string;
  moves?: string;
  clocks?: number[];
  daysPerTurn?: number;
  clock?: { initial?: number; increment?: number };
  opening?: { eco?: string; name?: string; ply?: number };
  players?: { white?: LichessPlayer; black?: LichessPlayer };
}

function formatCentiseconds(cs: number): string {
  const s = Math.max(0, cs) / 100;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secStr = Number.isInteger(sec) ? String(sec) : sec.toFixed(2).replace(/\.?0+$/, "");
  return `${h}:${String(m).padStart(2, "0")}:${sec < 10 ? "0" : ""}${secStr}`;
}

function mapSpeed(speed: string | undefined): string {
  if (!speed) return "";
  return speed === "correspondence" ? "daily" : speed;
}

function mapTimeControl(g: LichessExport): string {
  if (g.clock && typeof g.clock.initial === "number" && typeof g.clock.increment === "number") {
    return `${g.clock.initial}+${g.clock.increment}`;
  }
  if (typeof g.daysPerTurn === "number" && g.daysPerTurn > 0) {
    return `1/${g.daysPerTurn * 86400}`;
  }
  return "";
}

function mapResult(
  status: string,
  winner: "white" | "black" | undefined,
  color: "white" | "black",
): { score: number; myResult: string; oppResult: string; pgnResult: string } {
  if (winner === "white" || winner === "black") {
    const loserReason =
      status === "mate" ? "checkmated"
      : status === "resign" ? "resigned"
      : status === "timeout" || status === "outoftime" ? "timeout"
      : status;
    const pgnResult = winner === "white" ? "1-0" : "0-1";
    return winner === color
      ? { score: 1, myResult: "win", oppResult: loserReason, pgnResult }
      : { score: 0, myResult: loserReason, oppResult: "win", pgnResult };
  }
  const drawCode =
    status === "stalemate" ? "stalemate"
    : status === "insufficientMaterialClaim" ? "insufficient"
    : status === "timeout" || status === "outoftime" ? "timevsinsufficient"
    : "agreed";
  return { score: 0.5, myResult: drawCode, oppResult: drawCode, pgnResult: "1/2-1/2" };
}

function playerName(p: LichessPlayer | undefined): string {
  return p?.user?.name ?? p?.user?.id ?? "Anonymous";
}

function matchesUser(p: LichessPlayer | undefined, userLower: string): boolean {
  const id = p?.user?.id?.toLowerCase();
  const name = p?.user?.name?.toLowerCase();
  return id === userLower || name === userLower;
}

function openingFamily(name: string): string {
  if (!name || name === "Unknown") return "Unknown";
  const slug = name.replace(/[:,'"]/g, "").trim().replace(/\s+/g, "-");
  return openingNames(slug)[1];
}

/**
 * Map one Lichess /game/export/{id} JSON object to a Game from `user`'s perspective,
 * or null if it is not standard chess, has a custom initialFen, is in progress or aborted,
 * or `user` did not play in it.
 */
export function parseLichessGame(raw: unknown, user: string): Game | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as LichessExport;
  if (typeof g.id !== "string" || !g.id) return null;
  if (g.variant && g.variant.toLowerCase() !== "standard") return null;
  if (g.initialFen) return null;
  if (!g.status || SKIPPED_STATUSES.has(g.status) || !FINISHED_STATUSES.has(g.status)) return null;

  const white = g.players?.white;
  const black = g.players?.black;
  const u = user.toLowerCase();
  let color: "white" | "black";
  let me: LichessPlayer | undefined;
  let opp: LichessPlayer | undefined;
  if (matchesUser(white, u)) {
    color = "white";
    me = white;
    opp = black;
  } else if (matchesUser(black, u)) {
    color = "black";
    me = black;
    opp = white;
  } else {
    return null;
  }

  const replay = new Chess();
  const rawMoves = typeof g.moves === "string" ? g.moves.trim().split(/\s+/).filter(Boolean) : [];
  const clocks = Array.isArray(g.clocks) ? g.clocks : [];
  for (let i = 0; i < rawMoves.length; i++) {
    try {
      replay.move(rawMoves[i]);
    } catch {
      return null;
    }
    if (i < clocks.length && Number.isFinite(clocks[i])) {
      replay.setComment(`[%clk ${formatCentiseconds(clocks[i])}]`);
    }
  }

  const { score, myResult, oppResult, pgnResult } = mapResult(g.status, g.winner, color);
  const tc = mapTimeControl(g);
  const eco = g.opening?.eco ?? "?";
  const opening = g.opening?.name ?? "Unknown";
  const family = openingFamily(opening);

  const url = `${LICHESS_HOST}/game/${g.id}`;
  replay.setHeader("Site", url);
  replay.setHeader("White", playerName(white));
  replay.setHeader("Black", playerName(black));
  replay.setHeader("Result", pgnResult);
  if (typeof white?.rating === "number") replay.setHeader("WhiteElo", String(white.rating));
  if (typeof black?.rating === "number") replay.setHeader("BlackElo", String(black.rating));
  if (eco !== "?") replay.setHeader("ECO", eco);
  if (opening !== "Unknown") replay.setHeader("Opening", opening);
  if (tc) replay.setHeader("TimeControl", tc);

  const endMs = g.lastMoveAt ?? g.createdAt ?? 0;
  return {
    site: "lichess",
    url,
    ratingSource: "pregame",
    color,
    myRating: typeof me?.rating === "number" ? me.rating : 0,
    oppRating: typeof opp?.rating === "number" ? opp.rating : 0,
    score,
    timeClass: mapSpeed(g.speed),
    timeControl: tc,
    eco,
    opening,
    family,
    endTime: Math.floor(endMs / 1000),
    opponent: playerName(opp),
    result: myResult,
    oppResult,
    moves: replay.history(),
    pgn: replay.pgn(),
  };
}

/**
 * Parse a Lichess NDJSON stream (one JSON game per line), skipping malformed lines
 * and filtered-out games without throwing.
 */
export function parseLichessNdjson(text: string, user: string): { games: Game[]; skipped: number } {
  const games: Game[] = [];
  let skipped = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = parseLichessGame(JSON.parse(line), user);
      if (parsed) games.push(parsed);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { games, skipped };
}
