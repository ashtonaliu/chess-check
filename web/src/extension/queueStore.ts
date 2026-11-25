// The review queue in chrome.storage, changed safely from several Chess.com tabs at once.
//
// Each tab used to keep its own copy and save the whole list after a change, so a tab with an
// older copy could undo a grade made in another tab. Now every change is a function applied to the
// latest saved queue while holding a lock that all Chess.com tabs share (Web Locks are per origin,
// and every tab's content script runs on chess.com), and tabs refresh their copy when the stored
// queue changes.
import type { ReviewItem } from "../browser/reviewQueue";
import { DEFAULT_SITE, type SiteId } from "../browser/site";

export interface QueueDeps {
  load: (key: string) => Promise<ReviewItem[]>;
  save: (key: string, queue: ReviewItem[]) => Promise<void>;
  /** navigator.locks.request, or null where Web Locks are unavailable (then changes are not serialized). */
  lock: ((name: string, fn: () => Promise<ReviewItem[]>) => Promise<ReviewItem[]>) | null;
}

export const QUEUE_PREFIX = "queue:";
export const queueKey = (user: string, site: SiteId = DEFAULT_SITE) => `${QUEUE_PREFIX}${site}:${user.toLowerCase()}`;

export function legacyQueueKey(key: string): string | undefined {
  const prefix = `${QUEUE_PREFIX}${DEFAULT_SITE}:`;
  return key.startsWith(prefix) ? QUEUE_PREFIX + key.slice(prefix.length) : undefined;
}

export async function loadStoredQueue(key: string, storage = chrome.storage.local): Promise<ReviewItem[]> {
  const legacy = legacyQueueKey(key);
  try {
    const entries = await storage.get(legacy ? [key, legacy] : [key]);
    return (entries[key] ?? (legacy ? entries[legacy] : undefined) ?? []) as ReviewItem[];
  } catch { return []; }
}

/** Apply `change` to the latest saved queue for `user`, save it, and return the result. */
export function updateQueue(deps: QueueDeps, user: string, change: (q: ReviewItem[]) => ReviewItem[],
                            site: SiteId = DEFAULT_SITE): Promise<ReviewItem[]> {
  const key = queueKey(user, site);
  const run = async () => { const next = change(await deps.load(key)); await deps.save(key, next); return next; };
  return deps.lock ? deps.lock(`chess-check-${key}`, run) : run();
}
