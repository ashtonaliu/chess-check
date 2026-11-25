import type { PageLookup, SafetyKey, SitePages } from "../site";
import { gameIdFromPage, isPlayPage, pageSafetyKey, readStatusOnly } from "../../extension/lichessGuard";
import type { LichessStatusReply } from "../../extension/lichessRequests";

const gameUrl = (id: string) => new URL(`https://lichess.org/game/${id}`);
const publicId = (url: URL) => gameIdFromPage(url.href);

async function lookupFinishedPage(id: string, _url: URL, signal: AbortSignal): Promise<PageLookup> {
  const reply = await chrome.runtime.sendMessage<LichessStatusReply>({ target: "bg", type: "lichess-status", gameId: id });
  signal.throwIfAborted();
  if (reply?.status === "wait") return { retryAfterMs: reply.retryAfterMs };
  if (reply?.status === "aborted") return "aborted";
  if (reply?.status !== "finished" || readStatusOnly(reply.evidence) !== "finished" || reply.evidence.id !== id) return null;
  const { white, black } = reply.evidence.players ?? {};
  return { players: { white: white?.user?.name ?? white?.user?.id ?? "Anonymous",
    black: black?.user?.name ?? black?.user?.id ?? "Anonymous" }, evidence: reply.evidence };
}

export const lichessPages: SitePages = {
  id: "lichess",
  name: "Lichess",
  tabPatterns: ["https://lichess.org/*"],
  matches: url => url.protocol === "https:" && url.hostname === "lichess.org",
  gameIdFromPage: publicId,
  gameId: url => gameIdFromPage(url) ?? url,
  isPlayPage,
  pageSafetyKey: url => (pageSafetyKey(url.href) ?? "play") as SafetyKey,
  signedInUser: doc => doc.querySelector("button#user_tag")?.textContent?.trim() || null,
  lookupFinishedPage,
  pollDelay: () => 5_000,
  publicPageUrl(url) {
    const id = publicId(url);
    if (!id) return url.href;
    const page = gameUrl(id);
    if (/^#\d+$/.test(url.hash)) page.hash = url.hash;
    return page.href;
  },
  moveLink(url, ply) {
    const id = gameIdFromPage(url);
    if (!id) return url;
    const page = gameUrl(id);
    page.hash = String(ply);
    return page.href;
  },
  isAtPly: (url, ply) => url.hash === `#${ply}`,
};
