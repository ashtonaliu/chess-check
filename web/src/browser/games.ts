// Fetch and parse Chess.com games in the browser. Mirrors wf/fetch.py.
// The Chess.com public API sends Access-Control-Allow-Origin: *, so no
// server is needed.
import { Chess } from "chess.js";

export interface Game {
  url: string;
  color: "white" | "black";
  myRating: number;
  oppRating: number;
  score: number;          // 1 / 0.5 / 0 for the user
  timeClass: string;
  timeControl: string;
  eco: string;
  opening: string;
  family: string;
  endTime: number;
  opponent?: string;      // the opponent's username
  result: string;         // Chess.com result code for the user, e.g. "timeout"
  oppResult: string;      // ...and for the opponent
  moves: string[];        // SAN
  pgn: string;
}

const DRAWS = new Set(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]);
const FAMILY_ENDINGS = new Set(["Defense", "Opening", "Game", "Gambit", "Attack", "System"]);

// Same table as wf/fetch.py CANONICAL.
const CANONICAL: [string, string][] = [
  ["Nimzo Indian", "Nimzo-Indian Defense"], ["Bogo Indian", "Bogo-Indian Defense"],
  ["Queens Indian", "Queen's Indian Defense"], ["Kings Indian Attack", "King's Indian Attack"],
  ["Kings Indian", "King's Indian Defense"], ["Sicilian", "Sicilian Defense"],
  ["French", "French Defense"], ["Caro Kann", "Caro-Kann Defense"],
  ["Semi Slav", "Semi-Slav Defense"], ["Slav", "Slav Defense"],
  ["Queens Gambit", "Queen's Gambit"], ["Kings Gambit", "King's Gambit"],
  ["Queens Pawn", "Queen's Pawn Opening"], ["Kings Pawn", "King's Pawn Opening"],
  ["English", "English Opening"], ["Reti", "Reti Opening"],
  ["Ruy Lopez", "Ruy Lopez"], ["Italian", "Italian Game"], ["Giuoco", "Italian Game"],
  ["Two Knights", "Italian Game"], ["Scotch", "Scotch Game"], ["Vienna", "Vienna Game"],
  ["Four Knights", "Four Knights Game"], ["Petrov", "Petrov's Defense"], ["Petrovs", "Petrov's Defense"],
  ["Philidor", "Philidor Defense"], ["Pirc", "Pirc Defense"], ["Modern", "Modern Defense"],
  ["Scandinavian", "Scandinavian Defense"], ["Alekhine", "Alekhine's Defense"], ["Alekhines", "Alekhine's Defense"],
  ["London", "London System"], ["Colle", "Colle System"], ["Catalan", "Catalan Opening"],
  ["Grunfeld", "Grunfeld Defense"], ["Dutch", "Dutch Defense"], ["Benoni", "Benoni Defense"],
  ["Benko", "Benko Gambit"], ["Nimzowitsch Larsen", "Nimzowitsch-Larsen Attack"],
  ["Bishops Opening", "Bishop's Opening"], ["Center Game", "Center Game"],
  ["Owens", "Owen's Defense"], ["Indian", "Indian Game"],
];

export function openingNames(ecoUrl: string): [string, string] {
  const slug = ecoUrl ? ecoUrl.replace(/\/+$/, "").split("/").pop() ?? "" : "";
  const tokens: string[] = [];
  for (const tok of slug.split("-").filter(Boolean)) {
    if (/\d/.test(tok)) break;   // a move sequence like 2...d6 starts here
    tokens.push(tok);
  }
  if (!tokens.length) return ["Unknown", "Unknown"];
  const full = tokens.join(" ");
  // The family named first wins; on a tie, the longer (more specific) name.
  let best: [number, number, string] | null = null;
  for (const [key, canon] of CANONICAL) {
    const at = ` ${full} `.indexOf(` ${key} `);
    if (at < 0) continue;
    const cand: [number, number, string] = [at, -key.length, canon];
    if (!best || cand[0] < best[0] || (cand[0] === best[0] && (cand[1] < best[1] || (cand[1] === best[1] && cand[2] < best[2])))) best = cand;
  }
  if (best) return [full, best[2]];
  for (let i = 0; i < Math.min(tokens.length, 5); i++) {
    if (FAMILY_ENDINGS.has(tokens[i])) return [full, tokens.slice(0, i + 1).join(" ")];
  }
  return [full, tokens.slice(0, 2).join(" ")];
}

const scoreOf = (result: string) => (result === "win" ? 1 : DRAWS.has(result) ? 0.5 : 0);

interface RawSide { username: string; rating: number; result: string; }
interface RawGame {
  url: string; pgn?: string; rules?: string; time_class?: string; time_control?: string;
  end_time?: number; eco?: string; white: RawSide; black: RawSide;
}

