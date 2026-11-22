// Hidden "offscreen" extension page that does the heavy work: building the
// player's profile and analyzing finished games with Stockfish (workers can't
// run in Chess.com's page or in the service worker). The cube overlay asks it
// for recaps through the background service worker.
//
// When the engine runs: the profile is built when the cube asks to "warm" it,
// which it does only on pages that are not a game or the play page, and for a
// finished game. Nothing here runs while the player is in a game.
import { gameFromCallback, nameCallbackOpening, type Callback } from "../browser/callbackGame";
import { defaultWorkers, pruneAnalysisCache, type GameAnalysis } from "../browser/engine";
import { moveFeatures } from "../browser/findRate";
import { analyzeGame, type Profile } from "../browser/follow";
import { fetchGames, type Game } from "../browser/games";
import { gameId } from "../browser/ids";
import { Pace, SharedPace, startingWorkers } from "../browser/pace";
import { analyzeInBrowser } from "../browser/pipeline";
import { buildRecap, opponentNote, type Recap } from "../browser/recap";
import { withExpected, type GameRow } from "../browser/stats";
import { itemsFromBlunders, type ReviewItem, type ReviewRateRequest } from "../browser/reviewQueue";
import { reviewFindRate } from "./reviewFindRate";
import type { BlunderRec } from "../browser/tactics";
import { canShowRecap } from "./guard";
import { loadProfile, profileGameIds, pruneProfiles, saveProfile, touchProfile, type Saved } from "./profileStore";
import { ANALYSIS_LIMIT, PROFILE_LIMIT, rememberRecap, reviewDependencies } from "./storageRetention";

export type Request =
  | { type: "warm"; username: string }
  | { type: "page-state"; url: string; finished: boolean }
  | { type: "stop" }                           // a game is starting: stop any analysis now
  | { type: "seed"; username: string }         // past blunders to start an empty review queue
  | { type: "stalls" }                         // the page the cube is on stuttered (pace.ts)
  | { type: "pace" }                           // the worker count now, for testing
  | { type: "rate"; items: ReviewRateRequest[] }
  | { type: "recap"; username: string; kind: "live" | "daily"; gameId: string; callback: Callback };
export type Reply =
  | { status: "building"; progress: string }
  | { status: "ready" }
  | { status: "paused" }
  | { status: "pending" }                      // not finished yet (or not this player's game)
  // games: how many past games the profile used. partial: what is still being added, when the recap
  // is not complete yet (ask again in a moment, unless retry is false).
  | { status: "recap"; recap: Recap; games: number; partial?: string; retry?: boolean }
  | { status: "seed"; items: ReviewItem[] }    // empty until a profile exists
  | { status: "rates"; rates: Record<string, number | null> }
  | { status: "pace"; workers: number | null; max: number; remembered: number | null }
  | { status: "error"; message: string };

const ENGINE_URL = typeof chrome !== "undefined" && chrome.runtime?.getURL
  ? chrome.runtime.getURL("engine/stockfish-19-lite-single.js")
  : new URL("../engine/stockfish-19-lite-single.js", import.meta.url).href;

const FULL = 150, QUICK = 50;     // a first-ever build uses 50 games, then fills in to 150

interface Slot {
  profile: Profile | null; games: number;      // the profile in use, and how many games it is based on
  building: Promise<void> | null; progress: string; error: string; abort?: AbortController;
  loading?: Promise<Saved | null>;
  quickGames?: Promise<Game[]>;
  archive?: { games: Game[]; rows: GameRow[] };
  refreshed: boolean;                          // a saved profile is refreshed once per session
}
const slots = new Map<string, Slot>();         // one profile per player and time class
const recaps = new Map<string, { recap: Recap; games: number }>();

// The finished game's own work, started on the first request and shared by the ones after it (the
// cube asks every second while a recap is incomplete).
interface GameJob {
  game: Game;
  analysis: { analysis: GameAnalysis; blunders: BlunderRec[] } | null; error: string;
  opponentGames: Game[] | null; opponentDone: boolean;   // the note can appear before the profile is ready
}
const jobs = new Map<string, GameJob>();
// A stop also cancels recap jobs and archive lookups that would otherwise start a build later.
let pendingWork = new AbortController();
let currentProfile: string | null = null;
let checkedStorageAtStartup = false;
let storageCleanup = Promise.resolve();

