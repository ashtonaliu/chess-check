import { summarize, type TacticSummary } from "./tactics";
import type { GameAnalysis } from "./engine";

export interface TacticsRequest {
  analyses: GameAnalysis[];
  pgns: Map<string, string>;
  depth: number;
}

export type TacticsResponse = { summary: TacticSummary } | { error: string };

self.addEventListener("message", (event: MessageEvent<TacticsRequest>) => {
  const { analyses, pgns, depth } = event.data;
  try {
    self.postMessage({ summary: summarize(analyses, pgns, depth) } satisfies TacticsResponse);
  } catch (error) {
    self.postMessage({ error: String(error) } satisfies TacticsResponse);
  }
});
