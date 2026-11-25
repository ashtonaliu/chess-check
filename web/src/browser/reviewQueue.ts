// Review queue: the positions where you lost the most, brought back until you find the better
// move. Each comes from a finished game (a recap's turning point, or a blunder from the games your
// profile already analyzed), so nothing here concerns a game being played.
//
// Scheduling is a fixed ladder: found it, and the position comes back 1, 3, 7 and then 21 days
// later; after the last step it is learned and leaves the queue. Missed it, and it starts over
// tomorrow.
import { gameId } from "./ids";
import { inReviewRateRange, isReviewSpeed, type ReviewSpeed } from "./rateRange";
import type { Recap } from "./recap";
import { DEFAULT_SITE, pageSite } from "./site";
import type { BlunderRec } from "./tactics";

export const STEPS_DAYS = [1, 3, 7, 21];
const DAY = 86_400_000;
/** The most positions kept: plenty for daily review, and small in chrome.storage. */
export const MAX_ITEMS = 60;
/** How many past blunders seed an empty queue, newest first. */
export const SEED_COUNT = 5;
/** Only clear mistakes with a better move become questions (the recap's own quiz threshold). */
export const MIN_LOSS = 20;

export interface ReviewItem {
  id: string;                    // game ID and ply, so the same position is never added twice
  url: string; ply: number; label: string; san: string; best: string; loss: number;
  tactics: { kind: "allowed" | "missed"; motif: string }[];
  opponent: string; endTime: number;
  fen?: string; rating?: number;  // the position and your rating then
  neuralFindRate?: number | null; // undefined means the neural model has yet to score this card
  timeClass?: string;             // the game's time control
  step: number;                  // how many times in a row it was found
  due: number;                   // when it is next asked (ms)
  done?: boolean;                // learned: found at every step
}

export interface ReviewRateRequest {
  id: string; fen: string; best: string; rating: number; timeClass: string;
}

export const itemId = (url: string, ply: number) => `${gameId(url)}:${ply}`;
const label = (ply: number, moveNo: number, san: string) => `${moveNo}${ply % 2 === 0 ? "." : "..."}${san}`;

/** A recap's turning point, when it was a real question. The recap already asked it, so the first
 *  review is tomorrow. */
export function itemFromRecap(r: Recap, now: number): ReviewItem | null {
  const t = r.turning;
  if (!t || r.pending?.turning || t.loss < MIN_LOSS || !t.best || t.best === t.san) return null;
  return { id: itemId(r.url, t.ply), url: r.url, ply: t.ply, label: t.label, san: t.san, best: t.best, loss: t.loss,
    tactics: t.tactics, opponent: r.opponent, endTime: r.endTime, fen: t.fen, rating: r.myRating,
    timeClass: r.timeClass, step: 0, due: now + DAY };
}

/** Your worst recent blunders from an analyzed profile, due now, to start an empty queue. */
export function itemsFromBlunders(blunders: BlunderRec[], games: { url: string; opponent?: string | null; endTime: number; myRating?: number; timeClass?: string }[],
                                  now: number, limit = SEED_COUNT): ReviewItem[] {
  const byUrl = new Map(games.map(g => [g.url, g]));
  const out: ReviewItem[] = [];
  for (const b of blunders) {
    const g = byUrl.get(b.url);
    if (!g || !b.is_me || !b.best || b.best === b.san || b.wp_loss < MIN_LOSS) continue;
    out.push({ id: itemId(b.url, b.ply), url: b.url, ply: b.ply, label: label(b.ply, b.move_no, b.san), san: b.san, best: b.best,
      loss: b.wp_loss, tactics: [...b.missed.map(motif => ({ kind: "missed" as const, motif })),
                                  ...b.allowed.map(motif => ({ kind: "allowed" as const, motif }))],
      opponent: g.opponent ?? "your opponent", endTime: g.endTime, fen: b.fen, rating: g.myRating,
      timeClass: g.timeClass, step: 0, due: now });
  }
  // one per game (its worst), newest games first
  const best = new Map<string, ReviewItem>();
  for (const it of out) {
    const k = gameId(it.url), cur = best.get(k);
    if (!cur || it.loss > cur.loss) best.set(k, it);
  }
  return [...best.values()].sort((a, b) => b.endTime - a.endTime).slice(0, limit);
}

