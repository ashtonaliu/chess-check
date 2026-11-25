import type { Site, SiteId } from "../site";
import { chesscom } from "./chesscom";

export const defaultSite = chesscom;
const sites: readonly Site[] = [chesscom];
export const siteForId = (id: SiteId | undefined) => sites.find(site => site.id === id);
