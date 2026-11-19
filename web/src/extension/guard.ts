// The fair-play guard. Chess.com forbids outside help during a game, so the
// extension must never show anything about a game that is still being played.
// The Chess.com public API only lists finished games, so a recap is allowed
// only for a game whose ID appears there.

/**
 * The game ID for a Chess.com page, or null if the page is not a game.
 * Chess.com uses several address forms for the same game:
 *   /game/187138001290            (current live-game pages)
 *   /game/live/187138001290       (older live-game pages, and the public API)
 *   /game/daily/9001
 *   /analysis/game/live/187138001290/review
 */
export function gameIdFromPage(pageUrl: string | undefined | null): string | null {
  if (!pageUrl) return null;
  let u: URL;
  try { u = new URL(pageUrl); } catch { return null; }
  if (u.hostname !== "www.chess.com" && u.hostname !== "chess.com") return null;
  const m = u.pathname.match(/^\/(?:analysis\/)?(?:(?:live|daily)\/)?game\/(?:(?:live|daily)\/)?(\d+)(?:\/|$)/);
  return m ? m[1] : null;
}

/** The game ID in a public-API game URL such as https://www.chess.com/game/live/187138001290. */
export const gameIdFromApiUrl = (url: string) => url.match(/\/(\d+)$/)?.[1] ?? null;

/** A recap may be shown only for a game the public API already lists as finished. */
export function canShowRecap(gameId: string | null, finishedIds: Set<string>): boolean {
  return gameId !== null && finishedIds.has(gameId);
}

/** Chess.com's Play pages can lead straight into a new game. */
export function isPlayPage(url: URL): boolean {
  return /^\/play(\/|$)/.test(url.pathname);
}

/** The review queue is never shown on the page games are played from, or on a game page until
 *  Chess.com has confirmed that game is over. Other pages (home, profiles, puzzles) are fine. */
export function canReview(pageUrl: string, gameConfirmedOver: boolean): boolean {
  let u: URL;
  try { u = new URL(pageUrl); } catch { return false; }
  if (isPlayPage(u)) return false;
  return !gameIdFromPage(pageUrl) || gameConfirmedOver;
}

/** Aliases for the same finished game share a key. Play and public pages have their own keys. */
export function pageSafetyKey(url: string | undefined): string | null {
  if (!url) return null;
  let page: URL;
  try { page = new URL(url); } catch { return null; }
  if (page.protocol !== "https:" || !["www.chess.com", "chess.com"].includes(page.hostname)) return null;
  if (isPlayPage(page)) return "play";
  const game = gameIdFromPage(url);
  return game ? `game:${game}` : "other";
}
