// Follow mode: watch a player's Chess.com games and build a recap for each one
// as soon as it is finished. Only finished games appear in the public API, so
// nothing here can run during a game.
import { analyseGames, recheckBlunders } from "./engine";
import { fetchGames, type Game } from "./games";
import { buildRecap, opponentNote, type Recap } from "./recap";
import type { GameRow } from "./stats";
import { classifyGame, type TacticSummary } from "./tactics";
import { loadWasmClassifier } from "./tacticsWasm";

export interface Profile {
  username: string; timeClass: string | null;
  rows: GameRow[]; openings: { family: string; color: string; verdict: string }[]; tactics: TacticSummary | null;
}

export const POLL_MS = 45_000;

export class Follower {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Set<string>();
  private busy = false;
  lastChecked: Date | null = null;

  constructor(private profile: Profile, private engineUrl: string,
              private onRecap: (r: Recap, isNew: boolean) => void,
              private onStatus: (msg: string) => void) {
    for (const r of profile.rows) this.seen.add(r.url);
  }

  /** Recap the most recent game right away, then check for new ones every POLL_MS. */
  async start() {
    const [latest] = await fetchGames(this.profile.username, 1, this.profile.timeClass);
    if (latest) { this.seen.add(latest.url); this.onRecap(await this.recap(latest), false); }
    this.lastChecked = new Date();
    this.timer = setInterval(() => { void this.check(); }, POLL_MS);
    this.onStatus("watching");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onStatus("stopped");
  }

  get running() { return this.timer !== null; }

  async check() {
    if (this.busy) return;
    this.busy = true;
    try {
      const recent = await fetchGames(this.profile.username, 5, this.profile.timeClass);
      this.lastChecked = new Date();
      const fresh = recent.filter(g => !this.seen.has(g.url)).sort((a, b) => a.endTime - b.endTime);
      for (const g of fresh) {
        this.seen.add(g.url);
        this.onStatus(`New game against ${g.opponent ?? "an opponent"} found. Analyzing…`);
        this.onRecap(await this.recap(g), true);
      }
      this.onStatus("watching");
    } catch (e) {
      this.onStatus(`Could not reach Chess.com (${(e as Error).message}). Will try again.`);
    } finally {
      this.busy = false;
    }
  }

  /** Analyze one finished game and read it against the profile. */
  recap(g: Game): Promise<Recap> {
    return recapGame(g, this.profile, this.engineUrl);
  }
}

/** Analyze one finished game and read it against a player's profile. */
export async function recapGame(g: Game, profile: Profile, engineUrl: string): Promise<Recap> {
  const [analysis] = await analyseGames([g], { depth: 8, engineUrl, workers: 1 });
  await recheckBlunders([analysis], { engineUrl, workers: 1 });
  const blunders = classifyGame(g.pgn, analysis, await loadWasmClassifier(engineUrl));
  let note: string | null = null;
  if (g.opponent) {
    try {
      const opp = await fetchGames(g.opponent, 100, g.timeClass || profile.timeClass);
      note = opponentNote(g.opponent, opp.filter(x => x.url !== g.url), g.family, g.color === "white" ? "black" : "white");
    } catch { note = null; }
  }
  return buildRecap(g, analysis, blunders, profile.rows, profile.openings, profile.tactics, note);
}
