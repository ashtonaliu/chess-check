// Watches the site's rendered chess board on a finished-game review page (`here` mode) and
// reports the player's first candidate move from the review position.
//
// Fair play: `canWatchBoard` enforces `reviewAllowed` (which rejects play pages and unfinished
// games) plus active review-card `here` state. `readBoard` is never called unless `canWatchBoard`
// is true, and all observers are disconnected when the card changes, panel closes, or page moves.
import { candidateMovesFromDiff, type BoardReading } from "../browser/boardPlacement";
import { reviewAllowed, type ReviewCard, type State, type View } from "./panelModel";

export interface WatchContext {
  pageUrl: string;
  state: State;
  view: View;
  panelOpen: boolean;
  card: ReviewCard | null;
  alreadyGraded: boolean;
}

/** True only on a confirmed finished-game page with an open, ungraded review card in `here` mode. */
export function canWatchBoard(ctx: WatchContext): boolean {
  if (!ctx.panelOpen || ctx.view !== "review" || ctx.alreadyGraded) return false;
  if (!reviewAllowed(ctx.pageUrl, ctx.state)) return false;
  if (!ctx.card || ctx.card.kind !== "card" || !ctx.card.here) return false;
  return !!ctx.card.item.fen;
}

export interface BoardWatcherDeps {
  doc: Document;
  readBoard: (doc: Document) => BoardReading | null;
  createObserver?: (cb: MutationCallback) => Pick<MutationObserver, "observe" | "disconnect">;
  onCandidateMove: (itemId: string, placement: string) => void;
}

export class BoardWatcher {
  private observer: Pick<MutationObserver, "observe" | "disconnect"> | null = null;
  private observedTarget: Node | null = null;
  private activeId: string | null = null;
  private activeFen = "";
  private startPlacement = "";
  private sawStart = false;
  private inFlight = false;
  private lastSentPlacement = "";

  constructor(private readonly deps: BoardWatcherDeps) {}

  get active(): boolean {
    return this.activeId !== null;
  }

  /** Synchronize the observer with the current panel/card state. Stops immediately when disallowed. */
  sync(ctx: WatchContext): void {
    if (!canWatchBoard(ctx) || !ctx.card || ctx.card.kind !== "card" || !ctx.card.item.fen) {
      this.stop();
      return;
    }
    const { id, fen } = ctx.card.item;
    if (this.activeId !== id || this.activeFen !== fen) {
      this.stop();
      this.activeId = id;
      this.activeFen = fen;
      this.startPlacement = fen.trim().split(/\s+/)[0] ?? "";
      this.sawStart = false;
      this.inFlight = false;
      this.lastSentPlacement = "";
    }
    this.inspect();
  }

  /** Allow watching again after offscreen confirms a board change was not a legal single move. */
  resume(itemId: string): void {
    if (this.activeId === itemId) this.inFlight = false;
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.observedTarget = null;
    this.activeId = null;
    this.activeFen = "";
    this.startPlacement = "";
    this.sawStart = false;
    this.inFlight = false;
    this.lastSentPlacement = "";
  }

  private ensureObserver(target: Node): void {
    if (this.observedTarget === target && this.observer) return;
    this.observer?.disconnect();
    const make = this.deps.createObserver
      ?? (typeof MutationObserver !== "undefined" ? (cb: MutationCallback) => new MutationObserver(cb) : null);
    if (!make) return;
    this.observer = make(() => this.inspect());
    this.observedTarget = target;
    this.observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  }

  private inspect(): void {
    if (!this.activeId || this.inFlight) return;
    const reading = this.deps.readBoard(this.deps.doc);
    if (!reading) {
      const root = this.deps.doc.body ?? this.deps.doc.documentElement;
      if (root) this.ensureObserver(root);
      return;
    }
    this.ensureObserver(reading.element);
    if (reading.placement === this.startPlacement) {
      this.sawStart = true;
      this.lastSentPlacement = "";
      return;
    }
    if (!this.sawStart || reading.placement === this.lastSentPlacement) return;
    if (!candidateMovesFromDiff(this.activeFen, reading.placement).length) return;
    this.inFlight = true;
    this.lastSentPlacement = reading.placement;
    this.deps.onCandidateMove(this.activeId, reading.placement);
  }
}
