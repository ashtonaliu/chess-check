// The fair-play guard. Chess.com forbids outside help during a game, so the
// extension must never show anything about a game that is still being played.
// The Chess.com public API only lists finished games, so a recap is allowed
// only for a game URL that appears there.

/** The canonical game URL for a Chess.com page, or null if the page is not a game. */
export function gameUrlFromPage(pageUrl: string | undefined | null): string | null {
  if (!pageUrl) return null;
  let u: URL;
  try { u = new URL(pageUrl); } catch { return null; }
  if (u.hostname !== "www.chess.com" && u.hostname !== "chess.com") return null;
  // /game/live/123, /game/daily/123, /analysis/game/live/123 (with optional trailing parts)
  const m = u.pathname.match(/^\/(?:analysis\/)?game\/(live|daily)\/(\d+)(?:\/|$)/);
  return m ? `https://www.chess.com/game/${m[1]}/${m[2]}` : null;
}

/** A recap may be shown only for a game the public API already lists as finished. */
export function canShowRecap(gameUrl: string | null, finishedUrls: Set<string>): boolean {
  return gameUrl !== null && finishedUrls.has(gameUrl);
}
