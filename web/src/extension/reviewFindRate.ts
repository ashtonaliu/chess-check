import { createNeuralFindRate } from "../browser/neuralFindRate";
import { inRateRange } from "../browser/rateRange";
import type { ReviewRateRequest } from "../browser/reviewQueue";
import weights from "./neuralFindRateWeights.json";

// The review estimate describes the position at the same reference clock as before.
const REVIEW_CLOCK_FRACTION = 0.6561;
let predict: ReturnType<typeof createNeuralFindRate> | undefined;

export function reviewFindRate({ fen, best, rating, timeClass }: ReviewRateRequest): number | null {
  if (timeClass !== "blitz" || !inRateRange(rating)) return null;
  predict ??= createNeuralFindRate(weights);
  return predict(fen, best, { rating, speed: "blitz", clockFrac: REVIEW_CLOCK_FRACTION, source: "chesscom" });
}
