// How many Stockfish workers a background profile build uses, adjusted to the device over time.
//
// A build starts at the count remembered on this device, or at the usual count (every core but one,
// up to 8). When the page you are on stutters (reported by the cube), it drops a worker for the rest
// of the build, and the lower count is remembered. A build that finishes without any stutter raises
// the remembered count by one, up to the usual count, so a device that was only busy for a while
// recovers. Builds the player is waiting on (the website, a recap's own game) keep their fixed count.
//
// An earlier version also tried to tune the count by how fast the build was going. In testing the
// speed measured over a few seconds swung more with which positions were being searched than with
// one more or one fewer worker, so it settled on 4 workers where 8 were 67% faster; that half was
// dropped. See docs/methods.md.

export interface PaceOptions {
  max: number;                 // the usual count: every core but one, up to 8
  start: number;               // where this build starts
  now?: () => number;          // ms; injectable for tests
  stallCooldownMs?: number;    // stutters within this long count once
}

export class Pace {
  readonly max: number;
  private n: number;
  private stalled = false;
  private lastStall = -Infinity;
  private readonly now: () => number;
  private readonly cooldown: number;

  constructor(o: PaceOptions) {
    this.max = Math.max(1, o.max);
    this.n = Math.min(Math.max(1, Math.round(o.start)), this.max);
    this.now = o.now ?? (() => performance.now());
    this.cooldown = o.stallCooldownMs ?? 3000;
  }

  /** How many workers should be searching now. */
  active(): number { return this.n; }

  /** The page stuttered: one worker fewer for the rest of this build. A burst counts once. */
  stall(): void {
    const t = this.now();
    if (t - this.lastStall < this.cooldown) return;
    this.lastStall = t;
    this.stalled = true;
    this.n = Math.max(1, this.n - 1);
  }

  /** The count to remember for the next build: this one's after a stutter, else one more. */
  get remember(): number { return this.stalled ? this.n : Math.min(this.max, this.n + 1); }
}

/** Where a build starts: the count remembered on this device, else the usual count (`max`). */
export function startingWorkers(max: number, remembered: number | null): number {
  return Math.min(Math.max(1, remembered ?? max), Math.max(1, max));
}

/**
 * One worker budget for all background builds at once. Builds for different time classes can run
 * together (a blitz warm-up and a rapid recap's profile), and with a count per build they could use
 * twice the limit while only the newest heard about stutter. Each build joins with `join()`, which
 * hands it a share of the budget (the count divided by the builds running, at least one each), and
 * calls `leave()` when it ends. A stutter lowers the shared count, so every build eases off.
 */
export class SharedPace {
  private running = 0;
  constructor(readonly pace: Pace) {}
  get builds(): number { return this.running; }
  join(): { max: number; active(): number; leave(): void } {
    this.running++;
    let left = false;
    return {
      max: this.pace.max,
      active: () => Math.max(1, Math.floor(this.pace.active() / Math.max(1, this.running))),
      leave: () => { if (!left) { left = true; this.running--; } },
    };
  }
}
