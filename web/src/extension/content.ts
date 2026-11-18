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
import { gameId, type Recap } from "../browser/recap";
import { addItems, dueItems, grade, itemFromRecap, nextDue, type ReviewItem } from "../browser/reviewQueue";
import { esc, moveLink, quizHint, recapCard, tacticSentence } from "../ui/recapCard";
import type { Callback } from "../browser/callbackGame";
import { canReview, gameIdFromPage } from "./guard";
import type { Reply, Request } from "./offscreen";

// "finished": a finished game opened from the review queue, whose own recap is not asked for
// unless you want it (so reviewing does not run Stockfish on every old game).
type State = "idle" | "loading" | "choose" | "pending" | "building" | "ready" | "finished" | "error";
const LIVE_POLL_MS = 5_000;     // how often to ask whether a live game has ended
const DAILY_POLL_MS = 60_000;
const KNIGHT = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor"
  d="M7 21h11v-2.2c0-1.6-.6-3-1.6-4.2l-1-1.2c.9-.8 1.4-2 1.2-3.3-.3-2.3-2.1-4.4-4.6-5.3L11 3l-1 1.6C7.4 6 5.5 8.6 5.6 11.2l2.8-.6c.6.6.6 1.6 0 2.2l-1.3 1.4C6.4 15.1 6 16.3 6 17.5V19H7v2z"/></svg>`;

// ---------- messaging and storage (real extension, or the dev harness's stand-ins) ----------

/** A request to the analysis page. Each answers within a second or two (long work continues in the
 *  background and is asked about again), so a missing answer means something broke: say so. */
const ASK_TIMEOUT_MS = 20_000;
const ask = (req: Request) => Promise.race([
  chrome.runtime.sendMessage<Reply>({ ...req, target: "bg" }),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
    "the extension did not answer. Reload the page, or reload Chess Check in chrome://extensions.")), ASK_TIMEOUT_MS)),
]);
async function load<T>(key: string, fallback: T): Promise<T> {
  try { return ((await chrome.storage.local.get([key]))[key] as T) ?? fallback; } catch { return fallback; }
}
async function save(key: string, value: unknown) {
  try { await chrome.storage.local.set({ [key]: value }); } catch { /* not remembered */ }
}
type Dev = { __ccPageUrl?: string; __ccCallback?: (id: string) => Promise<Callback | null>; __ccSignedIn?: string };
const dev = window as unknown as Dev;
const pageUrl = () => dev.__ccPageUrl ?? location.href;

export interface Players { white: string; black: string }

/** The signed-in Chess.com username: from the user settings the page embeds as JSON, or from the
 *  sidebar link to your profile. Null when signed out. Nothing else on the page is read. */
let signedIn: string | null = null;
function signedInUser(): string | null {
  if (dev.__ccSignedIn !== undefined) return dev.__ccSignedIn || null;
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
  if (dev.__ccCallback) callback = await dev.__ccCallback(id);
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
  .cube.ready.seen::after { display: none; }
  .cube.due::after { content: attr(data-count); position: absolute; top: -5px; right: -5px; min-width: 16px; height: 16px; padding: 0 3px;
    box-sizing: border-box; border-radius: 8px; background: #f2c14e; color: #1b201d; font: 700 10px/16px system-ui, sans-serif; text-align: center; }
  .linkish { background: none; border: none; padding: 0; color: var(--accent); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
  .review p { margin: 0 0 8px; }
  .review .lbl { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; display: block; }
  .review .count { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
  .review .grade { display: flex; gap: 8px; margin: 0 0 8px; }
  .review .grade button { font-size: 13px; font-weight: 650; padding: 6px 12px; border-radius: 8px; }
  .review .grade .missed { background: var(--chip); color: var(--ink); }
  .cube:active { cursor: grabbing; }
  .panel { position: fixed; width: 340px; max-width: calc(100vw - 16px); box-sizing: border-box; overflow: auto; background: var(--bg); color: var(--ink);
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
<button class="cube" title="Chess Check: post-game recap" aria-label="Chess Check" aria-expanded="false" aria-controls="cc-panel">${KNIGHT}</button>
<div class="panel hidden" id="cc-panel" role="dialog" aria-label="Chess Check recap">
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
let basis = 150;                          // how many of your past games the recap's profile used
let partial = "";                         // what the recap is still waiting for ("" when complete)
let shown = "";                           // which version of the recap the panel shows
let message = "";
let timer: ReturnType<typeof setTimeout> | null = null;

// ---------- review queue ----------

let view: "game" | "review" = "game";
let queue: ReviewItem[] = [];
let queueOwner = "";                      // whose queue is loaded (lowercase)
let current: string | null = null;        // the position being asked
let reviewRevealed = false;

const queueKey = (u: string) => `queue:${u}`;
async function loadQueue(user: string | null) {
  const u = (user ?? "").toLowerCase();
  queue = u ? await load<ReviewItem[]>(queueKey(u), []) : [];
  queueOwner = u;
}
function saveQueue() { if (queueOwner) void save(queueKey(queueOwner), queue); }

/** Fair play: the queue is never shown on the page games are played from, or on a game page until
 *  Chess.com has confirmed that game is over. */
const reviewAllowed = () => canReview(pageUrl(), state === "ready" || state === "finished" || state === "choose");
const due = () => (reviewAllowed() && queueOwner ? dueItems(queue, Date.now()) : []);

// Tallies for this sitting, kept across the page loads that "Find it on the board" causes.
const TALLY = "chess-check-review-tally";
function tally(): { found: number; missed: number; at: number } {
  try {
    const t = JSON.parse(sessionStorage.getItem(TALLY) ?? "null");
    if (t && Date.now() - t.at < 3_600_000) return t;
  } catch { /* start over */ }
  return { found: 0, missed: 0, at: Date.now() };
}
function addTally(found: boolean) {
  const t = tally();
  if (found) t.found++; else t.missed++;
  t.at = Date.now();
  try { sessionStorage.setItem(TALLY, JSON.stringify(t)); } catch { /* not counted */ }
}

/** The count on the cube: positions due, shown only away from games and the play page. */
function decorateCube() {
  const n = gameIdFromPage(pageUrl()) ? 0 : due().length;
  cube.classList.toggle("due", n > 0 && state === "idle");
  cube.dataset.count = n > 9 ? "9+" : String(n);
  if (n > 0 && state === "idle") cube.title = `Chess Check: ${n} position${n === 1 ? "" : "s"} to review`;
}

function daysAgo(t: number): string {
  const d = Math.floor((Date.now() / 1000 - t) / 86_400);
  return d < 1 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

function whenNext(): string {
  const t = nextDue(queue);
  if (t === null || t <= Date.now() || !reviewAllowed()) return "";
  const days = Math.ceil((t - Date.now()) / 86_400_000);
  return days <= 1 ? "Next review tomorrow." : `Next review in ${days} days.`;
}

function openReview(id: string | null = null) {
  view = "review"; current = id; reviewRevealed = false;
  if (panel.classList.contains("hidden")) togglePanel(true); else renderPanel();
}

function renderReview() {
  const list = due();
  const it = list.find(q => q.id === current) ?? list[0] ?? null;
  // "Back" returns to a recap you came from; "Show" offers the recap of the game on screen only
  // while its own card (or nothing) is showing, so it is not mistaken for the card's game.
  const onScreen = gameIdFromPage(pageUrl());
  const back = state === "ready" && recap ? `<button class="linkish" data-act="back">Back to this game's recap</button>`
    : state === "finished" && (!it || gameId(it.url) === onScreen) ? `<button class="linkish" data-act="recap">Show this game's recap</button>` : "";
  if (!it) {
    const t = tally();
    const summary = t.found + t.missed ? `That's all for now: ${t.found} found, ${t.missed} missed.` : "Nothing to review right now.";
    body.innerHTML = `<div class="review"><p>${summary} ${esc(whenNext())}</p>${back ? `<p>${back}</p>` : ""}</div>`;
    current = null;
    return;
  }
  current = it.id;
  const pos = list.indexOf(it) + 1;
  const here = gameIdFromPage(pageUrl()) === gameId(it.url) && new URL(pageUrl()).searchParams.get("move") === String(it.ply);
  const tags = tacticSentence(it.tactics.filter(x => x.kind === "missed"));   // the hint already said what it allowed
  body.innerHTML = `<div class="review">
    <p class="count">Review · ${pos} of ${list.length}</p>
    <p>From your game vs ${esc(it.opponent)} ${esc(daysAgo(it.endTime))}.
      You played <span class="moves">${esc(it.label)}</span> and lost <strong class="weak">${Math.round(it.loss)}%</strong>.
      Find the better move.<span class="quiz-q">${esc(quizHint(it.tactics))}</span></p>
    ${reviewRevealed
      ? `<p><span class="lbl">Answer</span>Better was <span class="moves">${esc(it.best)}</span>.${esc(tags)}</p>
         <div class="grade"><button type="button" data-grade="1">Got it</button><button type="button" class="missed" data-grade="0">Missed it</button></div>`
      : `<div class="quiz-actions">${here ? "" : `<a class="quiz-board" data-review="${esc(it.id)}" href="${esc(moveLink(it.url, it.ply))}">Find it on the board</a>`}
           <button type="button" class="quiz-reveal">Reveal the move</button></div>`}
    ${back ? `<p>${back}</p>` : ""}</div>`;
}

