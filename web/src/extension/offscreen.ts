// Hidden "offscreen" extension page that does the heavy work: building the
// player's profile and analyzing finished games with Stockfish (workers can't
// run in Chess.com's page or in the service worker). The cube overlay asks it
// for recaps through the background service worker.
//
// When the engine runs: the profile is built when the cube asks to "warm" it,
// which it does only on pages that are not a game or the play page, and for a
// finished game. Nothing here runs while the player is in a game.
import { gameFromCallback, type Callback } from "../browser/callbackGame";
import { recapGame, type Profile } from "../browser/follow";
import { fetchGames } from "../browser/games";
import { analyzeInBrowser } from "../browser/pipeline";
import type { Recap } from "../browser/recap";
import { canShowRecap } from "./guard";
import { loadProfile, saveProfile } from "./profileStore";

export type Request =
  | { type: "warm"; username: string }
  | { type: "stop" }                           // a game is starting: stop any profile build now
  | { type: "recap"; username: string; kind: "live" | "daily"; gameId: string; callback: Callback };
export type Reply =
  | { status: "building"; progress: string }
  | { status: "ready" }
  | { status: "pending" }                      // not finished yet (or not this player's game)
  | { status: "recap"; recap: Recap; games: number }    // games: how many past games the profile used
  | { status: "error"; message: string };

const ENGINE_URL = typeof chrome !== "undefined" && chrome.runtime?.getURL
  ? chrome.runtime.getURL("engine/stockfish-19-lite-single.js")
  : new URL("../engine/stockfish-19-lite-single.js", import.meta.url).href;

const FULL = 150, QUICK = 50;     // a first-ever build uses 50 games, then fills in to 150

interface Slot {
  profile: Profile | null; games: number;      // the profile in use, and how many games it is based on
  building: Promise<void> | null; progress: string; error: string; abort?: AbortController;
  refreshed: boolean;                          // a saved profile is refreshed once per session
}
const slots = new Map<string, Slot>();         // one profile per player and time class
const recaps = new Map<string, { recap: Recap; games: number }>();
const mainClass = new Map<string, string>();   // the time class each player plays most

function build(slot: Slot, key: string, username: string, timeClass: string, games: number) {
  slot.progress = `Analyzing ${username}'s last ${games} ${timeClass} games…`;
  const abort = slot.abort = new AbortController();
  slot.building = analyzeInBrowser({ username, games, timeClass, depth: 8, engineUrl: ENGINE_URL,
    signal: abort.signal, onProgress: (_s, _f, text) => { slot.progress = text; } })
    .then(async run => {
      const profile: Profile = { username: run.username, timeClass, rows: run.gameRows, openings: run.openings,
                                 tactics: run.tactics, games: run.games };
      slot.profile = profile; slot.games = games; slot.refreshed = true;
      await saveProfile(key, { profile, games, savedAt: Date.now() });
    })
    .catch(e => { if (!abort.signal.aborted && !slot.profile) slot.error = (e as Error).message; })
    .finally(() => { slot.building = null; });
}

/** Start or report the profile for this player and time class; null when one is ready to use.
 *  Order of preference: the one in memory, the saved one, a quick 50-game build. Whichever is
 *  used, a full refresh then runs in the background (until the next game stops it). */
async function ensureProfile(username: string, timeClass: string): Promise<Reply | null> {
  const key = `${username.toLowerCase()}|${timeClass}`;
  let s = slots.get(key);
  if (!s) slots.set(key, s = { profile: null, games: 0, building: null, progress: "Starting…", error: "", refreshed: false });
  if (s.error) { const message = s.error; slots.delete(key); return { status: "error", message }; }
  if (!s.profile && !s.building) {
    const saved = await loadProfile(key);
    if (saved && !s.profile) { s.profile = saved.profile; s.games = saved.games; }
  }
  if (s.profile) {
    if (!s.building && (!s.refreshed || s.games < FULL)) build(s, key, username, timeClass, FULL);
    return null;
  }
  if (!s.building) build(s, key, username, timeClass, QUICK);
  return { status: "building", progress: s.progress };
}

export async function handle(req: Request): Promise<Reply> {
  try {
    if (req.type === "stop") {
      // abort any build; a profile already in use (even a 50-game one) is kept
      for (const [key, slot] of slots) {
        if (!slot.building) continue;
        slot.abort?.abort(); slot.building = null;
        if (!slot.profile) slots.delete(key);
      }
      return { status: "ready" };
    }
    if (req.type === "warm") {
      // between games: get the profile for the time class this player plays most ready in advance
      const u = req.username.toLowerCase();
      if (!mainClass.has(u)) {
        const recent = await fetchGames(req.username, 40, null);
        const counts = new Map<string, number>();
        for (const g of recent) counts.set(g.timeClass, (counts.get(g.timeClass) ?? 0) + 1);
        const top = [...counts.entries()].filter(([c]) => c !== "daily").sort((a, b) => b[1] - a[1])[0];
        if (!top) return { status: "ready" };
        mainClass.set(u, top[0]);
      }
      return (await ensureProfile(req.username, mainClass.get(u)!)) ?? { status: "ready" };
    }
    const key = `${req.username.toLowerCase()}|${req.gameId}`;
    // Fair-play guard: only a game Chess.com reports as finished. Its game endpoint does not even
    // serve a live game until it is over.
    const finished = new Set(req.callback.game.isFinished ? [String(req.callback.game.id)] : []);
    if (!canShowRecap(req.gameId, finished)) return { status: "pending" };
    const probe = gameFromCallback(req.callback, req.username, req.kind, []);
    if (!probe) return { status: "pending" };
    const p = await ensureProfile(req.username, probe.timeClass);
    if (p) return p;
    const slot = slots.get(`${req.username.toLowerCase()}|${probe.timeClass}`)!;
    const profile = slot.profile!, games = slot.games;
    const done = recaps.get(key);                // reuse a recap unless the profile has grown since
    if (done && done.games >= games) return { status: "recap", recap: done.recap, games: done.games };
    const game = gameFromCallback(req.callback, req.username, req.kind, profile.games ?? [])!;
    const recap = await recapGame(game, profile, ENGINE_URL);
    recaps.set(key, { recap, games });
    return { status: "recap", recap, games };
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
