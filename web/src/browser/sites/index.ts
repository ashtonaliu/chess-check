import type { Site, SiteId } from "../site";
import { chesscom } from "./chesscom";
import { lichess } from "./lichess";

export const defaultSite = chesscom;
const sites: readonly Site[] = [chesscom, lichess];
export const siteForId = (id: SiteId | undefined) => sites.find(site => site.id === id);
