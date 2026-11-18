// Hidden "offscreen" extension page that does the heavy work: building the
// player's profile and analyzing finished games with Stockfish (workers can't
// run in Chess.com's page or in the service worker). The cube overlay asks it
// for recaps through the background service worker.
//
// When the engine runs: the profile is built when the cube asks to "warm" it,
// which it does only on pages that are not a game or the play page, and for a
// finished game. Nothing here runs while the player is in a game.
import { gameFromCallback, type Callback } from "../browser/callbackGame";
import type { GameAnalysis } from "../browser/engine";
import { analyzeGame, type Profile } from "../browser/follow";
import { fetchGames, type Game } from "../browser/games";
import { analyzeInBrowser } from "../browser/pipeline";
import { buildRecap, opponentNote, type Recap } from "../browser/recap";
import type { BlunderRec } from "../browser/tactics";
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
  // games: how many past games the profile used. partial: what is still being added, when the recap
  // is not complete yet (ask again in a moment, unless retry is false).
  | { status: "recap"; recap: Recap; games: number; partial?: string; retry?: boolean }
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

// The finished game's own work, started on the first request and shared by the ones after it (the
// cube asks every second while a recap is incomplete).
interface GameJob {
  game: Game;
  analysis: { analysis: GameAnalysis; blunders: BlunderRec[] } | null; error: string;
  opponentGames: Game[] | null; opponentDone: boolean;   // for the opponent note, written at the end
}
const jobs = new Map<string, GameJob>();

function startJob(key: string, game: Game): GameJob {
  const job: GameJob = { game, analysis: null, error: "", opponentGames: null, opponentDone: !game.opponent };
  jobs.set(key, job);
  analyzeGame(game, ENGINE_URL).then(r => { job.analysis = r; })
    .catch(e => { job.error = (e as Error).message; });
  if (game.opponent) {
    fetchGames(game.opponent, 100, game.timeClass)
      .then(gs => { job.opponentGames = gs.filter(g => g.url !== game.url); })
      .catch(() => { /* no opponent note */ })
      .finally(() => { job.opponentDone = true; });
  }
  return job;
}
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
async function ensureProfile(username: string, timeClass: string, startNow = true): Promise<Reply | null> {
  const key = `${username.toLowerCase()}|${timeClass}`;
  let s = slots.get(key);
  if (!s) slots.set(key, s = { profile: null, games: 0, building: null, progress: "Starting…", error: "", refreshed: false });
  if (s.error) { const message = s.error; slots.delete(key); return { status: "error", message }; }
  if (!s.profile && !s.building) {
    const saved = await loadProfile(key);
    if (saved && !s.profile) { s.profile = saved.profile; s.games = saved.games; }
  }
  if (s.profile) {
    if (startNow && !s.building && (!s.refreshed || s.games < FULL)) build(s, key, username, timeClass, FULL);
    return null;
  }
  if (!s.building && startNow) build(s, key, username, timeClass, QUICK);
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
    // The game is over: show what is known now and add the rest as it arrives. The game's own
    // analysis runs alongside the profile build, which a first install has to wait for.
    const slotKey = `${req.username.toLowerCase()}|${probe.timeClass}`;
    // Any profile build (a first one, or a saved profile's refresh) waits until this game is
    // analyzed, so the two do not compete for the CPU while the player waits for the turning point.
    const p = await ensureProfile(req.username, probe.timeClass, !!jobs.get(key)?.analysis);
    const slot = slots.get(slotKey);
    const profile = p === null ? slot!.profile! : null, games = profile ? slot!.games : 0;
    const done = recaps.get(key);                // reuse a recap unless the profile has grown since
    if (done && (done.games >= games || !profile)) return { status: "recap", recap: done.recap, games: done.games };
    let job = jobs.get(key);
    if (!job) job = startJob(key, gameFromCallback(req.callback, req.username, req.kind, slot?.profile?.games ?? [])!);
    // name the opening from the profile's games once there are some
    const game = profile ? gameFromCallback(req.callback, req.username, req.kind, profile.games ?? [])! : job.game;
    const a = job.analysis, err = job.error;
    const empty: GameAnalysis = { url: game.url, color: game.color, moves: [], opening_eval: null };
    if (profile && (a || err) && job.opponentDone) {
      // the note names the opening, so it is written now that the profile has named it
      const note = game.opponent && job.opponentGames
        ? opponentNote(game.opponent, job.opponentGames, game.family, game.color === "white" ? "black" : "white") : null;
      const recap = buildRecap(game, a?.analysis ?? empty, a?.blunders ?? [], profile.rows, profile.tactics, note);
      jobs.delete(key);
      if (err) {
        // keep everything else; the next visit to this game tries the analysis again
        recap.turningError = err;
        return { status: "recap", recap, games, partial: "Reopen this game to try the analysis again.", retry: false };
      }
      recaps.set(key, { recap, games });
      return { status: "recap", recap, games };
    }
    const recap = buildRecap(game, a?.analysis ?? empty, a?.blunders ?? [], profile?.rows ?? [], profile?.tactics ?? null, null);
    recap.pending = { turning: !a && !err, history: !profile || !job.opponentDone };
    if (err) recap.turningError = err;
    const failed = p?.status === "error" ? p.message : "";
    const partial = failed ? `Your past games could not be loaded (${failed}), so this recap has no patterns.`
      : !a && !err ? "Stockfish is analyzing this game."
      : !profile ? `Adding your patterns. ${p?.status === "building" ? p.progress : ""}`.trim()
      : "Reading your opponent's recent games…";
    // a failed history load is final for now; anything else is still on its way
    if (failed && (a || err)) jobs.delete(key);
    return { status: "recap", recap, games, partial, retry: !(failed && (a || err)) };
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
  (window as unknown as { __ccHandle: typeof handle }).__ccHandle = handle;
}
