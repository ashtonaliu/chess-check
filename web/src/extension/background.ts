// Service worker: relays the cube's requests to the offscreen analysis page
// (creating it when needed), and toggles the cube when the toolbar icon is clicked.

import { pageSafetyKey } from "./guard";
import type { Reply } from "./offscreen";

const SAFETY_KEY = "analysis-paused-tabs";
const chessTabs = ["https://www.chess.com/*", "https://chess.com/*"];
const tabStates = new Map<number, { key: string; paused: boolean }>();
let saveState = Promise.resolve();
let pauseWork = Promise.resolve();

const hasPausedTab = () => Array.from(tabStates.values()).some(tab => tab.paused);

function stopAnalysis() {
  pauseWork = pauseWork.then(async () => {
    if (await chrome.offscreen.hasDocument()) await toOffscreen({ type: "stop" });
  }).catch(() => { /* a closed offscreen document already stopped its workers */ });
}

function setTab(id: number, key: string | null, finished?: boolean, resetConfirmation = false) {
  const previous = tabStates.get(id);
  const wasPaused = hasPausedTab();
  if (key === null || key === "other") tabStates.delete(id);
  else {
    const paused = key === "play" || (finished === undefined
      ? resetConfirmation || previous?.key !== key || previous.paused
      : !finished);
    tabStates.set(id, { key, paused });
  }
  const next = tabStates.get(id);
  if (!wasPaused && hasPausedTab()) stopAnalysis();
  if (previous?.key !== next?.key || previous?.paused !== next?.paused) {
    saveState = saveState.then(() => chrome.storage.session.set({ [SAFETY_KEY]: [...tabStates] }))
      .catch(() => { /* the current service worker still holds the gate */ });
  }
}

const safetyReady = (async () => {
  const [tabs, saved] = await Promise.all([chrome.tabs.query({ url: chessTabs }), chrome.storage.session.get([SAFETY_KEY])]);
  const previous = new Map((saved[SAFETY_KEY] as [number, { key: string; paused: boolean }][] | undefined) ?? []);
  for (const tab of tabs) {
    const key = pageSafetyKey(tab.url);
    if (tab.id === undefined || !key || key === "other") continue;
    const savedTab = previous.get(tab.id);
    tabStates.set(tab.id, { key, paused: key === "play" || savedTab?.key !== key || savedTab.paused });
  }
  if (hasPausedTab()) stopAnalysis();
})();

chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url === undefined && change.status === undefined) return;
  void safetyReady.then(() => {
    const key = pageSafetyKey(change.url ?? tab.url);
    // Chrome can report loading after the content script confirms the same game.
    // A fresh content script reports finished: false before checking the game again.
    if (key || change.status === "complete") setTab(id, key);
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(id => { void safetyReady.then(() => setTab(id, null)).catch(() => {}); });
chrome.tabs.onReplaced.addListener((added, removed) => {
  // A replaced page has no active content script confirmation yet.
  void safetyReady.then(async () => {
    const tabs = await chrome.tabs.query({ url: chessTabs });
    const tab = tabs.find(item => item.id === added);
    if (tab) setTab(added, pageSafetyKey(tab.url), undefined, true);
    setTab(removed, null);
  }).catch(() => {});
});

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"],
      justification: "Run the Stockfish chess engine on finished games to build post-game recaps." });
  } catch { /* another request created it at the same moment */ }
}

/** Send to the offscreen page. Right after it is created its listener may not be registered yet,
 *  and Chrome then rejects the message ("Receiving end does not exist"), so retry briefly. */
async function toOffscreen(msg: object, gated = false): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    if (gated && hasPausedTab()) return { status: "paused" } satisfies Reply;
    try {
      const reply = await chrome.runtime.sendMessage({ ...msg, target: "offscreen" });
      if (reply !== undefined || attempt >= 40) return reply;
    } catch (e) {
      if (attempt >= 40) throw e;
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

// Developer installs only (loaded unpacked in chrome://extensions): the cube can ask for the build it
// is running and for the extension to reload itself, so a new build can be tried without clicking
// reload by hand. An install from the Chrome Web Store has installType "normal" and ignores both.
const isDevInstall = () => chrome.management.getSelf().then(s => s.installType === "development", () => false);

chrome.runtime.onMessage.addListener((msg: { target?: string; type?: string; url?: string; finished?: boolean }, sender, sendResponse) => {
  if (msg.target === "review-dependencies" && sender.url === chrome.runtime.getURL("offscreen.html")) {
    // Chrome only exposes the runtime API to the offscreen page.
    void chrome.storage.local.get(null).then(storage => {
      sendResponse(Object.fromEntries(Object.entries(storage).filter(([key]) => key.startsWith("queue:"))));
    }, () => sendResponse(null));
    return true;
  }
  if (msg.target === "dev") {
    void (async () => {
      if (!(await isDevInstall())) { sendResponse({ dev: false }); return; }
      if (msg.type === "reload") { sendResponse({ dev: true, reloading: true }); setTimeout(() => chrome.runtime.reload(), 50); return; }
      let built: string | null = null;
      try { built = (await (await fetch(chrome.runtime.getURL("dist/build.json"))).json()).built; } catch { /* no stamp */ }
      sendResponse({ dev: true, built });
    })();
    return true;
  }
  if (msg.target !== "bg") return false;
  void (async () => {
    try {
      await safetyReady;
      const id = sender.tab?.id;
      // The sender's frame URL can still refer to the original document after pushState.
      // The tab URL reflects the current route, and the frame URL validates the origin.
      const key = pageSafetyKey(sender.tab?.url);
      if (id === undefined || !key || !pageSafetyKey(sender.url) || sender.frameId !== 0) {
        sendResponse({ status: "paused" });
        return;
      }
      if (msg.type === "page-state") {
        if (pageSafetyKey(msg.url) === key) setTab(id, key, msg.finished === true);
        sendResponse({ status: "ready" });
        return;
      }
      // A newly opened or not-yet-confirmed game cannot start analysis.
      if (key !== "other" && tabStates.get(id)?.key !== key) setTab(id, key);
      if (hasPausedTab()) {
        sendResponse({ status: "paused" });
        return;
      }
      await pauseWork;
      await ensureOffscreen();
      sendResponse(await toOffscreen(msg, true) ?? { status: "error", message: "The analysis page did not answer." });
    } catch (e) {
      // always answer, so the cube never waits forever
      sendResponse({ status: "error", message: (e as Error).message });
    }
  })();
  return true;   // reply asynchronously
});

chrome.action.onClicked.addListener(tab => {
  if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => { /* not a Chess.com tab */ });
});