/** Fill in what older entries are missing (the position, rating and time control) from fresh copies of them. */
export function patchItems(queue: ReviewItem[], fresh: ReviewItem[]): ReviewItem[] {
  const byId = new Map(fresh.map(f => [f.id, f]));
  return queue.map(q => {
    const f = byId.get(q.id);
    if (!f) return q;
    const fen = q.fen || f.fen, rating = q.rating ?? f.rating, timeClass = q.timeClass ?? f.timeClass;
    return fen === q.fen && rating === q.rating && timeClass === q.timeClass ? q : { ...q, fen, rating, timeClass };
  });
}

/** Add positions not already in the queue. When it is full, learned ones go first, then the oldest. */
export function addItems(queue: ReviewItem[], items: ReviewItem[]): ReviewItem[] {
  const ids = new Set(queue.map(q => q.id));
  const merged = [...queue, ...items.filter(it => !ids.has(it.id) && (ids.add(it.id), true))];
  if (merged.length <= MAX_ITEMS) return merged;
  const keep = [...merged].sort((a, b) => Number(!!a.done) - Number(!!b.done) || b.endTime - a.endTime).slice(0, MAX_ITEMS);
  const kept = new Set(keep.map(k => k.id));
  return merged.filter(m => kept.has(m.id));
}

/** The find rate a position is ordered by: the model's estimate where it applies (calibrated site,
 *  speed and rating), else the typical rate in its training data, so unrated positions sit in the middle. */
export const TYPICAL_FIND_RATE = 0.79;
const reviewRateEligible = (q: ReviewItem): q is ReviewItem & { rating: number; timeClass: ReviewSpeed } =>
  isReviewSpeed(q.timeClass) && q.rating !== undefined && inReviewRateRange(q.rating, q.timeClass, pageSite(q.url)?.id ?? DEFAULT_SITE);

export const reviewRate = (q: ReviewItem): number | null =>
  reviewRateEligible(q) ? q.neuralFindRate ?? null : null;

/** Legacy logistic scores are ignored. Only request unfinished reviews the neural model can score. */
export function pendingReviewRates(queue: ReviewItem[]): ReviewRateRequest[] {
  return queue.flatMap(q => !q.done && q.neuralFindRate === undefined && q.fen && reviewRateEligible(q)
    ? [{ id: q.id, fen: q.fen, best: q.best, rating: q.rating, timeClass: q.timeClass }]
    : []);
}

/** Apply a batch to the latest saved queue without changing progress or replacing a newer score. */
export function applyReviewRates(queue: ReviewItem[], rates: Record<string, number | null>): ReviewItem[] {
  return queue.map(q => q.neuralFindRate === undefined && rates[q.id] !== undefined && reviewRateEligible(q)
    ? { ...q, neuralFindRate: rates[q.id] } : q);
}

const orderRate = (q: ReviewItem) => reviewRate(q) ?? TYPICAL_FIND_RATE;

/** Positions to ask now. Those most players at your rating find come first: missing one of those is
 *  a habit worth fixing, and it is what a short session should cover. Then the longest-waiting. */
export const dueItems = (queue: ReviewItem[], now: number) =>
  queue.filter(q => !q.done && q.due <= now)
    .sort((a, b) => orderRate(b) - orderRate(a) || a.due - b.due || b.endTime - a.endTime);

/** When the next position comes due, or null when nothing is left to learn. */
export function nextDue(queue: ReviewItem[]): number | null {
  const open = queue.filter(q => !q.done);
  return open.length ? Math.min(...open.map(q => q.due)) : null;
}

/** Record an answer: found moves it up the ladder, missed starts it over tomorrow. `shown` is the
 *  entry as the tab asked it; when the saved one has moved on since (another tab answered the same
 *  question first), the answer is dropped so one review is never counted twice. */
export function grade(queue: ReviewItem[], id: string, found: boolean, now: number,
                      shown?: Pick<ReviewItem, "step" | "due">): ReviewItem[] {
  return queue.map(q => {
    if (q.id !== id) return q;
    if (shown && (q.step !== shown.step || q.due !== shown.due || q.done)) return q;
    if (!found) return { ...q, step: 0, due: now + DAY };
    const step = q.step + 1;
    return step >= STEPS_DAYS.length ? { ...q, step, done: true, due: now }
      : { ...q, step, due: now + STEPS_DAYS[step] * DAY };
  });
}
