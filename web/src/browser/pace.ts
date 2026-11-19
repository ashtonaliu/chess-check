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
 * together (a blitz warm-up and a rapid recap's profile). The budget is a set of slots, as many as
 * the adaptive count allows: a build takes a slot before each search task and gives it back after,
 * and waits when every slot is taken, so all builds together never search on more workers than the
 * count. A stutter lowers the count, and slots given back above it stay empty. Each build joins
 * with `join()` and calls `leave()` when it ends, so the last one out can remember the count.
 */
export class SharedPace {
  private running = 0;
  private busy = 0;
  private nextOwner = 0;
  private waiting: Waiter[] = [];
  constructor(readonly pace: Pace) {}
  get builds(): number { return this.running; }
  /** Slots in use now, across every build. */
  get inUse(): number { return this.busy; }

  join(): BuildShare {
    this.running++;
    const owner = this.nextOwner++;
    let left = false;
    return {
      max: this.pace.max,
      acquire: signal => this.acquire(owner, signal),
      keep: () => this.busy <= this.pace.active() && !this.waiting.some(w => w.owner !== owner),
      release: () => this.release(owner),
      leave: () => { if (!left) { left = true; this.running--; } },
    };
  }

  private acquire(owner: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
    if (!this.waiting.length && this.busy < this.pace.active()) { this.busy++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const w: Waiter = { owner, go: resolve, signal };
      if (signal) {
        w.stop = () => {
          this.waiting = this.waiting.filter(x => x !== w);
          reject(new DOMException("Cancelled", "AbortError"));
        };
        signal.addEventListener("abort", w.stop, { once: true });
      }
      this.waiting.push(w);
    });
  }

  private release(owner: number): void {
    this.busy = Math.max(0, this.busy - 1);
    // A slot given back goes to another build when one is waiting (first come, first served among
    // them), so builds running together take turns; otherwise to this build's own next worker.
    while (this.waiting.length && this.busy < this.pace.active()) {
      const k = Math.max(0, this.waiting.findIndex(w => w.owner !== owner));
      const [w] = this.waiting.splice(k, 1);
      if (w.stop) w.signal?.removeEventListener("abort", w.stop);
      this.busy++;
      w.go();
    }
  }
}

interface Waiter { owner: number; go: () => void; signal?: AbortSignal; stop?: () => void }

/** One build's view of the shared slots. */
export interface BuildShare {
  max: number;
  acquire(signal?: AbortSignal): Promise<void>;
  /** Whether this build may keep a slot it holds for its next task: yes, unless the budget has
   *  dropped below the slots in use or another build is waiting for one. */
  keep(): boolean;
  release(): void;
  leave(): void;
}
