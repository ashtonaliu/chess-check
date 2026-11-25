import { DEFAULT_SITE, defaultSitePages, pageSite } from "./site";

/** The same game ID across archive, endpoint and page URLs. */
export const gameId = (url: string) => (pageSite(url) ?? defaultSitePages).gameId(url);

/** Keep existing Chess.com engine entries while isolating IDs from other sites. */
export function gameCacheId(url: string): string {
  const site = pageSite(url);
  if (site && site.id !== DEFAULT_SITE) return `${site.id}:${site.gameId(url)}`;
  return url.split("/").pop()!;
}
