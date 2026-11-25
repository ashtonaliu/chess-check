// Fair-play guard for Lichess (docs/lichess-plan.md Part 2).
// Unlike Chess.com, a Lichess game keeps the same URL while in play and after
// it ends, so every game page starts paused until /game/export/{id} reports a
// finished status other than created or started.

export type LichessStatusKind = "pending" | "aborted" | "finished";

export const LICHESS_PENDING_STATUSES = new Set(["created", "started"]);
export const LICHESS_ABORTED_STATUSES = new Set(["aborted", "noStart"]);
export const LICHESS_FINISHED_STATUSES = new Set([
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

export const STATUS_CHECK_INTERVAL_MS = 3000;
export const RATE_LIMIT_COOLDOWN_MS = 60_000;

// 8-character top-level Lichess routes that must never be mistaken for 8-character game IDs.
const RESERVED_8CHAR_ROUTES = new Set([
  "analysis",
  "training",
  "practice",
  "streamer",
  "accounts",
  "features",
  "settings",
  "variants",
  "calendar",
  "timeline",
  "download",
  "register",
  "password",
  "marathon",
]);

// Lichess serves games at /game/{id}. Root-level addresses are older and now redirect there.
const GAME_PATH = /^\/(game\/)?([A-Za-z0-9]{8}(?:[A-Za-z0-9]{4})?)(?:\/(?:white|black))?\/?$/;
const ORDINARY_PATH = /^\/(?:analysis(?:\/|$)|study(?:\/|$)|training(?:\/|$)|@\/[^/]+(?:\/|$))/;
const EXPLICIT_PLAY_PATH = /^\/(?:$|setup(?:\/|$)|tournament(?:\/|$)|swiss(?:\/|$)|simul(?:\/|$)|tv(?:\/|$))/;

/**
 * The canonical 8-character Lichess game ID for a game page, or null if the URL
 * is not a Lichess game page. Both 8-character spectator IDs and 12-character
 * player IDs (with or without /white or /black, under /game/ or at the root)
 * return the first 8 characters.
 */
export function gameIdFromPage(pageUrl: string | undefined | null): string | null {
  if (!pageUrl) return null;
  let u: URL;
  try { u = new URL(pageUrl); } catch { return null; }
  if (u.hostname !== "lichess.org") return null;
  const m = u.pathname.match(GAME_PATH);
  if (!m) return null;
  const raw = m[2];
  if (!m[1] && raw.length === 8 && RESERVED_8CHAR_ROUTES.has(raw.toLowerCase())) return null;
  return raw.slice(0, 8);
}

/** Classify a Lichess export status. Unknown or missing statuses fail closed as "pending". */
export function classifyLichessStatus(status: string | undefined | null): LichessStatusKind {
  if (!status) return "pending";
  if (LICHESS_ABORTED_STATUSES.has(status)) return "aborted";
  if (LICHESS_FINISHED_STATUSES.has(status)) return "finished";
  return "pending";
}

/** Read only the status field from an export response; never inspects moves or clocks. */
export function readStatusOnly(exportPayload: unknown): LichessStatusKind {
  if (!exportPayload || typeof exportPayload !== "object") return "pending";
  const status = (exportPayload as { status?: unknown }).status;
  return typeof status === "string" ? classifyLichessStatus(status) : "pending";
}

export function isAbortedStatus(status: string | undefined | null): boolean {
  return classifyLichessStatus(status) === "aborted";
}

/** A recap may be shown only for a Lichess game whose status is finished and not aborted. */
export function canShowRecap(gameId: string | null, status: string | undefined | null): boolean {
  return gameId !== null && classifyLichessStatus(status) === "finished";
}

/**
 * Pages where a game can start at any time or is shown live count as play pages.
 * Only explicit ordinary pages (/analysis, /study/, /training, /@/{user}) and
 * game pages are exempt; any other unknown Lichess path defaults to a play page.
 */
export function isPlayPage(url: URL): boolean {
  if (url.hostname !== "lichess.org") return false;
  if (EXPLICIT_PLAY_PATH.test(url.pathname)) return true;
  if (gameIdFromPage(url.href) !== null) return false;
  return !ORDINARY_PATH.test(url.pathname);
}

/**
 * The review queue stays off play pages and off game pages until /game/export/{id}
 * confirms the game is no longer created or started.
 */
export function canReview(pageUrl: string, gameConfirmedOver: boolean): boolean {
  let u: URL;
  try { u = new URL(pageUrl); } catch { return false; }
  if (u.hostname !== "lichess.org") return false;
  if (isPlayPage(u)) return false;
  return gameIdFromPage(pageUrl) === null || gameConfirmedOver;
}

/**
 * Cross-tab safety key: aliases for the same game (8-char, 12-char, /white, /black)
 * share `game:<id8>`, play/lobby/unknown pages share `play`, and ordinary pages share `other`.
 */
export function pageSafetyKey(url: string | undefined): string | null {
  if (!url) return null;
  let page: URL;
  try { page = new URL(url); } catch { return null; }
  if (page.protocol !== "https:" || page.hostname !== "lichess.org") return null;
  if (isPlayPage(page)) return "play";
  const game = gameIdFromPage(url);
  return game ? `game:${game}` : "other";
}

/** Delay in milliseconds before the background worker may poll /game/export/{id} again for a tab. */
export function nextStatusCheckDelayMs(httpStatus: number | null, elapsedSinceLastMs: number): number {
  if (httpStatus === 429) return RATE_LIMIT_COOLDOWN_MS;
  return Math.max(0, STATUS_CHECK_INTERVAL_MS - Math.max(0, elapsedSinceLastMs));
}
