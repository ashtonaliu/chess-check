import { boardToPlacement, type BoardPieces, type BoardReading, type PieceCode } from "../boardPlacement";
import type { PageLookup, SafetyKey, SitePages } from "../site";
import { gameIdFromPage, isPlayPage, pageSafetyKey, readStatusOnly } from "../../extension/lichessGuard";
import type { LichessStatusReply } from "../../extension/lichessRequests";

const gameUrl = (id: string) => new URL(`https://lichess.org/game/${id}`);
const publicId = (url: URL) => gameIdFromPage(url.href);
const FILES = "abcdefgh";
const LICHESS_ROLE: Record<string, string> = {
  pawn: "P", knight: "N", bishop: "B", rook: "R", queen: "Q", king: "K",
};

function boardPixels(board: Element): number {
  const rect = typeof board.getBoundingClientRect === "function" ? board.getBoundingClientRect() : null;
  if (rect && rect.width > 0) return rect.width;
  const styleWidth = (el: Element | null) => {
    const raw = el?.getAttribute("style") ?? "";
    const m = raw.match(/\bwidth\s*:\s*(\d+(?:\.\d+)?)px/i);
    return m ? Number(m[1]) : 0;
  };
  return styleWidth(board) || styleWidth(board.parentElement) || 0;
}

function squareFromTransform(style: string, boardWidth: number, flipped: boolean): string | null {
  const m = style.match(/translate(?:3d)?\(\s*(-?\d+(?:\.\d+)?)(px|%)?(?:\s*,\s*(-?\d+(?:\.\d+)?)(px|%)?)?/i);
  if (!m) return null;
  const x = Number(m[1]);
  const xUnit = m[2] ?? "px";
  const y = m[3] !== undefined ? Number(m[3]) : 0;
  const yUnit = m[4] ?? xUnit;
  let col: number, row: number;
  if (xUnit === "%" || yUnit === "%") {
    col = Math.round(x / 100);
    row = Math.round(y / 100);
  } else {
    if (boardWidth <= 0) return null;
    const sq = boardWidth / 8;
    col = Math.round(x / sq);
    row = Math.round(y / sq);
  }
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  const file = flipped ? 7 - col : col;
  const rank = flipped ? row + 1 : 8 - row;
  return `${FILES[file]}${rank}`;
}

/** Read piece positions from Lichess's chessground DOM (`cg-board > piece`).
 *  Uses each piece's `translate`/`translate3d` transform and `.cg-wrap.orientation-black`. */
export function readLichessBoard(doc: Document): BoardReading | null {
  const board = doc.querySelector("cg-board");
  if (!board) return null;
  const nodes = board.querySelectorAll("piece");
  if (!nodes.length) return null;
  const flipped = !!board.closest(".cg-wrap")?.classList.contains("orientation-black");
  const width = boardPixels(board);
  const pieces: BoardPieces = {};
  for (const el of Array.from(nodes)) {
    const classes = (el.getAttribute("class") ?? "").split(/\s+/);
    if (classes.includes("ghost")) continue;
    if (classes.includes("dragging")) return null;
    const color = classes.includes("white") ? "w" : classes.includes("black") ? "b" : null;
    const role = classes.map(c => LICHESS_ROLE[c]).find(Boolean) ?? null;
    if (!color || !role) continue;
    const style = el.getAttribute("style") ?? "";
    const cgKey = (el as Element & { cgKey?: string }).cgKey;
    const square = squareFromTransform(style, width, flipped)
      ?? (cgKey && /^[a-h][1-8]$/.test(cgKey) ? cgKey : null);
    if (!square) return null;
    if (pieces[square]) return null;
    pieces[square] = `${color}${role}` as PieceCode;
  }
  if (!Object.keys(pieces).length) return null;
  return { element: board, pieces, placement: boardToPlacement(pieces) };
}

async function lookupFinishedPage(id: string, _url: URL, signal: AbortSignal): Promise<PageLookup> {
  const reply = await chrome.runtime.sendMessage<LichessStatusReply>({ target: "bg", type: "lichess-status", gameId: id });
  signal.throwIfAborted();
  if (reply?.status === "wait") return { retryAfterMs: reply.retryAfterMs };
  if (reply?.status === "aborted") return "aborted";
  if (reply?.status !== "finished" || readStatusOnly(reply.evidence) !== "finished" || reply.evidence.id !== id) return null;
  const { white, black } = reply.evidence.players ?? {};
  return { players: { white: white?.user?.name ?? white?.user?.id ?? "Anonymous",
    black: black?.user?.name ?? black?.user?.id ?? "Anonymous" }, evidence: reply.evidence };
}

export const lichessPages: SitePages = {
  id: "lichess",
  name: "Lichess",
  tabPatterns: ["https://lichess.org/*"],
  matches: url => url.protocol === "https:" && url.hostname === "lichess.org",
  gameIdFromPage: publicId,
  gameId: url => gameIdFromPage(url) ?? url,
  isPlayPage,
  pageSafetyKey: url => (pageSafetyKey(url.href) ?? "play") as SafetyKey,
  signedInUser: doc => doc.querySelector("button#user_tag")?.textContent?.trim() || null,
  lookupFinishedPage,
  pollDelay: () => 5_000,
  publicPageUrl(url) {
    const id = publicId(url);
    if (!id) return url.href;
    const page = gameUrl(id);
    if (/^#\d+$/.test(url.hash)) page.hash = url.hash;
    return page.href;
  },
  moveLink(url, ply) {
    const id = gameIdFromPage(url);
    if (!id) return url;
    const page = gameUrl(id);
    page.hash = String(ply);
    return page.href;
  },
  isAtPly: (url, ply) => url.hash === `#${ply}`,
  readBoard: readLichessBoard,
};