function activeProfiles(): Set<string> {
  const current = new Set<string>();
  if (currentProfile) current.add(currentProfile);
  for (const [key, slot] of slots) if (slot.building || slot.loading) current.add(key);
  return current;
}

function scheduleStorageCleanup(signal: AbortSignal) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  storageCleanup = storageCleanup.then(async () => {
    if (signal.aborted) return;
    const queues = await chrome.runtime.sendMessage<Record<string, unknown> | null>({ target: "review-dependencies" });
    if (!queues) return;
    const { games, legacyByUser } = reviewDependencies(queues);
    const keptGames = await pruneProfiles(activeProfiles, legacyByUser, PROFILE_LIMIT, signal);
    for (const id of keptGames) games.add(id);
    for (const key of activeProfiles()) {
      const profile = slots.get(key)?.profile;
      if (profile) for (const id of profileGameIds(profile)) games.add(id);
    }
    for (const job of jobs.values()) games.add(gameId(job.game.url));
    await pruneAnalysisCache(games, ANALYSIS_LIMIT, signal);
  }).catch(() => { /* storage unavailable or play resumed; try again after a safe build */ });
}

function startJob(key: string, game: Game, signal: AbortSignal): GameJob {
  const job: GameJob = { game, analysis: null, error: "", opponentGames: null, opponentDone: !game.opponent };
  jobs.set(key, job);
  analyzeGame(game, ENGINE_URL, signal).then(r => { job.analysis = r; })
    .catch(e => { job.error = (e as Error).message; });
  if (game.opponent) {
    fetchGames(game.opponent, 100, game.timeClass, signal)
      .then(gs => { job.opponentGames = gs.filter(g => g.url !== game.url); })
      .catch(() => { /* no opponent note */ })
      .finally(() => { job.opponentDone = true; });
  }
  return job;
}
const mainClass = new Map<string, string>();   // the time class each player plays most

// Profile builds run in the background while you use Chess.com, so their worker count adapts
// (pace.ts) and the count that worked is remembered on this device for the next build.
const WORKERS_KEY = "chess-check-workers";
let budget: SharedPace | null = null;       // shared by every build running now
let profileSaved = false;                  // coalesce overlapping builds into one cleanup
function rememberedWorkers(): number | null {
  try { const n = Number(localStorage.getItem(WORKERS_KEY)); return n > 0 ? n : null; } catch { return null; }
}

function prepareQuickGames(slot: Slot, username: string, timeClass: string, signal: AbortSignal): Promise<Game[]> {
  if (!slot.quickGames) {
    slot.quickGames = fetchGames(username, QUICK, timeClass, signal).then(games => {
      signal.throwIfAborted();
      slot.archive = { games, rows: withExpected(games) };
      return games;
    });
    // The build reports a failure itself; the recap only reads `slot.archive`.
    void slot.quickGames.catch(() => {});
  }
  return slot.quickGames;
}

function build(slot: Slot, key: string, username: string, timeClass: string, games: number) {
  slot.progress = `Analyzing ${username}'s last ${games} ${timeClass} games…`;
  const abort = slot.abort = new AbortController();
  const max = defaultWorkers();
  if (!budget) budget = new SharedPace(new Pace({ max, start: startingWorkers(max, rememberedWorkers()) }));
  const shared = budget, share = shared.join();
  let completed: Profile | null = null;
  slot.building = analyzeInBrowser({ username, games, timeClass, depth: 8, engineUrl: ENGINE_URL, pace: share,
    signal: abort.signal,
    prefetchedGames: games === QUICK ? prepareQuickGames(slot, username, timeClass, abort.signal) : undefined,
    onProgress: (_s, _f, text) => { slot.progress = text; } })
    .then(async run => {
      if (abort.signal.aborted) return;
      const profile: Profile = { username: run.username, timeClass, rows: run.gameRows, openings: run.openings,
                                 tactics: run.tactics, games: run.games };
      await saveProfile(key, { profile, games, savedAt: Date.now() });
      completed = profile;
    })
    .catch(e => { if (!abort.signal.aborted && !slot.profile) slot.error = (e as Error).message; })
    .finally(() => {
      if (slot.abort === abort) {
        slot.building = null;
        // Publish together with clearing the build. Otherwise a recap can finish polling
        // while the quick save is still in progress and never request the 150-game refresh.
        if (completed && !abort.signal.aborted) {
          slot.profile = completed; slot.games = games; slot.refreshed = true;
          slot.quickGames = undefined;
          slot.archive = undefined;
          profileSaved = true;
        }
      }
      share.leave();
      if (shared.builds === 0 && budget === shared) {
        // the last build running: remember the count for the next one on this device
        budget = null;
        if (!abort.signal.aborted) { try { localStorage.setItem(WORKERS_KEY, String(shared.pace.remember)); } catch { /* not remembered */ } }
        if (profileSaved) scheduleStorageCleanup(pendingWork.signal);
        profileSaved = false;
      }
    });
}

