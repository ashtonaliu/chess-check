import { summarize, type TacticSummary } from "./tactics";
import { loadWasmClassifier } from "./tacticsWasm";
import type { TacticsRequest, TacticsResponse } from "./tacticsWorker";

export async function summarizeInBackground(
  request: TacticsRequest, engineUrl: string, signal?: AbortSignal,
): Promise<TacticSummary> {
  signal?.throwIfAborted();
  let worker: Worker | undefined;
  try {
    const task = new Worker(new URL("tacticsWorker.js", engineUrl), { type: "module" });
    worker = task;
    return await new Promise<TacticSummary>((resolve, reject) => {
      const fail = () => reject(new Error("Tactics worker failed"));
      const timeout = setTimeout(() => { cleanup(); fail(); }, 30_000);
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => { cleanup(); reject(signal?.reason); };
      task.onmessage = ({ data }: MessageEvent<TacticsResponse>) => {
        cleanup();
        if ("summary" in data) resolve(data.summary);
        else reject(new Error(data.error));
      };
      task.onerror = task.onmessageerror = () => { cleanup(); fail(); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        task.postMessage({ ...request, engineUrl });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  } catch {
    signal?.throwIfAborted();
    return summarize(request.analyses, request.pgns, request.depth, await loadWasmClassifier(engineUrl));
  } finally {
    worker?.terminate();
  }
}
