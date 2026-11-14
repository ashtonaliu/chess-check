// The cube: a small, draggable button on Chess.com pages that opens a recap of
// the game in the tab once it is finished. It lives in a closed Shadow DOM so
// it cannot touch Chess.com's page (and their styles cannot touch it). It reads
// one thing from the page, the signed-in username, and takes the game ID from
// the address.
//
// Timing: on pages that are not a game or the play page it asks the analysis
// page to build the player's profile in advance. On a game page it asks
// Chess.com's game endpoint every few seconds whether the game exists yet; the
// endpoint serves a live game only once it is over, so nothing about the game
// is known, shown or analyzed while it is being played, and any profile build
// still running is stopped.
import siteCss from "../../style.css";
import type { Recap } from "../browser/recap";
import { esc, recapCard } from "../ui/recapCard";
import type { Callback } from "../browser/callbackGame";
import { gameIdFromPage } from "./guard";
import type { Reply, Request } from "./offscreen";

type State = "idle" | "loading" | "choose" | "pending" | "building" | "ready" | "error";
const LIVE_POLL_MS = 5_000;     // how often to ask whether a live game has ended
const DAILY_POLL_MS = 60_000;
const KNIGHT = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor"
  d="M7 21h11v-2.2c0-1.6-.6-3-1.6-4.2l-1-1.2c.9-.8 1.4-2 1.2-3.3-.3-2.3-2.1-4.4-4.6-5.3L11 3l-1 1.6C7.4 6 5.5 8.6 5.6 11.2l2.8-.6c.6.6.6 1.6 0 2.2l-1.3 1.4C6.4 15.1 6 16.3 6 17.5V19H7v2z"/></svg>`;

// ---------- messaging and storage (real extension, or the dev harness's stand-ins) ----------

const ask = (req: Request) => chrome.runtime.sendMessage<Reply>({ ...req, target: "bg" });
async function load<T>(key: string, fallback: T): Promise<T> {
  try { return ((await chrome.storage.local.get([key]))[key] as T) ?? fallback; } catch { return fallback; }
}
async function save(key: string, value: unknown) {
  try { await chrome.storage.local.set({ [key]: value }); } catch { /* not remembered */ }
}
type Dev = { __wfPageUrl?: string; __wfCallback?: (id: string) => Promise<Callback | null>; __wfSignedIn?: string };
const dev = window as unknown as Dev;
const pageUrl = () => dev.__wfPageUrl ?? location.href;

export interface Players { white: string; black: string }

/** The signed-in Chess.com username: from the user settings the page embeds as JSON, or from the
 *  sidebar link to your profile. Null when signed out. Nothing else on the page is read. */
let signedIn: string | null = null;
function signedInUser(): string | null {
  if (dev.__wfSignedIn !== undefined) return dev.__wfSignedIn || null;
  if (signedIn) return signedIn;
  for (const s of Array.from(document.scripts)) {
    const m = s.textContent?.match(/"user":\{"id":\d+,[^{}]*?"username":"([\w-]+)"/);
    if (m) return (signedIn = m[1]);
  }
  const href = document.querySelector('a.sidebar-link[href*="/member/"]')?.getAttribute("href");
  const m = href?.match(/\/member\/([\w-]+)/);
  return m ? (signedIn = m[1]) : null;
}

interface Served { kind: "live" | "daily"; callback: Callback; players: Players }

/** The game from the same Chess.com endpoint the game page loads, or null while Chess.com does not
 *  serve it, which for a live game means it is still being played. */
async function fetchGame(id: string, url: string): Promise<Served | null> {
  const kind = /\/daily\//.test(new URL(url).pathname) ? "daily" : "live";
  let callback: Callback | null;
  if (dev.__wfCallback) callback = await dev.__wfCallback(id);
  else {
    const r = await fetch(`/callback/${kind}/game/${id}`, { credentials: "include" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Chess.com game lookup failed (${r.status}).`);
    callback = await r.json();
  }
  if (!callback) return null;
  const h = callback.game?.pgnHeaders ?? {};
  if (!h.White || !h.Black) throw new Error("Chess.com did not say who played this game.");
  return { kind, callback, players: { white: String(h.White), black: String(h.Black) } };
}

/** Pages where it is safe to build the profile: not a game and not the page games are played from. */
const canWarm = (url: string) => !gameIdFromPage(url) && !/^\/play(\/|$)/.test(new URL(url).pathname);

// ---------- DOM ----------