/** Start or report the profile for this player and time class; null when one is ready to use.
 *  Order of preference: the one in memory, the saved one, a quick 50-game build. Whichever is
 *  used, a full refresh then runs in the background (until the next game stops it). */
async function ensureProfile(username: string, timeClass: string, signal: AbortSignal, startNow = true): Promise<Reply | null> {
  const key = `${username.toLowerCase()}|${timeClass}`;
  const switched = key !== currentProfile;
  currentProfile = key;
  if (!checkedStorageAtStartup) {
    checkedStorageAtStartup = true;
    scheduleStorageCleanup(signal);
  }
  let s = slots.get(key);
  if (!s) slots.set(key, s = { profile: null, games: 0, building: null, progress: "Starting…", error: "", refreshed: false });
  if (s.error) { const message = s.error; slots.delete(key); return { status: "error", message }; }
  if (switched && s.profile) void touchProfile(key);
  if (!s.profile && !s.building) {
    const slot = s;
    slot.loading ??= loadProfile(key).finally(() => { slot.loading = undefined; });
    const saved = await slot.loading;
    signal.throwIfAborted();
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
  const signal = pendingWork.signal;
  try {
    if (req.type === "page-state") return { status: "ready" }; // dev harness
    if (req.type === "stop") {
      pendingWork.abort();
      pendingWork = new AbortController();
      profileSaved = false;
      jobs.clear();
      // abort any build; a profile already in use (even a 50-game one) is kept
      for (const [key, slot] of slots) {
        if (slot.building) {
          slot.abort?.abort();
          slot.building = null;
        }
        if (!slot.profile) slots.delete(key);
      }
      return { status: "ready" };
    }
    if (req.type === "stalls") { budget?.pace.stall(); return { status: "ready" }; }
    if (req.type === "pace") {
      return { status: "pace", workers: budget ? budget.pace.active() : null, max: defaultWorkers(), remembered: rememberedWorkers() };
    }
    if (req.type === "rate") {
      // the cube's script does without chess.js, so the find rate is worked out here
      return { status: "rates", rates: Object.fromEntries(req.items.map(i => [i.id, reviewFindRate(i)])) };
    }
    if (req.type === "seed") {
      // from the finished profiles (in memory, or saved for the player's main time class)
      const u = req.username.toLowerCase();
      const profiles = [...slots.entries()].filter(([k, s]) => k.startsWith(`${u}|`) && s.profile).map(([, s]) => s.profile!);
      if (!profiles.length && mainClass.has(u)) {
        const saved = await loadProfile(`${u}|${mainClass.get(u)}`);
        if (saved) profiles.push(saved.profile);
      }
      const items = itemsFromBlunders(profiles.flatMap(p => p.tactics?.blunders ?? []),
        profiles.flatMap(p => p.games ?? []), Date.now());
      return { status: "seed", items };
    }
    if (req.type === "warm") {
      // between games: get the profile for the time class this player plays most ready in advance
      const u = req.username.toLowerCase();
      if (!mainClass.has(u)) {
        const recent = await fetchGames(req.username, 40, null, signal);
        signal.throwIfAborted();
        const counts = new Map<string, number>();
        for (const g of recent) counts.set(g.timeClass, (counts.get(g.timeClass) ?? 0) + 1);
        const top = [...counts.entries()].filter(([c]) => c !== "daily").sort((a, b) => b[1] - a[1])[0];
        if (!top) return { status: "ready" };
        mainClass.set(u, top[0]);
      }
      return (await ensureProfile(req.username, mainClass.get(u)!, signal)) ?? { status: "ready" };
    }
    const key = `${req.username.toLowerCase()}|${req.gameId}`;
    // Fair-play guard: only a game Chess.com reports as finished. Its game endpoint does not even
    // serve a live game until it is over.
    const finished = new Set(req.callback.game.isFinished ? [String(req.callback.game.id)] : []);
    if (!canShowRecap(req.gameId, finished)) return { status: "pending" };
    let job = jobs.get(key);
    const probe = job?.game ?? gameFromCallback(req.callback, req.username, req.kind, []);
    if (!probe) return { status: "pending" };
    const slotKey = `${req.username.toLowerCase()}|${probe.timeClass}`;
    const previousArchive = slots.get(slotKey)?.archive;
    // Keep the finished game's search ahead of the profile build and the player's archive, which
    // the quick build reads first. The recap shows the archive's details before the patterns.
    const p = await ensureProfile(req.username, probe.timeClass, signal, !!(job?.analysis || job?.error));
    signal.throwIfAborted();
    const slot = slots.get(slotKey);
    const profile = p === null ? slot!.profile! : null, games = profile ? slot!.games : 0;
    const done = recaps.get(key);                // reuse a recap unless the profile has grown since
    if (done && (done.games >= games || !profile)) {
      rememberRecap(recaps, key, done);
      return { status: "recap", recap: done.recap, games: done.games };
    }
    job = jobs.get(key) ?? startJob(key, probe, signal);
    const archive = slot?.archive ?? previousArchive;
    const openingGames = profile?.games ?? archive?.games;
    const game = openingGames ? nameCallbackOpening(job.game, openingGames) : job.game;
    const note = game.opponent && job.opponentGames && !game.family.startsWith("ECO ")
      ? opponentNote(game.opponent, job.opponentGames, game.family, game.color === "white" ? "black" : "white") : null;
    const a = job.analysis, err = job.error;
    const empty: GameAnalysis = { url: game.url, color: game.color, moves: [], opening_eval: null };
    const recap = buildRecap(game, a?.analysis ?? empty, a?.blunders ?? [],
      profile?.rows ?? archive?.rows ?? [], profile?.tactics ?? null, note, null);
    if (profile && (a || err) && job.opponentDone) {
      jobs.delete(key);
      if (err) {
        // keep everything else; the next visit to this game tries the analysis again
        recap.turningError = err;
        return { status: "recap", recap, games, partial: "Reopen this game to try the analysis again.", retry: false };
      }
      rememberRecap(recaps, key, { recap, games });
      return { status: "recap", recap, games };
    }
    recap.pending = { turning: !a && !err, history: !profile && !archive };
    if (err) recap.turningError = err;
    const failed = p?.status === "error" ? p.message : "";
    const partial = failed ? `Your patterns could not be loaded (${failed}).`
      : !a && !err ? "Stockfish is analyzing this game."
      : !profile ? `Adding your patterns. ${p?.status === "building" ? p.progress : ""}`.trim()
      : "Reading your opponent's recent games…";
    // a failed history load is final for now; anything else is still on its way
    if (failed && (a || err)) jobs.delete(key);
    return { status: "recap", recap, games, partial, retry: !(failed && (a || err)) };
  } catch (e) {
    const message = signal.aborted ? "Analysis was paused. Reopen this finished game to try again." : (e as Error).message;
    return { status: "error", message };
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
  if (typeof __CC_PROFILE__ !== "undefined" && __CC_PROFILE__) {
    // A cold 150-game build uses the same path as the refresh, with no preceding 50-game cache.
    Object.assign(window, { __ccProfile: async (username: string, games: number, callback: Callback) => {
      const finished = gameFromCallback(callback, username, "live", []);
      if (!finished) throw new Error("Profiling requires a finished game from the archive player");
      const slot: Slot = { profile: null, games: 0, building: null, progress: "", error: "", refreshed: false };
      const started = performance.now();
      performance.mark("cc:build start");
      build(slot, `${username.toLowerCase()}|${finished.timeClass}`, username, finished.timeClass, games);
      await slot.building;
      performance.mark("cc:build end");
      performance.measure("cc:build", { start: started });
      const profile: Profile | null = slot.profile;
      if (!profile || profile.games?.length !== games) throw new Error(slot.error || `Expected ${games} archived games`);

      // Measure one finished recap separately, after the build's IndexedDB save and outside its window.
      const game = nameCallbackOpening(finished, profile.games);
      const { analysis, blunders } = await analyzeGame(game, ENGINE_URL);
      const recap = buildRecap(game, analysis, blunders, profile.rows, profile.tactics, null, null);
      const turning = recap.turning;
      if (!turning?.best || !moveFeatures(turning.fen, turning.best)) {
        throw new Error("The fixture did not exercise find-rate features");
      }
      return { games: profile.games.length, plies: profile.games.reduce((n, g) => n + g.moves.length, 0) };
    } });
  }
}
