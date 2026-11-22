import { summarize, type TacticSummary } from "./tactics";
import type { GameAnalysis } from "./engine";

export interface TacticsRequest {
  analyses: GameAnalysis[];
  pgns: Map<string, string>;
  depth: number;
}

export type TacticsResponse = { summary: TacticSummary } | { error: string };

self.addEventListener("message", (event: MessageEvent<TacticsRequest>) => {
  const started = typeof __CC_PROFILE__ !== "undefined" && __CC_PROFILE__ ? performance.now() : 0;
  const { analyses, pgns, depth } = event.data;
  try {
    self.postMessage({ summary: summarize(analyses, pgns, depth) } satisfies TacticsResponse);
    if (typeof __CC_PROFILE__ !== "undefined" && __CC_PROFILE__) performance.measure("cc:tactics worker", { start: started });
  } catch (error) {
    self.postMessage({ error: String(error) } satisfies TacticsResponse);
  }
});
