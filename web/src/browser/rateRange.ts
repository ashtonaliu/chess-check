// The ratings the find-rate models cover, kept apart from findRate.ts and neuralFindRate.ts
// so the content script can check them without loading chess.js.
import { DEFAULT_SITE, type SiteId } from "./site";

/** The old Chess.com blitz logistic model (findRate.ts): nearly all of its training positions are 1200 to 2000. */
export const RATE_RANGE = [1200, 2000] as const;
export const inRateRange = (rating: number) => rating >= RATE_RANGE[0] && rating <= RATE_RANGE[1];

export type ReviewSpeed = "ultraBullet" | "bullet" | "blitz" | "rapid" | "classical";

/** Shipped neural review model limits per site and speed, from the held-out calibration rule in docs/methods.md. */
export const REVIEW_RATE_RANGES: Record<SiteId, Partial<Record<ReviewSpeed, readonly [number, number]>>> = {
  chesscom: {
    bullet: [600, 1599],
    blitz: [1200, 1899],
    rapid: [600, 1499],
  },
  lichess: {
    ultraBullet: [1000, 2099],
    bullet: [900, 2599],
    blitz: [900, 2299],
    rapid: [1100, 2199],
    classical: [1100, 1499],
  },
};

export function isReviewSpeed(speed: string | undefined): speed is ReviewSpeed {
  return speed === "ultraBullet" || speed === "bullet" || speed === "blitz" || speed === "rapid" || speed === "classical";
}

export function reviewRateRange(timeClass: string | undefined, site: SiteId = DEFAULT_SITE): readonly [number, number] | null {
  if (!isReviewSpeed(timeClass)) return null;
  return REVIEW_RATE_RANGES[site][timeClass] ?? null;
}

export function inReviewRateRange(rating: number, timeClass: string | undefined, site: SiteId = DEFAULT_SITE): boolean {
  const range = reviewRateRange(timeClass, site);
  return range !== null && rating >= range[0] && rating <= range[1];
}
