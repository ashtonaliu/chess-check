// The ratings the find-rate model covers (findRate.ts): nearly all of its training positions are
// from 1200 to 2000. Kept apart from findRate.ts so the Chess.com script can check it without chess.js.
export const RATE_RANGE = [1200, 2000] as const;
export const inRateRange = (rating: number) => rating >= RATE_RANGE[0] && rating <= RATE_RANGE[1];
