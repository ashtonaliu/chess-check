// Service worker: relays the cube's requests to the offscreen analysis page
// (creating it when needed), and toggles the cube when the toolbar icon is clicked.

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"],
      justification: "Run the Stockfish chess engine on finished games to build post-game recaps." });
  } catch { /* another request created it at the same moment */ }
}

chrome.runtime.onMessage.addListener((msg: { target?: string }, _sender, sendResponse) => {
  if (msg.target !== "bg") return false;
  void (async () => {
    await ensureOffscreen();
    sendResponse(await chrome.runtime.sendMessage({ ...msg, target: "offscreen" }));
  })();
  return true;   // reply asynchronously
});

chrome.action.onClicked.addListener(tab => {
  if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => { /* not a Chess.com tab */ });
});
