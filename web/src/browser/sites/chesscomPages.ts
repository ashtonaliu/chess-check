import { boardToPlacement, type BoardPieces, type BoardReading, type PieceCode } from "../boardPlacement";
import type { FinishedPage, SitePages } from "../site";
import type { Callback } from "../callbackGame";

const LOCALE = String.raw`(?:\/[a-z]{2}(?:-[a-z]{2,4})?)?`;
const GAME_PATH = new RegExp(String.raw`^${LOCALE}\/(?:analysis\/)?(?:(?:live|daily)\/)?game\/(?:(?:live|daily)\/)?(\d+)(?:\/|$)`, "i");
const PLAY_PATH = new RegExp(String.raw`^${LOCALE}\/(?:play(?:\/|$)|live\/?$)`, "i");
const FILES = "abcdefgh";

const gameIdFromPage = (url: URL) => url.pathname.match(GAME_PATH)?.[1] ?? null;
const isPlayPage = (url: URL) => PLAY_PATH.test(url.pathname);
const kindOf = (url: URL) => /\/daily\//.test(url.pathname) ? "daily" : "live";

export const gameIdFromApiUrl = (url: string) => url.match(/\/(\d+)$/)?.[1] ?? null;
export const LIVE_POLL_MS = 5_000;
export const DAILY_POLL_MS = 60_000;

/** Read piece positions from Chess.com's board DOM (`wc-chess-board`, `chess-board`, or `.board`).
 *  Piece elements carry classes like `"wq square-26"` (file 2 = b, rank 6). Returns null while
 *  a piece is mid-drag or if the board is missing/inconsistent. */
export function readChesscomBoard(doc: Document): BoardReading | null {
  const board = doc.querySelector("wc-chess-board, chess-board, .board");
  if (!board) return null;
  const nodes = board.querySelectorAll(".piece");
  if (!nodes.length) return null;
  const pieces: BoardPieces = {};
  for (const el of Array.from(nodes)) {
    const classes = (el.getAttribute("class") ?? "").split(/\s+/);
    if (classes.includes("dragging")) return null;
    let code: PieceCode | null = null;
    let square: string | null = null;
    for (const cls of classes) {
      const pm = cls.match(/^([wb])([pnbrqk])$/);
      if (pm) code = `${pm[1]}${pm[2].toUpperCase()}` as PieceCode;
      const sm = cls.match(/^square-([1-8])([1-8])$/);
      if (sm) square = `${FILES[Number(sm[1]) - 1]}${sm[2]}`;
    }
    if (!code || !square) continue;
    if (pieces[square]) return null;
    pieces[square] = code;
  }
  if (!Object.keys(pieces).length) return null;
  return { element: board, pieces, placement: boardToPlacement(pieces) };
}

type Dev = { __ccCallback?: (id: string) => Promise<Callback | null>; __ccSignedIn?: string };
export interface ChesscomEvidence { kind: "live" | "daily"; callback: Callback }

export function isFinishedCallback(id: string, callback: Callback | undefined): boolean {
  return !!callback?.game?.isFinished && String(callback.game.id) === id;
}

let signedIn: string | null = null;
/** Read the username from the embedded user settings or the sidebar profile link. */
function signedInUser(doc: Document): string | null {
  const dev = doc.defaultView as Dev | null;
  if (dev?.__ccSignedIn !== undefined) return dev.__ccSignedIn || null;
  if (signedIn) return signedIn;
  for (const script of Array.from(doc.scripts)) {
    const username = script.textContent?.match(/"user":\{"id":\d+,[^{}]*?"username":"([\w-]+)"/)?.[1];
    if (username) return (signedIn = username);
  }
  const href = doc.querySelector('a.sidebar-link[href*="/member/"]')?.getAttribute("href");
  return (signedIn = href?.match(/\/member\/([\w-]+)/)?.[1] ?? null);
}

async function lookupFinishedPage(id: string, url: URL, signal: AbortSignal): Promise<FinishedPage | null> {
  const kind = kindOf(url);
  const dev = window as Dev;
  let callback: Callback | null;
  if (dev.__ccCallback) callback = await dev.__ccCallback(id);
  else {
    const response = await fetch(`/callback/${kind}/game/${id}`, { credentials: "include", signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Chess.com game lookup failed (${response.status}).`);
    callback = await response.json();
  }
  if (!callback) return null;
  const headers = callback.game?.pgnHeaders ?? {};
  if (!headers.White || !headers.Black) throw new Error("Chess.com did not say who played this game.");
  if (!isFinishedCallback(id, callback)) return null;
  const evidence: ChesscomEvidence = { kind, callback };
  return { evidence, players: { white: String(headers.White), black: String(headers.Black) } };
}

export const chesscomPages: SitePages = {
  id: "chesscom",
  name: "Chess.com",
  tabPatterns: ["https://www.chess.com/*", "https://chess.com/*"],
  matches: url => url.hostname === "www.chess.com" || url.hostname === "chess.com",
  gameIdFromPage,
  gameId: url => url.match(/\/(\d+)(?:[/?#]|$)/)?.[1] ?? url,
  isPlayPage,
  pageSafetyKey(url) {
    if (isPlayPage(url)) return "play";
    const id = gameIdFromPage(url);
    return id ? `game:${id}` : "other";
  },
  signedInUser,
  lookupFinishedPage,
  pollDelay: url => kindOf(url) === "daily" ? DAILY_POLL_MS : LIVE_POLL_MS,
  moveLink(url, ply) {
    try {
      const page = new URL(url);
      page.searchParams.set("move", String(ply));
      return page.toString();
    } catch { return url; }
  },
  isAtPly: (url, ply) => url.searchParams.get("move") === String(ply),
  readBoard: readChesscomBoard,
};
