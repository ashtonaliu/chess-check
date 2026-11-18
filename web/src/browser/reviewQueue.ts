// Review queue: the positions where you lost the most, brought back until you find the better
// move. Each comes from a finished game (a recap's turning point, or a blunder from the games your
// profile already analyzed), so nothing here concerns a game being played.
//
// Scheduling is a fixed ladder: found it, and the position comes back 1, 3, 7 and then 21 days
// later; after the last step it is learned and leaves the queue. Missed it, and it starts over
// tomorrow.
import type { Recap } from "./recap";
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
  step: number;                  // how many times in a row it was found
  due: number;                   // when it is next asked (ms)
  done?: boolean;                // learned: found at every step
}

const gameIdOf = (url: string) => url.match(/\/(\d+)(?:[/?#]|$)/)?.[1] ?? url;
export const itemId = (url: string, ply: number) => `${gameIdOf(url)}:${ply}`;
const label = (ply: number, moveNo: number, san: string) => `${moveNo}${ply % 2 === 0 ? "." : "..."}${san}`;

/** A recap's turning point, when it was a real question. The recap already asked it, so the first
 *  review is tomorrow. */
export function itemFromRecap(r: Recap, now: number): ReviewItem | null {
  const t = r.turning;
  if (!t || r.pending?.turning || t.loss < MIN_LOSS || !t.best || t.best === t.san) return null;
  return { id: itemId(r.url, t.ply), url: r.url, ply: t.ply, label: t.label, san: t.san, best: t.best, loss: t.loss,
    tactics: t.tactics, opponent: r.opponent, endTime: r.endTime, step: 0, due: now + DAY };
}

/** Your worst recent blunders from an analyzed profile, due now, to start an empty queue. */
export function itemsFromBlunders(blunders: BlunderRec[], games: { url: string; opponent?: string | null; endTime: number }[],
                                  now: number, limit = SEED_COUNT): ReviewItem[] {
  const byUrl = new Map(games.map(g => [g.url, g]));
  const out: ReviewItem[] = [];
  for (const b of blunders) {
    const g = byUrl.get(b.url);
    if (!g || !b.is_me || !b.best || b.best === b.san || b.wp_loss < MIN_LOSS) continue;
    out.push({ id: itemId(b.url, b.ply), url: b.url, ply: b.ply, label: label(b.ply, b.move_no, b.san), san: b.san, best: b.best,
      loss: b.wp_loss, tactics: [...b.missed.map(motif => ({ kind: "missed" as const, motif })),
                                  ...b.allowed.map(motif => ({ kind: "allowed" as const, motif }))],
      opponent: g.opponent ?? "your opponent", endTime: g.endTime, step: 0, due: now });
  }
  // one per game (its worst), newest games first
  const best = new Map<string, ReviewItem>();
  for (const it of out) {
    const k = gameIdOf(it.url), cur = best.get(k);
    if (!cur || it.loss > cur.loss) best.set(k, it);
  }
  return [...best.values()].sort((a, b) => b.endTime - a.endTime).slice(0, limit);
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

/** Positions to ask now, the longest-waiting first. */
export const dueItems = (queue: ReviewItem[], now: number) =>
  queue.filter(q => !q.done && q.due <= now).sort((a, b) => a.due - b.due || b.endTime - a.endTime);

/** When the next position comes due, or null when nothing is left to learn. */
export function nextDue(queue: ReviewItem[]): number | null {
  const open = queue.filter(q => !q.done);
  return open.length ? Math.min(...open.map(q => q.due)) : null;
}

/** Record an answer: found moves it up the ladder, missed starts it over tomorrow. */
export function grade(queue: ReviewItem[], id: string, found: boolean, now: number): ReviewItem[] {
  return queue.map(q => {
    if (q.id !== id) return q;
    if (!found) return { ...q, step: 0, due: now + DAY };
    const step = q.step + 1;
    return step >= STEPS_DAYS.length ? { ...q, step, done: true, due: now }
      : { ...q, step, due: now + STEPS_DAYS[step] * DAY };
  });
}
