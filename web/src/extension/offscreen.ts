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

export type Request =
  | { type: "warm"; username: string }
  | { type: "stop" }                           // a game is starting: stop any profile build now
  | { type: "recap"; username: string; kind: "live" | "daily"; gameId: string; callback: Callback };
export type Reply =
  | { status: "building"; progress: string }
  | { status: "ready" }
  | { status: "pending" }                      // not finished yet (or not this player's game)
  | { status: "recap"; recap: Recap }
  | { status: "error"; message: string };

const ENGINE_URL = typeof chrome !== "undefined" && chrome.runtime?.getURL
  ? chrome.runtime.getURL("engine/stockfish-19-lite-single.js")
  : new URL("../engine/stockfish-19-lite-single.js", import.meta.url).href;

interface Slot { profile: Profile | null; building: Promise<void> | null; progress: string; error: string;
                abort?: AbortController }
const slots = new Map<string, Slot>();         // one profile per player and time class
const recaps = new Map<string, Recap>();
const mainClass = new Map<string, string>();   // the time class each player plays most

/** Start (once) or report the profile for this player and time class. Null when it is ready. */
function ensureProfile(username: string, timeClass: string): Reply | null {
  const key = `${username.toLowerCase()}|${timeClass}`;
  let s = slots.get(key);
  if (!s) slots.set(key, s = { profile: null, building: null, progress: "Starting…", error: "" });
  if (s.profile) return null;
  if (s.error) { const message = s.error; slots.delete(key); return { status: "error", message }; }
  if (!s.building) {
    const slot = s;
    slot.progress = `Analyzing ${username}'s recent ${timeClass} games…`;
    slot.abort = new AbortController();
    slot.building = analyzeInBrowser({ username, games: 150, timeClass, depth: 8, engineUrl: ENGINE_URL,
      signal: slot.abort.signal, onProgress: (_s, _f, text) => { slot.progress = text; } })
      .then(run => {
        slot.profile = { username: run.username, timeClass, rows: run.gameRows, openings: run.openings,
                         tactics: run.tactics, games: run.games };
      })
      .catch(e => { if (!slot.abort?.signal.aborted) slot.error = (e as Error).message; })
      .finally(() => { slot.building = null; });
  }
  return { status: "building", progress: s.progress };
}

export async function handle(req: Request): Promise<Reply> {
  try {
    if (req.type === "stop") {
      for (const [key, slot] of slots) if (slot.building) { slot.abort?.abort(); slots.delete(key); }
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
      return ensureProfile(req.username, mainClass.get(u)!) ?? { status: "ready" };
    }
    const key = `${req.username.toLowerCase()}|${req.gameId}`;
    if (recaps.has(key)) return { status: "recap", recap: recaps.get(key)! };
    // Fair-play guard: only a game Chess.com reports as finished. Its game endpoint does not even
    // serve a live game until it is over.
    const finished = new Set(req.callback.game.isFinished ? [String(req.callback.game.id)] : []);
    if (!canShowRecap(req.gameId, finished)) return { status: "pending" };
    const probe = gameFromCallback(req.callback, req.username, req.kind, []);
    if (!probe) return { status: "pending" };
    const p = ensureProfile(req.username, probe.timeClass);
    if (p) return p;
    const profile = slots.get(`${req.username.toLowerCase()}|${probe.timeClass}`)!.profile!;
    const game = gameFromCallback(req.callback, req.username, req.kind, profile.games ?? [])!;
    const recap = await recapGame(game, profile, ENGINE_URL);
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