panel.addEventListener("click", e => {
  const el = e.target as HTMLElement;
  if (view !== "review") {
    if (el.closest('[data-act="review"]')) openReview();
    return;
  }
  if (el.closest(".quiz-reveal")) { reviewRevealed = true; renderPanel(); body.querySelector<HTMLButtonElement>("[data-grade]")?.focus(); return; }
  const g = el.closest<HTMLElement>("[data-grade]");
  if (g && current) {
    const found = g.dataset.grade === "1";
    queue = grade(queue, current, found, Date.now()); saveQueue(); addTally(found);
    current = null; reviewRevealed = false; renderPanel(); decorateCube();
    return;
  }
  const link = el.closest<HTMLElement>("[data-review]");
  if (link) { try { sessionStorage.setItem(REVIEW, link.dataset.review!); } catch { /* the panel stays closed */ } return; }
  if (el.closest('[data-act="back"]')) { view = "game"; renderPanel(); return; }
  if (el.closest('[data-act="recap"]')) { view = "game"; void requestRecap(); }
});

/** Add a finished game's turning point, and start an empty queue from the games already analyzed. */
const seedAsked = new Set<string>();      // once per page load and player
async function collect(r: Recap | null, user: string) {
  const u = user.toLowerCase();
  if (queueOwner !== u) await loadQueue(u);
  const it = r ? itemFromRecap(r, Date.now()) : null;
  if (it && !queue.some(q => q.id === it.id)) { queue = addItems(queue, [it]); saveQueue(); }
  if (!seedAsked.has(u) && !(await load<boolean>(`seeded:${u}`, false))) {
    seedAsked.add(u);
    try {
      const reply = await ask({ type: "seed", username: user });
      if (reply.status === "seed" && reply.items.length && queueOwner === u) {
        queue = addItems(queue, reply.items); saveQueue(); void save(`seeded:${u}`, true);
      }
    } catch { /* try again later */ }
  }
  decorateCube();
}

