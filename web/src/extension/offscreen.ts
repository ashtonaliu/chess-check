// Hidden "offscreen" extension page that does the heavy work: building the
// player's profile and analyzing finished games with Stockfish (workers can't
// run in Chess.com's page or in the service worker). The cube overlay asks it
// for recaps through the background service worker.
import { recapGame, type Profile } from "../browser/follow";
import { findGame, type Game } from "../browser/games";
import { analyzeInBrowser } from "../browser/pipeline";
import type { Recap } from "../browser/recap";
import { canShowRecap, gameIdFromApiUrl } from "./guard";

export type Request = { type: "recap"; username: string; gameId: string };
export type Reply =
  | { status: "building"; progress: string }
  | { status: "pending" }                      // not finished yet (or not this player's game)
  | { status: "recap"; recap: Recap }
  | { status: "error"; message: string };

const ENGINE_URL = typeof chrome !== "undefined" && chrome.runtime?.getURL
  ? chrome.runtime.getURL("engine/stockfish-19-lite-single.js")
  : new URL("../engine/stockfish-19-lite-single.js", import.meta.url).href;

let profileKey = "";
let profile: Profile | null = null;
let building: Promise<void> | null = null;
let progress = "Starting…";
let lastError = "";
const recaps = new Map<string, Recap>();
const finished = new Map<string, Game>();      // games the public API already listed as finished

/** Build (once) the profile for this player and time class. Only called for a finished game,
 *  so Stockfish never runs while the player is in a game. */
function ensureProfile(username: string, timeClass: string): Reply | null {
  const key = `${username.toLowerCase()}|${timeClass}`;
  if (key !== profileKey) { profileKey = key; profile = null; building = null; lastError = ""; }
  if (profile) return null;
  if (lastError) return { status: "error", message: lastError };
  if (!building) {
    progress = `Analyzing ${username}'s recent ${timeClass} games…`;
    building = analyzeInBrowser({ username, games: 150, timeClass, depth: 8, engineUrl: ENGINE_URL,
      onProgress: (_s, _f, text) => { progress = text; } })
      .then(run => {
        if (profileKey !== key) return;
        profile = { username: run.username, timeClass, rows: run.gameRows, openings: run.openings, tactics: run.tactics };
      })
      .catch(e => { lastError = (e as Error).message; })
      .finally(() => { building = null; });
  }
  return { status: "building", progress };
}

export async function handle(req: Request): Promise<Reply> {
  try {
    const key = `${req.username.toLowerCase()}|${req.gameId}`;
    if (recaps.has(key)) return { status: "recap", recap: recaps.get(key)! };
    // Fair-play guard: only games the public API already lists as finished. Look the game up by ID,
    // since a player can finish dozens of games after the one they open.
    let game = finished.get(key);
    if (!game) {
      const found = await findGame(req.username, req.gameId);
      const ids = new Set(found ? [gameIdFromApiUrl(found.url)!] : []);
      if (!found || !canShowRecap(req.gameId, ids)) return { status: "pending" };
      finished.set(key, game = found);
    }
    const p = ensureProfile(req.username, game.timeClass);
    if (p) return p;
    const recap = await recapGame(game, profile!, ENGINE_URL);
    recaps.set(key, recap);
    return { status: "recap", recap };
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg: { target?: string } & Request, _sender, sendResponse) => {
    if (msg.target !== "offscreen") return false;
    void handle(msg).then(sendResponse);
    return true;   // reply asynchronously
  });
} else {
  // development harness (extension/dev.html): the cube calls this directly
  (window as unknown as { __wfHandle: typeof handle }).__wfHandle = handle;
}