const host = document.createElement("div");
host.style.cssText = "position:fixed;z-index:2147483000;width:0;height:0;";
const root = host.attachShadow({ mode: "closed" });
root.innerHTML = `<style>${siteCss.replace(/:root/g, ":host")}
  :host { all: initial; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); }
  .cube { position: fixed; width: 44px; height: 44px; border-radius: 12px; border: none; padding: 0; display: grid; place-items: center;
    background: #5c6660; color: #fff; cursor: grab; box-shadow: 0 4px 14px rgba(0,0,0,.35); touch-action: none; user-select: none; }
  .cube.ready { background: var(--accent); }
  .cube.building { background: #3d6d93; }
  .cube.ready::after, .cube.choose::after { content: ""; position: absolute; top: -3px; right: -3px; width: 12px; height: 12px;
    border-radius: 50%; background: #f2c14e; border: 2px solid #1b201d; }
  .cube:active { cursor: grabbing; }
  .panel { position: fixed; width: 340px; overflow: auto; background: var(--bg); color: var(--ink);
    border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.45); border: 1px solid var(--line); padding: 12px 14px; }
  .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-weight: 700; }
  .head button { background: none; color: var(--muted); padding: 2px 6px; font-weight: 600; }
  .panel .note { font-size: 13px; }
  .who { display: grid; gap: 8px; margin-top: 8px; }
  .recap { border: none; padding: 0; }
  .recap-grid { grid-template-columns: 1fr !important; }
  .meter .labels { gap: 8px; } .meter .labels span:nth-child(2) { text-align: center; }
  .recap-grid svg.board { max-width: 260px; }
  .fine { font-size: 11px; color: var(--muted); margin: 10px 0 0; }
  .hidden { display: none !important; }
</style>
<button class="cube" title="Chess Check: post-game recap" aria-label="Chess Check">${KNIGHT}</button>
<div class="panel hidden" role="dialog" aria-label="Chess Check recap">
  <div class="head"><span>Chess Check</span><span><button data-act="reset" title="Forget which player you are">Reset</button><button data-act="close" aria-label="Close">✕</button></span></div>
  <div class="body"></div>
  <p class="fine">Recaps appear only after Chess.com lists a game as finished. Nothing is shown or analyzed during a game.</p>
</div>`;
const cube = root.querySelector(".cube") as HTMLButtonElement;
const panel = root.querySelector(".panel") as HTMLElement;
const body = root.querySelector(".body") as HTMLElement;

let state: State = "idle";
let accounts: string[] = [];              // usernames the user has said are theirs (lowercase)
let players: Players | null = null;       // the game in the tab
let served: Served | null = null;
let viewer = "";                          // whose recap to show for this game
let recap: Recap | null = null;
let message = "";
let timer: ReturnType<typeof setTimeout> | null = null;

function setState(s: State, msg = "") {
  state = s; message = msg;
  cube.className = "cube" + (s === "ready" ? " ready" : s === "building" ? " building" : s === "choose" ? " choose" : "");
  cube.title = s === "ready" ? "Chess Check: your recap is ready" : s === "choose" ? "Chess Check: which player are you?" : "Chess Check";
  if (!panel.classList.contains("hidden")) renderPanel();
}

function renderPanel() {
  if (state === "ready" && recap) { body.replaceChildren(recapCard(recap, false)); return; }
  if (state === "choose" && players) {
    const names = [players.white, players.black];
    const me = signedInUser();
    const known = me ? [me] : accounts;
    const intro = known.length
      ? `This is not one of your games (${esc(known.join(", "))}). Whose recap do you want?`
      : "Which player are you? Chess Check remembers this, so you only answer once. Signing in to Chess.com skips this.";
    body.innerHTML = `<p class="note">${intro}</p><div class="who">${names.map(n =>
      `<button data-name="${esc(n)}">${known.length ? "Recap for " : "I am "}${esc(n)}</button>`).join("")}</div>`;
    body.querySelectorAll<HTMLButtonElement>("button[data-name]").forEach(b => b.addEventListener("click", () => {
      const name = b.dataset.name!;
      if (!known.length) { accounts = [name.toLowerCase()]; void save("accounts", accounts); }
      viewer = name;
      void requestRecap();
    }));
    return;
  }
  const text: Record<State, string> = {
    choose: "", ready: "",
    idle: "Open a finished game and its recap appears here.",
    loading: "Looking up this game…",
    building: `Setting up for ${viewer}: ${message}`,
    pending: "<strong>Your recap will appear when this game ends.</strong>",
    error: `Something went wrong: ${message}`,
  };
  body.innerHTML = `<p class="note">${state === "building" || state === "error" ? esc(text[state]) : text[state]}</p>`;
}

// ---------- position and dragging ----------

