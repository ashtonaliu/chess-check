import type { LichessExport } from "../browser/lichess";
import { nextStatusCheckDelayMs, readStatusOnly, STATUS_CHECK_INTERVAL_MS } from "./lichessGuard";

type Wait = { status: "wait"; retryAfterMs: number };
type Failure = { status: "error"; message: string };
export type LichessStatusReply = Wait | Failure | { status: "pending" | "aborted" }
  | { status: "finished"; evidence: LichessExport };
export type LichessHistoryReply = Wait | Failure | { status: "history"; text: string };
export interface LichessHistoryRequest { user: string; timeClass: string | null; max: number; color?: "white" | "black" }

const ORIGIN = "https://lichess.org";
const STANDARD_PERF_TYPES = "ultraBullet,bullet,blitz,rapid,classical,correspondence";
export const LICHESS_COOLDOWN_KEY = "lichess-api-cooldown";

export function historyUrl({ user, timeClass, max, color }: LichessHistoryRequest): URL {
  const url = new URL(`/api/games/user/${encodeURIComponent(user)}`, ORIGIN);
  // Lichess applies max before our parser can drop variants and custom starts.
  const perfType = timeClass === "daily" ? "correspondence" : timeClass || STANDARD_PERF_TYPES;
  url.search = new URLSearchParams({ max: String(max), clocks: "true", opening: "true",
    ongoing: "false", finished: "true", perfType, ...(color ? { color } : {}) }).toString();
  return url;
}

function exportUrl(id: string, details: boolean): URL {
  const url = new URL(`/game/export/${id}`, ORIGIN);
  url.search = new URLSearchParams({ moves: String(details), clocks: String(details), opening: String(details),
    evals: "false" }).toString();
  return url;
}

/** Allow only the fields needed by the parser across the messaging boundary. */
function finishedEvidence(game: LichessExport): LichessExport {
  const { id, status, variant, speed, createdAt, lastMoveAt, winner, initialFen, moves, clocks,
    daysPerTurn, clock, opening, players } = game;
  const player = (p?: NonNullable<LichessExport["players"]>["white"]) => p && ({
    user: p.user && { name: p.user.name, id: p.user.id }, rating: p.rating,
  });
  return { id, status, variant, speed, createdAt, lastMoveAt, winner, initialFen, moves, clocks, daysPerTurn,
    clock: clock && { initial: clock.initial, increment: clock.increment },
    opening: opening && { eco: opening.eco, name: opening.name },
    players: { white: player(players?.white), black: player(players?.black) } };
}

/** Owns every Lichess request and keeps the slot until the response body has been consumed. */
export class LichessRequests {
  private tail = Promise.resolve();
  private queued = 0;
  private cooldownUntil = 0;
  private readonly lastCheck = new Map<number, number>();
  private histories = new AbortController();

  constructor(private readonly saveCooldown: (until: number) => Promise<void>,
              private readonly now = Date.now, private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  restoreCooldown(until: unknown) {
    if (typeof until === "number") this.cooldownUntil = Math.max(this.cooldownUntil, until);
  }

  forgetTab(tab: number) { this.lastCheck.delete(tab); }

  stopHistory() {
    this.histories.abort();
    this.histories = new AbortController();
  }

  private wait(delay = 0): Wait | null {
    const retryAfterMs = Math.max(this.cooldownUntil - this.now(), delay);
    return retryAfterMs > 0 ? { status: "wait", retryAfterMs } : null;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.queued++;
    const next = this.tail.then(task).finally(() => { this.queued--; });
    this.tail = next.then(() => {}, () => {});
    return next;
  }

  private async request(url: URL, accept: string, signal: AbortSignal): Promise<Response | Wait> {
    const response = await this.fetcher(url, { headers: { Accept: accept }, credentials: "omit", redirect: "error", signal });
    if (response.status !== 429) return response;
    const retryAfterMs = nextStatusCheckDelayMs(429, 0);
    this.cooldownUntil = this.now() + retryAfterMs;
    await this.saveCooldown(this.cooldownUntil).catch(() => {});
    await response.body?.cancel().catch(() => {});
    return { status: "wait", retryAfterMs };
  }

  check(tab: number, id: string): Promise<LichessStatusReply> {
    const elapsed = this.now() - (this.lastCheck.get(tab) ?? -Infinity);
    const wait = this.wait(nextStatusCheckDelayMs(null, elapsed));
    if (wait) return Promise.resolve(wait);
    if (this.queued) return Promise.resolve({ status: "wait", retryAfterMs: STATUS_CHECK_INTERVAL_MS });
    return this.enqueue(async () => {
      this.lastCheck.set(tab, this.now());
      const signal = AbortSignal.timeout(12_000);
      try {
        const peek = await this.export(id, false, signal);
        if ("status" in peek) return peek;
        const reply = await this.export(id, true, signal);
        if ("status" in reply) return reply;
        return { status: "finished", evidence: finishedEvidence(reply.game) };
      } catch {
        return { status: "pending" };
      }
    });
  }

  private async export(id: string, details: boolean, signal: AbortSignal):
    Promise<{ game: LichessExport } | Wait | { status: "pending" | "aborted" }> {
    const response = await this.request(exportUrl(id, details), "application/json", signal);
    if (!(response instanceof Response)) return response;
    if (!response.ok) {
      await response.body?.cancel();
      return { status: "pending" };
    }
    const game: unknown = await response.json();
    const status = readStatusOnly(game);
    if (status === "pending") return { status };
    if ((game as LichessExport).id !== id) return { status: "pending" };
    return status === "finished" ? { game: game as LichessExport } : { status };
  }

  history(request: LichessHistoryRequest): Promise<LichessHistoryReply> {
    const owner = this.histories.signal;
    return this.enqueue(async () => {
      owner.throwIfAborted();
      const wait = this.wait();
      if (wait) return wait;
      const response = await this.request(historyUrl(request), "application/x-ndjson",
        AbortSignal.any([owner, AbortSignal.timeout(25_000)]));
      if (!(response instanceof Response)) return response;
      if (response.ok) return { status: "history", text: await response.text() };
      await response.body?.cancel();
      return { status: "error", message: response.status === 404
        ? `No Lichess player named "${request.user}".` : `Lichess API error ${response.status}.` };
    });
  }
}
