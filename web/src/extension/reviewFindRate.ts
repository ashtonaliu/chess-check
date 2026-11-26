import { createNeuralFindRate } from "../browser/neuralFindRate";
import { inReviewRateRange, isReviewSpeed } from "../browser/rateRange";
import type { ReviewRateRequest } from "../browser/reviewQueue";
import { DEFAULT_SITE, type SiteId } from "../browser/site";
import weights from "./neuralFindRateWeights.json";
import reviewClocks from "./reviewClocks.json";

// Fallback reference clock fraction if a (site, speed) pair is missing from reviewClocks.json.
export const REVIEW_CLOCK_FRACTION = 0.6561;
const CLOCKS: Record<string, Partial<Record<string, number>>> = reviewClocks;
let predict: ReturnType<typeof createNeuralFindRate> | undefined;

export function reviewClockFraction(timeClass: string, source: SiteId = DEFAULT_SITE): number {
  return CLOCKS[source]?.[timeClass] ?? REVIEW_CLOCK_FRACTION;
}

export function reviewFindRate({ fen, best, rating, timeClass }: ReviewRateRequest, source: SiteId = DEFAULT_SITE): number | null {
  if (!isReviewSpeed(timeClass) || !inReviewRateRange(rating, timeClass, source)) return null;
  predict ??= createNeuralFindRate(weights);
  return predict(fen, best, { rating, speed: timeClass, clockFrac: reviewClockFraction(timeClass, source), source });
}
