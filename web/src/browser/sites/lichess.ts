import { parseLichessGame, parseLichessNdjson, type LichessExport } from "../lichess";
import type { Site } from "../site";
import { readStatusOnly } from "../../extension/lichessGuard";
import type { LichessHistoryReply } from "../../extension/lichessRequests";
import { lichessPages } from "./lichessPages";

function isFinishedGame(id: string, evidence: unknown): boolean {
  return readStatusOnly(evidence) === "finished" && (evidence as LichessExport).id === id;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export const lichess: Site = {
  ...lichessPages,
  isFinishedGame,
  finishedGame: (id, user, evidence) => isFinishedGame(id, evidence) ? parseLichessGame(evidence, user) : "pending",
  nameOpening: game => game,
  async history(user, timeClass, max, signal) {
    for (;;) {
      signal?.throwIfAborted();
      const reply = await chrome.runtime.sendMessage<LichessHistoryReply>({ target: "lichess-history", user, timeClass, max });
      signal?.throwIfAborted();
      if (!reply) throw new Error("The Lichess history request did not answer.");
      if (reply.status === "history") return parseLichessNdjson(reply.text, user).games;
      if (reply.status === "error") throw new Error(reply.message);
      await delay(reply.retryAfterMs, signal);
    }
  },
};
