// What the cube and its panel show, as plain functions of the extension's state, the address and
// what is stored. content.ts draws the result and talks to Chess.com and the analysis page; every
// decision about what to show lives here, so it can be tested without a browser
// (test/panelModel.test.ts).
import { gameId } from "../browser/recap";
import { dueItems, nextDue, type ReviewItem } from "../browser/reviewQueue";
import { canReview, gameIdFromPage } from "./guard";

// "finished": a finished game opened from the review queue, whose own recap is not asked for
// unless you want it (so reviewing does not run Stockfish on every old game).
export type State = "idle" | "loading" | "choose" | "pending" | "building" | "ready" | "finished" | "error";
export type View = "game" | "review";

export const LIVE_POLL_MS = 5_000;     // how often to ask whether a live game has ended
export const DAILY_POLL_MS = 60_000;
const DAY = 86_400_000;

/** How long to wait before asking again whether a game in progress has ended. */
export const pollDelay = (pageUrl: string) => (/\/daily\//.test(new URL(pageUrl).pathname) ? DAILY_POLL_MS : LIVE_POLL_MS);

/** Fair play: the queue only where canReview allows it, and on a game page only once Chess.com has
 *  confirmed the game is over (the recap, the player choice, or a game opened from the queue). */
export const reviewAllowed = (pageUrl: string, state: State) =>
  canReview(pageUrl, state === "ready" || state === "finished" || state === "choose");

/** Positions to ask now, or none where the queue may not be shown. */
export const dueNow = (queue: ReviewItem[], pageUrl: string, state: State, now: number) =>
  reviewAllowed(pageUrl, state) ? dueItems(queue, now) : [];

export interface CubeLook { classes: string[]; title: string; count: string }

/** The cube: green with a dot for a recap you have not opened, blue while setting up, a dot while
 *  asking which player you are, and the number of positions due away from game pages. */
export function cubeLook(state: State, pageUrl: string, dueCount: number, seen: boolean): CubeLook {
  const classes = state === "ready" ? ["ready", ...(seen ? ["seen"] : [])]
    : state === "building" ? ["building"] : state === "choose" ? ["choose"] : [];
  const n = gameIdFromPage(pageUrl) || state !== "idle" ? 0 : dueCount;
  if (n > 0) classes.push("due");
  const title = state === "ready" ? "Chess Check: your recap is ready"
    : state === "choose" ? "Chess Check: which player are you?"
    : n > 0 ? `Chess Check: ${n} position${n === 1 ? "" : "s"} to review` : "Chess Check";
  return { classes, title, count: n > 9 ? "9+" : String(n) };
}

/** Which view the panel shows: the review when asked for (where allowed), or when there is nothing
 *  else to show on a page that is not a game. */
export function panelView(view: View, state: State, pageUrl: string, dueCount: number): View {
  if (view === "game" && state === "idle" && dueCount > 0) return "review";
  return view === "review" && reviewAllowed(pageUrl, state) ? "review" : "game";
}

export const daysAgo = (endTimeSec: number, now: number) => {
  const d = Math.floor((now / 1000 - endTimeSec) / 86_400);
  return d < 1 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

/** "Next review tomorrow." when nothing is due now; empty when something is due, nothing is left,
 *  or the queue may not be shown here. */
export function whenNext(queue: ReviewItem[], now: number, allowed: boolean): string {
  const t = nextDue(queue);
  if (t === null || t <= now || !allowed) return "";
  const days = Math.ceil((t - now) / DAY);
  return days <= 1 ? "Next review tomorrow." : `Next review in ${days} days.`;
}

export type ReviewCard =
  | { kind: "done"; summary: string; back: "back" | "show" | null }
  | { kind: "card"; item: ReviewItem; position: number; total: number; here: boolean; back: "back" | "show" | null };

/**
 * The review panel: the current position (or the first due), whether Chess.com's board already
 * shows it (then "Find it on the board" is left out), and the way back to a recap. "Back" returns
 * to a recap you came from. "Show" offers the recap of the game on screen only under that game's
 * own card or the done message, so it is not mistaken for another card's game.
 */
export function reviewCard(due: ReviewItem[], current: string | null, state: State, hasRecap: boolean, pageUrl: string,
                           tally: { found: number; missed: number }, next: string): ReviewCard {
  const item = due.find(q => q.id === current) ?? due[0] ?? null;
  const onScreen = gameIdFromPage(pageUrl);
  const back = state === "ready" && hasRecap ? "back"
    : state === "finished" && (!item || gameId(item.url) === onScreen) ? "show" : null;
  if (!item) {
    const summary = tally.found + tally.missed ? `That's all for now: ${tally.found} found, ${tally.missed} missed.` : "Nothing to review right now.";
    return { kind: "done", summary: next ? `${summary} ${next}` : summary, back };
  }
  const here = onScreen === gameId(item.url) && new URL(pageUrl).searchParams.get("move") === String(item.ply);
  return { kind: "card", item, position: due.indexOf(item) + 1, total: due.length, here, back };
}

export type AfterLookup =
  | { next: "pending"; delay: number }
  | { next: "choose" }
  | { next: "review"; viewer: string; item: string }
  | { next: "recap"; viewer: string };

/**
 * What to do once Chess.com's game endpoint has answered for the game on the page: wait (no game
 * yet, or not finished), ask which player you are, reopen the review the page was opened for, or
 * ask for the recap.
 */
export function afterLookup(game: { finished: boolean; white: string; black: string } | null, pageUrl: string,
                            signedIn: string | null, accounts: string[], reviewing: string | null): AfterLookup {
  if (!game || !game.finished) return { next: "pending", delay: pollDelay(pageUrl) };
  const me = signedIn?.toLowerCase();
  const viewer = [game.white, game.black].find(n => me ? n.toLowerCase() === me : accounts.includes(n.toLowerCase()));
  if (!viewer) return { next: "choose" };
  return reviewing ? { next: "review", viewer, item: reviewing } : { next: "recap", viewer };
}

// ---------- markers kept across page loads (sessionStorage, per tab) ----------

export type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const REOPEN = "chess-check-reopen";   // "Find it on the board" from a recap: reopen it
export const REVIEW = "chess-check-review";   // the review position the page was opened at
export const SEEN = "chess-check-seen";       // recaps already opened in this tab

const safe = <T>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };

/** Remember, as a page is left from the panel's "Find it on the board", what to reopen. */
export function markFind(store: Store, view: View, gameOnPage: string | null, reviewItem: string | null) {
  safe(() => {
    if (view === "review" && reviewItem) store.setItem(REVIEW, reviewItem);
    else if (view === "game" && gameOnPage) store.setItem(REOPEN, gameOnPage);
  }, undefined);
}

/** Whether the recap for this game should open by itself (once). */
export const takeReopen = (store: Store, id: string | null): boolean => safe(() => {
  if (!id || store.getItem(REOPEN) !== id) return false;
  store.removeItem(REOPEN);
  return true;
}, false);

/** The review position this game's page was opened for (once), or null. */
export const takeReview = (store: Store, id: string | null): string | null => safe(() => {
  const item = store.getItem(REVIEW);
  if (!id || !item || !item.startsWith(`${id}:`)) return null;
  store.removeItem(REVIEW);
  return item;
}, null);

export const wasSeen = (store: Store, id: string | null): boolean =>
  safe(() => !!id && (store.getItem(SEEN) ?? "").split(",").includes(id), false);

export function markSeen(store: Store, id: string | null) {
  if (!id || wasSeen(store, id)) return;
  safe(() => store.setItem(SEEN, [...(store.getItem(SEEN) ?? "").split(",").filter(Boolean).slice(-20), id].join(",")), undefined);
}
