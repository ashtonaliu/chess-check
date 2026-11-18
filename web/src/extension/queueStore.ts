// The review queue in chrome.storage, changed safely from several Chess.com tabs at once.
//
// Each tab used to keep its own copy and save the whole list after a change, so a tab with an
// older copy could undo a grade made in another tab. Now every change is a function applied to the
// latest saved queue while holding a lock that all Chess.com tabs share (Web Locks are per origin,
// and every tab's content script runs on chess.com), and tabs refresh their copy when the stored
// queue changes.
import type { ReviewItem } from "../browser/reviewQueue";

export interface QueueDeps {
  load: (key: string) => Promise<ReviewItem[]>;
  save: (key: string, queue: ReviewItem[]) => Promise<void>;
  /** navigator.locks.request, or null where Web Locks are unavailable (then changes are not serialized). */
  lock: ((name: string, fn: () => Promise<ReviewItem[]>) => Promise<ReviewItem[]>) | null;
}

export const queueKey = (user: string) => `queue:${user.toLowerCase()}`;

/** Apply `change` to the latest saved queue for `user`, save it, and return the result. */
export function updateQueue(deps: QueueDeps, user: string, change: (q: ReviewItem[]) => ReviewItem[]): Promise<ReviewItem[]> {
  const key = queueKey(user);
  const run = async () => { const next = change(await deps.load(key)); await deps.save(key, next); return next; };
  return deps.lock ? deps.lock(`chess-check-${key}`, run) : run();
}
