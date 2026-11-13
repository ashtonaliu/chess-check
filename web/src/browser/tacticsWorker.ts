import { summarize, type TacticSummary } from "./tactics";
import { loadWasmClassifier } from "./tacticsWasm";
import type { GameAnalysis } from "./engine";

export interface TacticsRequest {
  analyses: GameAnalysis[];
  pgns: Map<string, string>;
  depth: number;
  engineUrl?: string;
}

export type TacticsResponse = { summary: TacticSummary } | { error: string };

self.addEventListener("message", async (event: MessageEvent<TacticsRequest>) => {
  const { analyses, pgns, depth, engineUrl } = event.data;
  try {
    self.postMessage({ summary: summarize(analyses, pgns, depth, engineUrl ? await loadWasmClassifier(engineUrl) : undefined) } satisfies TacticsResponse);
  } catch (error) {
    self.postMessage({ error: String(error) } satisfies TacticsResponse);
  }
});
