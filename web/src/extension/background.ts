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

chrome.runtime.onMessage.addListener((msg: { target?: string }, _sender, sendResponse) => {
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
