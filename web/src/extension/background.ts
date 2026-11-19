// Service worker: relays the cube's requests to the offscreen analysis page
// (creating it when needed), and toggles the cube when the toolbar icon is clicked.

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"],
      justification: "Run the Stockfish chess engine on finished games to build post-game recaps." });
  } catch { /* another request created it at the same moment */ }
}

/** Send to the offscreen page. Right after it is created its listener may not be registered yet,
 *  and Chrome then rejects the message ("Receiving end does not exist"), so retry briefly. */
async function toOffscreen(msg: object): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
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

chrome.runtime.onMessage.addListener((msg: { target?: string; type?: string }, sender, sendResponse) => {
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
      await ensureOffscreen();
      sendResponse(await toOffscreen(msg) ?? { status: "error", message: "The analysis page did not answer." });
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
