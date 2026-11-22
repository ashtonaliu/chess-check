import { summarize, type TacticSummary } from "./tactics";
import type { GameAnalysis } from "./engine";
import { configureWasmChess, getWasmChess } from "./wasmChess";

configureWasmChess(new URL("./engine_core.js", import.meta.url).href);

export interface TacticsRequest {
  analyses: GameAnalysis[];
  pgns: Map<string, string>;
  depth: number;
}

export type TacticsResponse = { summary: TacticSummary } | { error: string };

self.addEventListener("message", (event: MessageEvent<TacticsRequest>) => {
  void (async () => {
    const started = typeof __CC_PROFILE__ !== "undefined" && __CC_PROFILE__ ? performance.now() : 0;
    const { analyses, pgns, depth } = event.data;
    try {
      const wasm = await getWasmChess();
      self.postMessage({ summary: summarize(analyses, pgns, depth, wasm) } satisfies TacticsResponse);
      if (typeof __CC_PROFILE__ !== "undefined" && __CC_PROFILE__) performance.measure("cc:tactics worker", { start: started });
    } catch (error) {
      self.postMessage({ error: String(error) } satisfies TacticsResponse);
    }
  })();
});