export function parseGame(raw: RawGame, user: string): Game | null {
  if (raw.rules !== "chess" || !raw.pgn) return null;
  const u = user.toLowerCase();
  let color: "white" | "black", me: RawSide, opp: RawSide;
  if (raw.white.username.toLowerCase() === u) { color = "white"; me = raw.white; opp = raw.black; }
  else if (raw.black.username.toLowerCase() === u) { color = "black"; me = raw.black; opp = raw.white; }
  else return null;
  const chess = new Chess();
  try { chess.loadPgn(raw.pgn); } catch { return null; }
  const headers = chess.getHeaders();
  const [opening, family] = openingNames(raw.eco || headers["ECOUrl"] || "");
  return {
    url: raw.url, color, myRating: me.rating, oppRating: opp.rating, score: scoreOf(me.result),
    timeClass: raw.time_class ?? "", timeControl: raw.time_control ?? "", eco: headers["ECO"] ?? "?",
    opening, family, endTime: raw.end_time ?? 0, result: me.result ?? "", oppResult: opp.result ?? "", opponent: opp.username,
    moves: chess.history(), pgn: raw.pgn,
  };
}

const API = "https://api.chess.com/pub/player";

type ArchiveResponse = { status: number; ok: boolean; data?: { archives?: string[]; games?: RawGame[] } };
interface ArchiveRequest {
  controller: AbortController;
  pending: Promise<ArchiveResponse>;
  readers: number;
}
const inFlight = new Map<string, ArchiveRequest>();

const TIMEOUT_MS = 20_000, TRIES = 3;

/** One archive request that cannot hang: each try times out after 20 s, and a timeout, network
 *  error, rate limit (429) or server error is retried twice with a short wait. */
async function getWithRetry(url: string, signal: AbortSignal): Promise<ArchiveResponse> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
      if ((r.status === 429 || r.status >= 500) && attempt < TRIES) { await new Promise(res => setTimeout(res, 1000 * attempt)); continue; }
      return { status: r.status, ok: r.ok, data: r.ok ? await r.json() : undefined };
    } catch (e) {
      if (signal.aborted) throw e;
      if (attempt >= TRIES) throw new Error("Chess.com did not answer in time. Try again in a minute.");
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }
}

async function fetchArchive(url: string, signal?: AbortSignal): Promise<ArchiveResponse> {
  signal?.throwIfAborted();
  let request = inFlight.get(url);
  if (!request) {
    const controller = new AbortController();
    const pending: Promise<ArchiveResponse> = getWithRetry(url, controller.signal).finally(() => {
      if (inFlight.get(url)?.controller === controller) inFlight.delete(url);
    });
    request = { controller, pending, readers: 0 };
    inFlight.set(url, request);
  }
  const shared = request;
  shared.readers++;
  let abort: (() => void) | undefined;
  try {
    if (!signal) return await shared.pending;
    return await new Promise<ArchiveResponse>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      shared.pending.then(resolve, reject);
    });
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    if (--shared.readers === 0 && inFlight.get(url) === shared) {
      inFlight.delete(url);
      shared.controller.abort();
    }
  }
}

export async function fetchGames(user: string, maxGames: number, timeClass: string | null,
                                 signal?: AbortSignal): Promise<Game[]> {
  const r = await fetchArchive(`${API}/${encodeURIComponent(user.toLowerCase())}/games/archives`, signal);
  if (r.status === 404) throw new Error(`No Chess.com player named "${user}".`);
  if (!r.ok) throw new Error(`Chess.com API error ${r.status}.`);
  const archives: string[] = r.data?.archives ?? [];
  const games: Game[] = [];
  for (const month of archives.slice().reverse()) {
    const m = await fetchArchive(month, signal);
    if (!m.ok) throw new Error(`Chess.com API error ${m.status}.`);
    const raw: RawGame[] = [...(m.data?.games ?? [])];
    raw.sort((a, b) => (b.end_time ?? 0) - (a.end_time ?? 0));
    for (const rg of raw) {
      if (timeClass && rg.time_class !== timeClass) continue;
      const g = parseGame(rg, user);
      if (g) {
        games.push(g);
        if (games.length >= maxGames) return games;
      }
    }
  }
  return games;
}

/** A finished game by its Chess.com ID, if it is in the player's last few monthly archives (finished games only). */
export async function findGame(user: string, gameId: string, months = 3, signal?: AbortSignal): Promise<Game | null> {
  const r = await fetchArchive(`${API}/${encodeURIComponent(user.toLowerCase())}/games/archives`, signal);
  if (r.status === 404) throw new Error(`No Chess.com player named "${user}".`);
  if (!r.ok) throw new Error(`Chess.com API error ${r.status}.`);
  const archives: string[] = r.data?.archives ?? [];
  for (const month of archives.slice(-months).reverse()) {
    const m = await fetchArchive(month, signal);
    if (!m.ok) throw new Error(`Chess.com API error ${m.status}.`);
    const rg = (m.data?.games ?? []).find(g => g.url.match(/\/(\d+)$/)?.[1] === gameId);
    if (rg) return parseGame(rg, user);
  }
  return null;
}
