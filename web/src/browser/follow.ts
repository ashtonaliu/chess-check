// Follow mode: watch a player's Chess.com games and build a recap for each one
// as soon as it is finished. Only finished games appear in the public API, so
// nothing here can run during a game.
import { analyseGames, defaultWorkers, recheckBlunders } from "./engine";
import { fetchGames, type Game } from "./games";
import { defaultSite, siteForId } from "./sites";
import { buildRecap, opponentNote, type Recap } from "./recap";
import type { GameRow } from "./stats";
import { classifyGame, type TacticSummary } from "./tactics";

export interface Profile {
  username: string; timeClass: string | null;
  rows: GameRow[]; openings: { family: string; color: string; verdict: string }[]; tactics: TacticSummary | null;
  games?: Game[];        // the games behind the profile (used to name openings for endpoint games)
}

export const POLL_MS = 45_000;
export const MAX_ATTEMPTS = 3;   // tries per game before a recap that keeps failing is skipped

export class Follower {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Set<string>();
  private failures = new Map<string, number>();
  private busy = false;
  private stopped = false;
  lastChecked: Date | null = null;

  private site = siteForId(this.profile.games?.[0]?.site) ?? defaultSite;

  constructor(private profile: Profile, private engineUrl: string,
              private onRecap: (r: Recap, isNew: boolean) => void,
              private onStatus: (msg: string) => void,
              private fetch: typeof fetchGames = fetchGames) {
    for (const r of profile.rows) this.seen.add(r.url);
  }

  /** Recap the most recent game right away, then check for new ones every POLL_MS. Stopping at any
   *  point is final: nothing is shown and no polling starts after stop(). */
  async start() {
    const [latest] = await this.fetch(this.profile.username, 1, this.profile.timeClass, undefined, this.site);
    if (this.stopped) return;
    if (latest) {
      this.seen.add(latest.url);   // an old game: shown once if it works, never retried
      try {
        const r = await this.recap(latest);
        if (this.stopped) return;
        this.onRecap(r, false);
      } catch (e) {
        if (this.stopped) return;
        this.onStatus(`Could not recap your last game (${(e as Error).message}). Watching for new ones.`);
      }
    }
    this.lastChecked = new Date();
    this.timer = setInterval(() => { void this.check(); }, POLL_MS);
    this.onStatus("watching");
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onStatus("stopped");
  }

  get running() { return this.timer !== null; }

  async check() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const recent = await this.fetch(this.profile.username, 5, this.profile.timeClass, undefined, this.site);
      if (this.stopped) return;
      this.lastChecked = new Date();
      const fresh = recent.filter(g => !this.seen.has(g.url)).sort((a, b) => a.endTime - b.endTime);
      let failed = false;
      for (const g of fresh) {
        this.onStatus(`New game against ${g.opponent ?? "an opponent"} found. Analyzing…`);
        try {
          const r = await this.recap(g);
          if (this.stopped) return;
          this.seen.add(g.url);    // only once its recap is delivered
          this.onRecap(r, true);
        } catch (e) {
          if (this.stopped) return;
          const n = (this.failures.get(g.url) ?? 0) + 1;
          this.failures.set(g.url, n);
          if (n >= MAX_ATTEMPTS) this.seen.add(g.url);
          failed = true;
          this.onStatus(`Could not analyze the game against ${g.opponent ?? "your opponent"} (${(e as Error).message}).` +
            (n >= MAX_ATTEMPTS ? " Skipping it." : " Will try again."));
        }
      }
      if (!failed) this.onStatus("watching");
    } catch (e) {
      if (!this.stopped) this.onStatus(`Could not reach ${this.site.name} (${(e as Error).message}). Will try again.`);
    } finally {
      this.busy = false;
    }
  }

  /** Analyze one finished game and read it against the profile. */
  recap(g: Game): Promise<Recap> {
    return recapGame(g, this.profile, this.engineUrl);
  }
}

/** Stockfish on one finished game, with the player's blunders confirmed deeper (several at once)
 *  and classified. The opponent's are left to the profile build, which reuses these positions. */
export async function analyzeGame(g: Game, engineUrl: string, signal?: AbortSignal) {
  const [analysis] = await analyseGames([g], { depth: 8, engineUrl, signal, workers: 1 });
  await recheckBlunders([analysis], { engineUrl, signal, workers: Math.min(defaultWorkers(), 4), only: m => m.is_me });
  return { analysis, blunders: classifyGame(g.pgn, analysis) };
}

/** The post-game line about the opponent in this opening, or null if their games cannot be read. */
export function opponentNoteFor(g: Game, timeClass: string | null): Promise<string | null> {
  const opponent = g.opponent;
  if (!opponent) return Promise.resolve(null);
  return fetchGames(opponent, 100, g.timeClass || timeClass, undefined, siteForId(g.site) ?? defaultSite)
    .then(games => opponentNote(opponent, games.filter(game => game.url !== g.url),
      g.family, g.color === "white" ? "black" : "white"))
    .catch(() => null);
}

/** Analyze one finished game and read it against a player's profile. */
export async function recapGame(g: Game, profile: Profile, engineUrl: string): Promise<Recap> {
  const note = opponentNoteFor(g, profile.timeClass);
  const { analysis, blunders } = await analyzeGame(g, engineUrl);
  return buildRecap(g, analysis, blunders, profile.rows, profile.tactics, await note);
}
