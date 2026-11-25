import { defaultSitePages, siteForUrl } from "../browser/site";

export { gameIdFromApiUrl } from "../browser/sites/chesscomPages";

export function gameIdFromPage(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const page = new URL(url);
    return siteForUrl(page)?.gameIdFromPage(page) ?? null;
  } catch { return null; }
}

export function isPlayPage(url: URL): boolean {
  return (siteForUrl(url) ?? defaultSitePages).isPlayPage(url);
}

export function canShowRecap(gameId: string | null, finishedIds: Set<string>): boolean {
  return gameId !== null && finishedIds.has(gameId);
}

/** The review queue stays closed on play pages and on unconfirmed game pages. */
export function canReview(pageUrl: string, gameConfirmedOver: boolean): boolean {
  let url: URL;
  try { url = new URL(pageUrl); } catch { return false; }
  if (isPlayPage(url)) return false;
  return !siteForUrl(url)?.gameIdFromPage(url) || gameConfirmedOver;
}

export function pageSafety(url: string | undefined) {
  if (!url) return null;
  let page: URL;
  try { page = new URL(url); } catch { return null; }
  const site = page.protocol === "https:" && siteForUrl(page);
  return site ? { site: site.id, key: site.pageSafetyKey(page) } : null;
}

export const pageSafetyKey = (url: string | undefined) => pageSafety(url)?.key ?? null;