let pos = { right: 24, bottom: 120 };
function place() {
  pos.right = Math.min(Math.max(pos.right, 4), window.innerWidth - 48);
  pos.bottom = Math.min(Math.max(pos.bottom, 4), window.innerHeight - 48);
  cube.style.right = `${pos.right}px`; cube.style.bottom = `${pos.bottom}px`;
  // open the panel on whichever side has room
  const left = window.innerWidth - pos.right - 44 > 360;
  panel.style.right = left ? `${pos.right + 52}px` : ""; panel.style.left = left ? "" : `${window.innerWidth - pos.right + 8}px`;
  // and grow downward from a cube in the top half, upward from one in the bottom half
  const cubeTop = window.innerHeight - pos.bottom - 44;
  if (cubeTop < window.innerHeight / 2) {
    panel.style.top = `${Math.max(cubeTop, 8)}px`; panel.style.bottom = "";
    panel.style.maxHeight = `${window.innerHeight - Math.max(cubeTop, 8) - 8}px`;
  } else {
    panel.style.bottom = `${Math.max(pos.bottom, 8)}px`; panel.style.top = "";
    panel.style.maxHeight = `${window.innerHeight - Math.max(pos.bottom, 8) - 8}px`;
  }
}
let drag: { x: number; y: number; right: number; bottom: number; moved: boolean } | null = null;
cube.addEventListener("pointerdown", e => {
  drag = { x: e.clientX, y: e.clientY, right: pos.right, bottom: pos.bottom, moved: false };
  cube.setPointerCapture(e.pointerId);
});
cube.addEventListener("pointermove", e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (drag.moved) { pos = { right: drag.right - dx, bottom: drag.bottom - dy }; place(); }
});
cube.addEventListener("pointerup", () => {
  if (drag && !drag.moved) togglePanel();
  else if (drag) void save("position", pos);
  drag = null;
});
window.addEventListener("resize", place);

function togglePanel(force?: boolean) {
  const open = force ?? panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !open);
  if (open) renderPanel();
}
root.querySelector('[data-act="close"]')!.addEventListener("click", () => togglePanel(false));
root.querySelector('[data-act="reset"]')!.addEventListener("click", () => {
  accounts = []; void save("accounts", accounts); lastId = null; void check();
});

// ---------- the game in the tab ----------

let lastId: string | null = null;

/** The signed-in user, or the one picked earlier when signed out. */
const whoAmI = () => signedInUser() ?? accounts[0] ?? null;

/** Called when the address changes, and every few seconds while a live game is in progress. */
async function check() {
  const url = pageUrl();
  const id = gameIdFromPage(url);
  // Same game as before (Chess.com rewrites /game/<id> to /live/game/<id> after loading): leave
  // any polling running. Clearing the timer first left the cube stuck on "Setting up" for good.
  // Pages that are not games always run, to warm up or stop.
  if (id && id === lastId && state !== "error" && state !== "pending") return;
  if (timer) { clearTimeout(timer); timer = null; }
  lastId = id; players = null; served = null; viewer = ""; recap = null;
  if (!id) {
    setState("idle");
    const me = whoAmI();
    if (canWarm(url) && me) void ask({ type: "warm", username: me }).catch(() => { /* try again next page */ });
    else void ask({ type: "stop" }).catch(() => {});      // the play page: a game may be about to start
    return;
  }
  if (state !== "pending") setState("loading");      // a recheck of a game in progress stays on "pending"
  try {
    const g = await fetchGame(id, url);
    if (gameIdFromPage(pageUrl()) !== id) return;          // the page changed while we waited
    if (!g || !g.callback.game.isFinished) {
      // still being played: make sure no analysis is running, and ask again shortly
      void ask({ type: "stop" }).catch(() => {});
      setState("pending");
      timer = setTimeout(check, g ? DAILY_POLL_MS : LIVE_POLL_MS);
      return;
    }
    served = g; players = g.players;
  } catch (e) { setState("error", (e as Error).message); return; }
  const me = signedInUser()?.toLowerCase();
  const mine = [players.white, players.black].find(n => me ? n.toLowerCase() === me : accounts.includes(n.toLowerCase()));
  if (!mine) { setState("choose"); return; }
  viewer = mine;
  await requestRecap();
}

async function requestRecap() {
  if (timer) { clearTimeout(timer); timer = null; }
  const id = lastId, g = served;
  if (!id || !viewer || !g) return;
  let reply: Reply;
  try { reply = await ask({ type: "recap", username: viewer, kind: g.kind, gameId: id, callback: g.callback }); }
  catch (e) { setState("error", (e as Error).message); return; }
  if (gameIdFromPage(pageUrl()) !== id) return;
  switch (reply.status) {
    case "building": setState("building", reply.progress); timer = setTimeout(requestRecap, 1000); break;
    case "pending": setState("pending"); break;
    case "recap": recap = reply.recap; setState("ready"); break;
    case "error": setState("error", reply.message); break;
    case "ready": break;
  }
}

// Chess.com changes pages without reloading, so watch the address.
let lastUrl = "";
setInterval(() => { if (pageUrl() !== lastUrl) { lastUrl = pageUrl(); void check(); } }, 1000);

try {
  chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg.type === "toggle") { host.style.display = host.style.display === "none" ? "" : "none"; }
    return false;
  });
} catch { /* dev harness */ }

void (async () => {
  accounts = await load<string[]>("accounts", []);
  const old = await load("username", "");                  // v0.2 stored one typed username
  if (!accounts.length && old) { accounts = [old.toLowerCase()]; void save("accounts", accounts); }
  pos = await load("position", pos);
  document.documentElement.appendChild(host);
  place();
  lastUrl = pageUrl();
  await check();
})();
