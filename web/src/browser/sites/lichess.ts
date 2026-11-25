import { parseLichessGame, parseLichessNdjson, type LichessExport } from "../lichess";
import type { Site } from "../site";
import { RATE_LIMIT_COOLDOWN_MS, readStatusOnly } from "../../extension/lichessGuard";
import { historyUrl, type LichessHistoryReply, type LichessHistoryRequest } from "../../extension/lichessRequests";
import { lichessPages } from "./lichessPages";

const PAGE_TIMEOUT_MS = 25_000;
// Lichess sends anonymous history at about 20 games a second and can filter it by color. The note
// reads only the opponent's games in one color, and about half of their last 100 games are in it.
const OPPONENT_GAMES = 50;
const RATE_LIMIT_MESSAGE = "Lichess asked for a short pause. Try again in a minute.";

let pageTail = Promise.resolve();
let pageCooldownUntil = 0;
let pageNow = () => Date.now();

/** Test helper: reset the web-page Lichess queue cooldown and optionally override the clock. */
export function resetLichessPageQueue(now: () => number = () => Date.now()) {
  pageTail = Promise.resolve();
  pageCooldownUntil = 0;
  pageNow = now;
}

function inExtension(): boolean {
  return typeof chrome !== "undefined" && Boolean((chrome.runtime as { id?: string } | undefined)?.id);
}

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

function enqueuePage<T>(task: () => Promise<T>): Promise<T> {
  const next = pageTail.then(task);
  pageTail = next.then(() => {}, () => {});
  return next;
}

function fetchHistoryInPage(request: LichessHistoryRequest, signal?: AbortSignal) {
  const { user } = request;
  return enqueuePage(async () => {
    signal?.throwIfAborted();
    if (pageNow() < pageCooldownUntil) throw new Error(RATE_LIMIT_MESSAGE);
    const reqSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)])
      : AbortSignal.timeout(PAGE_TIMEOUT_MS);
    const response = await fetch(historyUrl(request), {
      headers: { Accept: "application/x-ndjson" },
      credentials: "omit",
      signal: reqSignal,
    });
    if (response.status === 429) {
      pageCooldownUntil = pageNow() + RATE_LIMIT_COOLDOWN_MS;
      await response.body?.cancel().catch(() => {});
      throw new Error(RATE_LIMIT_MESSAGE);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        response.status === 404
          ? `No Lichess player named "${user}".`
          : `Lichess API error ${response.status}.`,
      );
    }
    const text = await response.text();
    signal?.throwIfAborted();
    return parseLichessNdjson(text, user).games;
  });
}

async function fetchHistory(request: LichessHistoryRequest, signal?: AbortSignal) {
  if (!inExtension()) return fetchHistoryInPage(request, signal);
  for (;;) {
    signal?.throwIfAborted();
    const reply = await chrome.runtime.sendMessage<LichessHistoryReply>({ target: "lichess-history", ...request });
    signal?.throwIfAborted();
    if (!reply) throw new Error("The Lichess history request did not answer.");
    if (reply.status === "history") return parseLichessNdjson(reply.text, request.user).games;
    if (reply.status === "error") throw new Error(reply.message);
    await delay(reply.retryAfterMs, signal);
  }
}

export const lichess: Site = {
  ...lichessPages,
  isFinishedGame,
  finishedGame: (id, user, evidence) => isFinishedGame(id, evidence) ? parseLichessGame(evidence, user) : "pending",
  nameOpening: game => game,
  history: (user, timeClass, max, signal) => fetchHistory({ user, timeClass, max }, signal),
  opponentHistory: (user, color, timeClass, signal) =>
    fetchHistory({ user, timeClass, max: OPPONENT_GAMES, color }, signal),
};
