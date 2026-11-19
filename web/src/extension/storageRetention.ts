import { gameId } from "../browser/ids";
import type { ReviewItem } from "../browser/reviewQueue";

export const RECAP_LIMIT = 200;
export const ANALYSIS_LIMIT = 1_500;   // separately for shallow and deep entries
export const PROFILE_LIMIT = 8;

/** Recaps only live in the offscreen page. Reading or replacing one makes it the newest. */
export function rememberRecap<T>(recaps: Map<string, T>, key: string, value: T, limit = RECAP_LIMIT) {
  recaps.delete(key);
  recaps.set(key, value);
  if (recaps.size > limit) recaps.delete(recaps.keys().next().value!);
}

export function reviewDependencies(storage: Record<string, unknown>) {
  const games = new Set<string>();
  const legacyByUser = new Map<string, Set<string>>();
  for (const [key, value] of Object.entries(storage)) {
    if (!key.startsWith("queue:") || !Array.isArray(value)) continue;
    const legacy = new Set<string>();
    for (const item of value as ReviewItem[]) {
      if (item.done) continue;
      const id = gameId(item.url);
      games.add(id);
      if (!item.fen || item.timeClass === undefined) legacy.add(id);
    }
    if (legacy.size) legacyByUser.set(key.slice("queue:".length), legacy);
  }
  return { games, legacyByUser };
}