function setState(s: State, msg = "") {
  state = s; message = msg;
  cube.className = "cube" + (s === "ready" ? " ready" : s === "building" ? " building" : s === "choose" ? " choose" : "");
  if (s === "ready" && !panel.classList.contains("hidden")) markSeen(lastId);   // arrived while open
  cube.classList.toggle("seen", s === "ready" && wasSeen(lastId));
  cube.title = s === "ready" ? "Chess Check: your recap is ready" : s === "choose" ? "Chess Check: which player are you?" : "Chess Check";
  decorateCube();
  if (!panel.classList.contains("hidden")) renderPanel();
}

function renderPanel() {
  // with nothing else to show, the panel opens on the review
  if (view === "game" && state === "idle" && due().length) view = "review";
  if (view === "review" && reviewAllowed()) { shown = ""; renderReview(); return; }
  view = "game";
  if (state === "ready" && recap) {
    // Redraw only when the recap itself changed; while it fills in, just update the progress line,
    // so focus, scrolling and a revealed answer are not disturbed every second.
    const version = JSON.stringify([recap.url, recap.pending ?? null, basis, recap.turning?.ply ?? null, !!recap.opponentNote, !!recap.pattern]);
    const progress = body.querySelector<HTMLElement>(".progress");
    if (version === shown && progress && body.contains(progress)) { progress.textContent = partial; return; }
    shown = version;
    // Chess.com's own board is on the page, so the recap points at it instead of drawing one.
    body.replaceChildren(recapCard(recap, false, { board: false, sameTab: true }));
    if (partial) body.insertAdjacentHTML("beforeend", `<p class="fine progress" role="status">${esc(partial)}</p>`);
    else if (basis < 150) body.insertAdjacentHTML("beforeend",
      `<p class="fine">Based on your last ${basis} games so far. The rest are added between games.</p>`);
    const n = due().length;
    if (n) body.insertAdjacentHTML("beforeend", `<p class="fine"><button class="linkish" data-act="review">${n} older position${n === 1 ? "" : "s"} to review</button></p>`);
    return;
  }
  shown = "";
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
    idle: `Open a finished game and its recap appears here.${queue.length ? ` ${whenNext()}` : ""}`,
    loading: "Looking up this game…",
    finished: "",
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
  // open the panel on whichever side of the cube has room, or centered when neither does (narrow windows)
  const width = Math.min(340, window.innerWidth - 16);
  const cubeLeft = window.innerWidth - pos.right - 44, cubeRight = window.innerWidth - pos.right;
  if (cubeLeft - 8 >= width) { panel.style.right = `${pos.right + 52}px`; panel.style.left = ""; }
  else if (window.innerWidth - cubeRight - 8 >= width) { panel.style.left = `${cubeRight + 8}px`; panel.style.right = ""; }
  else { panel.style.left = `${Math.round((window.innerWidth - width) / 2)}px`; panel.style.right = ""; }
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
let dragged = false;
cube.addEventListener("pointerup", () => {
  dragged = !!drag?.moved;
  if (dragged) void save("position", pos);
  drag = null;
});
// A click (or Enter or Space on the focused cube) opens the panel, unless it ended a drag.
cube.addEventListener("click", () => {
  if (dragged) { dragged = false; return; }
  togglePanel();
});
window.addEventListener("resize", place);

// The dot on the cube means a recap you have not opened yet; it goes once you open it.
const SEEN = "chess-check-seen";
function wasSeen(id: string | null): boolean {
  try { return !!id && (sessionStorage.getItem(SEEN) ?? "").split(",").includes(id); } catch { return false; }
}
function markSeen(id: string | null) {
  if (!id || wasSeen(id)) return;
  try { sessionStorage.setItem(SEEN, [...(sessionStorage.getItem(SEEN) ?? "").split(",").filter(Boolean).slice(-20), id].join(",")); }
  catch { /* the dot stays */ }
}

function togglePanel(force?: boolean) {
  const open = force ?? panel.classList.contains("hidden");
  const wasOpen = !panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !open);
  if (open && state === "ready") { markSeen(lastId); cube.classList.add("seen"); }
  if (open && state === "idle" && !queue.length && whoAmI()) void collect(null, whoAmI()!).then(() => renderPanel());
  cube.setAttribute("aria-expanded", String(open));
  if (open) renderPanel();
  else if (wasOpen) cube.focus();
}
root.querySelector('[data-act="close"]')!.addEventListener("click", () => togglePanel(false));
// Escape closes the panel whether focus is in it or still on the cube that opened it
for (const el of [panel, cube]) el.addEventListener("keydown", e => {
  if (e.key === "Escape" && !panel.classList.contains("hidden")) { e.stopPropagation(); togglePanel(false); }
});

