import { DEFAULT_SITE, type SiteId } from "../browser/site";

export const playerKey = (site: SiteId, user: string) => `${site}|${user.toLowerCase()}`;
export const profileKey = (site: SiteId, user: string, timeClass: string) => `${playerKey(site, user)}|${timeClass}`;
export const recapKey = (site: SiteId, user: string, gameId: string) => `${playerKey(site, user)}|${gameId}`;

/** Profiles from 0.8.x have only the username and time class. */
export const qualifyProfileKey = (key: string) => key.split("|").length === 2 ? `${DEFAULT_SITE}|${key}` : key;
export const legacyProfileKey = (key: string) => key.startsWith(`${DEFAULT_SITE}|`) ? key.slice(DEFAULT_SITE.length + 1) : undefined;
