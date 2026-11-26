import type { BoardReading } from "./boardPlacement";
import type { Game } from "./games";
import { chesscomPages } from "./sites/chesscomPages";
import { lichessPages } from "./sites/lichessPages";

export type SiteId = "chesscom" | "lichess";
export const DEFAULT_SITE: SiteId = "chesscom";

export interface FinishedPage {
  players: { white: string; black: string };
  evidence: unknown;
}

export type PageLookup = FinishedPage | "aborted" | { retryAfterMs: number } | null;

export type SafetyKey = "play" | "other" | `game:${string}`;

/** The page methods can run in the content script without loading the analysis code. */
export interface SitePages {
  id: SiteId;
  name: string;
  tabPatterns: readonly string[];
  matches(url: URL): boolean;
  gameIdFromPage(url: URL): string | null;
  gameId(url: string): string;
  isPlayPage(url: URL): boolean;
  pageSafetyKey(url: URL): SafetyKey;
  signedInUser(doc: Document): string | null;
  lookupFinishedPage(id: string, url: URL, signal: AbortSignal): Promise<PageLookup>;
  publicPageUrl?(url: URL): string;
  pollDelay(url: URL): number;
  moveLink(url: string, ply: number): string;
  isAtPly(url: URL, ply: number): boolean;
  readBoard(doc: Document): BoardReading | null;
}

export interface Site extends SitePages {
  isFinishedGame(id: string, evidence: unknown): boolean;
  /** Check the site's finish evidence again before parsing the game for this player. */
  finishedGame(id: string, user: string, evidence: unknown): Game | "pending" | null;
  history(user: string, timeClass: string | null, max: number, signal?: AbortSignal): Promise<Game[]>;
  /** The opponent's recent games for the post-game note, which reads only their games in `color`. */
  opponentHistory(user: string, color: Game["color"], timeClass: string | null, signal?: AbortSignal): Promise<Game[]>;
  nameOpening(game: Game, history: Game[]): Game;
}

const pages: readonly SitePages[] = [chesscomPages, lichessPages];
export const siteTabPatterns = pages.flatMap(site => site.tabPatterns);
export const siteForUrl = (url: URL) => pages.find(site => site.matches(url));
export function pageSite(url: string | undefined | null) {
  try { return url ? siteForUrl(new URL(url)) : undefined; } catch { return undefined; }
}
export const defaultSitePages: SitePages = chesscomPages;
