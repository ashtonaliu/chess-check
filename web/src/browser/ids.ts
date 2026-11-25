import { defaultSitePages, pageSite } from "./site";

/** The same game ID across archive, endpoint and page URLs. */
export const gameId = (url: string) => (pageSite(url) ?? defaultSitePages).gameId(url);