// "Find it on the board" reloads this page at the move; reopen the recap when it is back.
const REOPEN = "chess-check-reopen";
const REVIEW = "chess-check-review";      // the review position the page was opened at
function takeReview(id: string | null): string | null {
  try {
    const item = sessionStorage.getItem(REVIEW);
    if (!id || !item || !item.startsWith(`${id}:`)) return null;
    sessionStorage.removeItem(REVIEW);
    return item;
  } catch { return null; }
}
panel.addEventListener("click", e => {
  if (view === "game" && (e.target as HTMLElement).closest(".quiz-board") && lastId) {
    try { sessionStorage.setItem(REOPEN, lastId); } catch { /* the panel stays closed */ }
  }
});
function takeReopen(id: string | null): boolean {
  try {
    if (!id || sessionStorage.getItem(REOPEN) !== id) return false;
    sessionStorage.removeItem(REOPEN);
    return true;
  } catch { return false; }
}
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
  lastId = id; players = null; served = null; viewer = ""; recap = null; partial = "";
  if (!id) {
    view = "game";
    const me = whoAmI();
    if (me && queueOwner !== me.toLowerCase()) await loadQueue(me);
    setState("idle");
    if (canWarm(url) && me) void ask({ type: "warm", username: me })
      .then(r => { if (r.status === "ready") void collect(null, me); })
      .catch(() => { /* try again next page */ });
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
      // a live game is checked often even when Chess.com already serves it unfinished
      timer = setTimeout(check, /\/daily\//.test(new URL(url).pathname) ? DAILY_POLL_MS : LIVE_POLL_MS);
      return;
    }
    served = g; players = g.players;
  } catch (e) { setState("error", (e as Error).message); return; }
  const me = signedInUser()?.toLowerCase();
  const mine = [players.white, players.black].find(n => me ? n.toLowerCase() === me : accounts.includes(n.toLowerCase()));
  if (!mine) { setState("choose"); return; }
  viewer = mine;
  if (queueOwner !== mine.toLowerCase()) await loadQueue(mine);
  const reviewing = takeReview(id);
  if (reviewing) { setState("finished"); openReview(reviewing); return; }
  view = "game";
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
    case "recap":
      recap = reply.recap; basis = reply.games; partial = reply.partial ?? "";
      if (!reply.partial) void collect(recap, viewer);     // complete, so the profile exists too
      if (state !== "ready" || !panel.classList.contains("hidden")) setState("ready");
      if (takeReopen(id)) togglePanel(true);
      if (reply.partial && reply.retry !== false) timer = setTimeout(requestRecap, 1000);
      break;
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
