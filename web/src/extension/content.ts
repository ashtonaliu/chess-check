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
import { formatBoardGrade, isBoardAnswerFound, type BoardGradeResult } from "../browser/boardPlacement";
import type { Recap } from "../browser/recap";
import { addItems, applyReviewRates, grade, itemFromRecap, patchItems, pendingReviewRates, reviewRateSentence,
  type ReviewItem } from "../browser/reviewQueue";
import { createRecapView, esc, moveLink, quizHint, tacticSentence } from "../ui/recapCard";
import { DEFAULT_SITE, defaultSitePages, pageSite, type FinishedPage } from "../browser/site";
import { BoardWatcher } from "./boardWatch";
import { gameIdFromPage, isPlayPage } from "./guard";
import { loadStoredQueue, queueKey, updateQueue, type QueueDeps } from "./queueStore";
import {
  afterLookup, cubeLook, daysAgo, dueNow, markFind, markSeen, panelView, reviewAllowed, reviewCard, StallWatch,
  takeBoardIntent, wasSeen, whenNext, type BoardIntent, type State, type View,
} from "./panelModel";
import type { Reply, Request } from "./offscreen";

const KNIGHT = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor"
  d="M7 21h11v-2.2c0-1.6-.6-3-1.6-4.2l-1-1.2c.9-.8 1.4-2 1.2-3.3-.3-2.3-2.1-4.4-4.6-5.3L11 3l-1 1.6C7.4 6 5.5 8.6 5.6 11.2l2.8-.6c.6.6.6 1.6 0 2.2l-1.3 1.4C6.4 15.1 6 16.3 6 17.5V19H7v2z"/></svg>`;

// ---------- messaging and storage (real extension, or the dev harness's stand-ins) ----------

/** A request to the analysis page. Each answers within a second or two (long work continues in the
 *  background and is asked about again), so a missing answer means something broke: say so. */
const ASK_TIMEOUT_MS = 20_000;
const ask = (req: Request) => Promise.race([
  chrome.runtime.sendMessage<Reply>({ ...req, target: "bg", site: site.id }),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
    "the extension did not answer. Reload the page, or reload Chess Check in chrome://extensions.")), ASK_TIMEOUT_MS)),
]);
async function load<T>(key: string, fallback: T): Promise<T> {
  try { return ((await chrome.storage.local.get([key]))[key] as T) ?? fallback; } catch { return fallback; }
}
async function save(key: string, value: unknown) {
  try { await chrome.storage.local.set({ [key]: value }); } catch { /* not remembered */ }
}
const address = () => (window as Window & { __ccPageUrl?: string }).__ccPageUrl ?? location.href;
const site = pageSite(address()) ?? defaultSitePages;
const readPageUrl = () => site.publicPageUrl?.(new URL(address())) ?? address();
const initialPageUrl = readPageUrl();
const unmarkedPage = initialPageUrl.split("#")[0];
// Lichess removes the replay fragment once it has used it to set the initial position.
const pageUrl = () => {
  const current = readPageUrl();
  return site.id === "lichess" && current === unmarkedPage ? initialPageUrl : current;
};
const accountKey = site.id === DEFAULT_SITE ? "accounts" : `accounts:${site.id}`;
let signedIn: string | null = null;
const signedInUser = () => (signedIn = site.signedInUser(document));

type Players = FinishedPage["players"];

// ---------- DOM ----------

const host = document.createElement("div");
host.style.cssText = "position:fixed;z-index:2147483000;width:0;height:0;";
host.classList.add("hidden");
declare const __CC_TEST__: boolean;
const root = host.attachShadow({ mode: typeof __CC_TEST__ !== "undefined" && __CC_TEST__ ? "open" : "closed" });
root.innerHTML = `<style>${siteCss.replace(/:root/g, ":host")}
  :host { all: initial; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); }
  :host(.hidden) { display: none !important; }
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
  .review .board-note { font-size: 12px; color: var(--muted); }
  .review .board-grade { font-weight: 700; }
  .review .board-grade.good { color: var(--good); }
  .review .board-grade.weak { color: var(--weak); }
  .cube:active { cursor: grabbing; }
  .panel { position: fixed; width: 340px; max-width: calc(100vw - 16px); box-sizing: border-box; overflow: auto; background: var(--bg); color: var(--ink);
    border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.45); border: 1px solid var(--line); padding: 12px 14px; }
  .panel.compact { width: 280px; padding: 10px 12px; }
  .panel.compact .head { margin-bottom: 4px; justify-content: flex-end; }
  .panel.compact .head > span:first-child { display: none; }
  .panel.compact .fine { display: none; }
  .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-weight: 700; }
  .head button { background: none; color: var(--muted); padding: 2px 6px; font-weight: 600; }
  .panel .note { font-size: 13px; }
  .who { display: grid; gap: 8px; margin-top: 8px; }
  .recap { border: none; padding: 0; }
  .fine { font-size: 11px; color: var(--muted); margin: 10px 0 0; }
  .hidden { display: none !important; }
</style>
<button class="cube" title="Chess Check: post-game recap" aria-label="Chess Check" aria-expanded="false" aria-controls="cc-panel">${KNIGHT}</button>
<div class="panel hidden" id="cc-panel" role="dialog" aria-label="Chess Check recap">
  <div class="head"><span>Chess Check</span><span><button data-act="reset" hidden>Change player</button><button data-act="close" aria-label="Close">✕</button></span></div>
  <div class="body"></div>
  <p class="fine">Recaps appear only after ${site.name} lists a game as finished. Nothing is shown or analyzed during a game.</p>
</div>`;
const cube = root.querySelector(".cube") as HTMLButtonElement;
const panel = root.querySelector(".panel") as HTMLElement;
const body = root.querySelector(".body") as HTMLElement;
const reset = root.querySelector<HTMLButtonElement>('[data-act="reset"]')!;

let state: State = "idle";
let accounts: string[] = [];              // usernames the user has said are theirs (lowercase)
let players: Players | null = null;       // the game in the tab
let served: FinishedPage | null = null;
let viewer = "";                          // whose recap to show for this game
let recap: Recap | null = null;
let basis = 150;                          // how many of your past games the recap's profile used
let partial = "";                         // what the recap is still waiting for ("" when complete)
let recapView: ReturnType<typeof createRecapView> | null = null;
let message = "";
let timer: ReturnType<typeof setTimeout> | null = null;

// ---------- review queue ----------

let view: View = "game";
let queue: ReviewItem[] = [];
let queueOwner = "";                      // whose queue is loaded (lowercase)
let current: string | null = null;        // the position being asked
let reviewRevealed = false;

async function loadQueue(user: string | null, isCurrent = () => true) {
  const u = (user ?? "").toLowerCase();
  const next = u ? await loadStoredQueue(queueKey(u, site.id)) : [];
  if (!isCurrent()) return;
  queue = next;
  queueOwner = u;
}
// Every change goes through queueStore.updateQueue: applied to the latest saved queue under a lock
// all Chess.com tabs share, so a tab with an older copy cannot undo another tab's grade.
const queueDeps: QueueDeps = {
  load: loadStoredQueue,
  save,
  lock: typeof navigator !== "undefined" && navigator.locks
    ? (name, fn) => navigator.locks.request(name, () => fn()) as unknown as Promise<ReviewItem[]> : null,
};
async function changeQueue(change: (q: ReviewItem[]) => ReviewItem[]) {
  const u = queueOwner;
  if (!u) return;
  try {
    const next = await updateQueue(queueDeps, u, change, site.id);
    if (queueOwner === u) queue = next;
  } catch { /* not saved; the next change tries again */ }
}
// another tab changed the queue: show its version
try {
  chrome.storage.onChanged?.addListener((changes, area) => {
    const c = area === "local" && queueOwner ? changes[queueKey(queueOwner, site.id)] : undefined;
    if (!c) return;
    queue = (c.newValue as ReviewItem[] | undefined) ?? [];
    refreshReviewDisplay();
  });
} catch { /* development harness */ }

const due = () => (queueOwner ? dueNow(queue, pageUrl(), state, Date.now()) : []);
const nextText = () => whenNext(queue, Date.now(), reviewAllowed(pageUrl(), state));
let session: Storage | null = null;      // this tab's sessionStorage, when the page allows it
try { session = sessionStorage; } catch { /* markers are not kept */ }
const store = session ?? { getItem: () => null, setItem: () => {}, removeItem: () => {} };

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

/** Draw the cube from the model: its color, dot, count and title. */
function decorateCube() {
  const look = cubeLook(state, pageUrl(), due().length, wasSeen(store, lastId));
  cube.className = ["cube", ...look.classes].join(" ");
  cube.dataset.count = look.count;
  cube.title = look.title;
  cube.setAttribute("aria-label", look.title);
}

/** Queue writes can finish after the recap has already been rendered. */
function refreshReviewDisplay() {
  decorateCube();
  if (panel.classList.contains("hidden")) return;
  if (state === "ready" && view === "game") {
    updateRecapReviewLink();
  } else if (view === "review" || state === "idle") {
    renderPanel();
  }
}

function updateRecapReviewLink() {
  const link = body.querySelector<HTMLElement>(".recap-review");
  if (!link) return;
  const n = due().length;
  const label = `${n} older position${n === 1 ? "" : "s"} to review`;
  const button = link.querySelector("button")!;
  if (button.textContent !== label) button.textContent = label;
  link.hidden = !n;
}

let asked: ReviewItem | null = null;   // the entry as this tab asked it, to grade against
const gradedVisits = new Set<string>(); // first attempt per card per visit
let boardResult: { item: ReviewItem; grade: Exclude<BoardGradeResult, { kind: "not-a-move" | "game-move" }>; back: "back" | "show" | null } | null = null;
let checkingCardId: string | null = null;
let boardError = "";

function setCompact(compact: boolean) {
  if (panel.classList.contains("compact") === compact) return;
  panel.classList.toggle("compact", compact);
  placeTries = 0;
  place();
}

const boardWatcher = new BoardWatcher({
  doc: document,
  readBoard: doc => site.readBoard(doc),
  onCandidateMove: (itemId, placement) => { void handleBoardMove(itemId, placement); },
});

async function handleBoardMove(itemId: string, placement: string) {
  const item = asked;
  if (!item || item.id !== itemId || current !== itemId || !item.fen || gradedVisits.has(itemId)
      || !reviewAllowed(pageUrl(), state) || panel.classList.contains("hidden") || view !== "review") {
    return;
  }
  const version = checkVersion;
  checkingCardId = itemId;
  boardError = "";
  renderPanel();
  let reply: Reply;
  try {
    reply = await ask({ type: "grade-move", fen: item.fen, board: placement, best: item.best, played: item.san });
  } catch (e) {
    if (version !== checkVersion || checkingCardId !== itemId) return;
    checkingCardId = null;
    boardError = (e as Error).message;
    boardWatcher.resume(itemId);
    renderPanel();
    return;
  }
  if (version !== checkVersion || current !== itemId || panel.classList.contains("hidden")
      || view !== "review" || gradedVisits.has(itemId)) {
    if (checkingCardId === itemId) checkingCardId = null;
    return;
  }
  checkingCardId = null;
  if (reply.status !== "grade") {
    boardError = reply.status === "error" ? reply.message : "";
    boardWatcher.resume(itemId);
    renderPanel();
    return;
  }
  if (reply.result.kind === "not-a-move" || reply.result.kind === "game-move") {
    // Stepping forward through the game shows the move that was played, so it is not an answer.
    if (reply.result.kind === "game-move") {
      boardError = `${reply.result.san} is the move from the game. Go back a move and try another, or reveal the answer.`;
    }
    boardWatcher.resume(itemId);
    renderPanel();
    return;
  }
  gradedVisits.add(itemId);
  boardWatcher.stop();
  const card = reviewCard(due(), current, state, !!recap, pageUrl(), tally(), nextText());
  const found = isBoardAnswerFound(reply.result);
  const now = Date.now(), shown = { step: item.step, due: item.due };
  queue = grade(queue, itemId, found, now, shown);
  addTally(found);
  void changeQueue(q => grade(q, itemId, found, now, shown)).then(decorateCube);
  boardResult = { item, grade: reply.result, back: card.back };
  renderPanel();
  decorateCube();
}

function openReview(id: string | null = null) {
  view = "review"; current = id; reviewRevealed = false; boardResult = null; checkingCardId = null; boardError = "";
  if (panel.classList.contains("hidden")) togglePanel(true); else renderPanel();
  void rateQueuedItems(queueOwner);
}

function renderReview() {
  if (boardResult) {
    boardWatcher.stop();
    setCompact(true);
    const { item: it, grade: res, back: backKind } = boardResult;
    const found = isBoardAnswerFound(res);
    const tags = tacticSentence(it.tactics.filter(x => x.kind === "missed"));
    const odds = reviewRateSentence(it);
    const details = `${tags}${odds}`.trim();
    const more = due().length;
    const back = backKind === "back" ? `<button class="linkish" data-act="back">Back to this game's recap</button>`
      : backKind === "show" ? `<button class="linkish" data-act="recap">Show this game's recap</button>` : "";
    body.innerHTML = `<div class="review">
      <p class="board-grade ${found ? "good" : "weak"}">${esc(formatBoardGrade(res))}</p>
      ${details ? `<p>${esc(details)}</p>` : ""}
      <div class="grade"><button type="button" data-act="next-review">${more ? "Next position" : "Done"}</button></div>
      ${back ? `<p>${back}</p>` : ""}</div>`;
    return;
  }
  const card = reviewCard(due(), current, state, !!recap, pageUrl(), tally(), nextText());
  const back = card.back === "back" ? `<button class="linkish" data-act="back">Back to this game's recap</button>`
    : card.back === "show" ? `<button class="linkish" data-act="recap">Show this game's recap</button>` : "";
  if (card.kind === "done") {
    boardWatcher.stop();
    setCompact(false);
    body.innerHTML = `<div class="review"><p>${esc(card.summary)}</p>${back ? `<p>${back}</p>` : ""}</div>`;
    current = null;
    return;
  }
  const { item: it, position: pos, total, here } = card;
  setCompact(here);
  current = it.id; asked = it;
  const tags = tacticSentence(it.tactics.filter(x => x.kind === "missed"));   // the hint already said what it allowed
  const odds = reviewRateSentence(it);
  const alreadyGraded = gradedVisits.has(it.id);
  const boardNote = !here || reviewRevealed ? ""
    : checkingCardId === it.id ? `<p class="board-note">Checking your move…</p>`
    : alreadyGraded ? `<p class="board-note">First attempt already graded on this visit.</p>`
    : `<p class="board-note">Play your move on the board. Only your first move is graded.</p>`;
  body.innerHTML = `<div class="review">
    <p class="count">Review · ${pos} of ${total}</p>
    <p>From your game vs ${esc(it.opponent)} ${esc(daysAgo(it.endTime, Date.now()))}.
      You played <span class="moves">${esc(it.label)}</span> and lost <strong class="weak">${Math.round(it.loss)}%</strong>.
      Find the better move.<span class="quiz-q">${esc(quizHint(it.tactics))}</span></p>
    ${boardNote}${boardError && here ? `<p class="board-note">${esc(boardError)}</p>` : ""}
    ${reviewRevealed
      ? `<p><span class="lbl">Answer</span>Better was <span class="moves">${esc(it.best)}</span>.${esc(tags)}${esc(odds)}</p>
         <div class="grade"><button type="button" data-grade="1">Got it</button><button type="button" class="missed" data-grade="0">Missed it</button></div>`
      : `<div class="quiz-actions">${here ? "" : `<a class="quiz-board" data-review="${esc(it.id)}" href="${esc(moveLink(it.url, it.ply))}">Find it on the board</a>`}
           <button type="button" class="quiz-reveal">Reveal the move</button></div>`}
    ${back ? `<p>${back}</p>` : ""}</div>`;
  boardWatcher.sync({
    pageUrl: pageUrl(), state, view,
    panelOpen: !panel.classList.contains("hidden"),
    card,
    alreadyGraded: alreadyGraded || reviewRevealed,
  });
}

panel.addEventListener("click", e => {
  const el = e.target as HTMLElement;
  if (view !== "review") {
    if (el.closest('[data-act="review"]')) openReview();
    return;
  }
  if (el.closest(".quiz-board")) return;   // marked by the listener below; the link loads the game
  if (el.closest('[data-act="next-review"]')) {
    boardResult = null; current = null; reviewRevealed = false; checkingCardId = null; boardError = "";
    renderPanel(); decorateCube();
    return;
  }
  if (el.closest(".quiz-reveal")) {
    boardWatcher.stop(); reviewRevealed = true; checkingCardId = null; boardError = "";
    renderPanel(); body.querySelector<HTMLButtonElement>("[data-grade]")?.focus();
    return;
  }
  const g = el.closest<HTMLElement>("[data-grade]");
  if (g && current && asked?.id === current) {
    const found = g.dataset.grade === "1", id = current, now = Date.now(), shown = { step: asked.step, due: asked.due };
    gradedVisits.add(id); boardWatcher.stop(); boardResult = null;
    queue = grade(queue, id, found, now, shown); addTally(found);           // shown at once,
    // and saved onto the latest, unless another tab already answered this same question
    void changeQueue(q => grade(q, id, found, now, shown)).then(decorateCube);
    current = null; reviewRevealed = false; renderPanel(); decorateCube();
    return;
  }
  if (el.closest('[data-act="back"]')) { boardWatcher.stop(); boardResult = null; setCompact(false); view = "game"; renderPanel(); return; }
  if (el.closest('[data-act="recap"]')) { boardWatcher.stop(); boardResult = null; setCompact(false); view = "game"; void requestRecap(); }
});

/** Add a finished game's turning point, and start an empty queue from the games already analyzed. */
const seedAsked = new Set<string>();      // once per page load and player
const ratingInFlight = new Set<string>();

async function rateQueuedItems(user: string) {
  if (!user || queueOwner !== user || !reviewAllowed(pageUrl(), state)) return;
  const items = pendingReviewRates(queue).filter(item => !ratingInFlight.has(item.id));
  if (!items.length) return;
  for (const item of items) ratingInFlight.add(item.id);
  try {
    const reply = await ask({ type: "rate", items });
    if (reply.status === "rates" && queueOwner === user && reviewAllowed(pageUrl(), state)) {
      await changeQueue(q => applyReviewRates(q, reply.rates));
      refreshReviewDisplay();
    }
  } catch { /* the next visit can retry */ }
  finally { for (const item of items) ratingInFlight.delete(item.id); }
}

async function collect(r: Recap | null, user: string) {
  const u = user.toLowerCase();
  if (queueOwner !== u) await loadQueue(u);
  if (!reviewAllowed(pageUrl(), state)) return;
  const it = r ? itemFromRecap(r, Date.now()) : null;
  if (it && !queue.some(q => q.id === it.id)) await changeQueue(q => addItems(q, [it]));
  // an empty queue starts from the profile; entries saved before positions were kept get theirs
  const missing = queue.some(q => !q.fen || q.timeClass === undefined);
  const seededKey = site.id === DEFAULT_SITE ? `seeded:${u}` : `seeded:${site.id}:${u}`;
  if (!seedAsked.has(u) && (missing || !(await load<boolean>(seededKey, false))) && reviewAllowed(pageUrl(), state)) {
    seedAsked.add(u);
    try {
      const reply = await ask({ type: "seed", username: user });
      if (reply.status === "seed" && reply.items.length && queueOwner === u) {
        const seed = !(await load<boolean>(seededKey, false));
        // entries the profile cannot fill (from games outside it) are marked so they are not asked about again
        await changeQueue(q => patchItems(seed ? addItems(q, reply.items) : q, reply.items)
          .map(i => (i.timeClass === undefined ? { ...i, timeClass: "unknown" } : i)));
        if (seed) void save(seededKey, true);
      }
    } catch { /* try again later */ }
  }
  await rateQueuedItems(u);
  refreshReviewDisplay();
}

function setState(s: State, msg = "") {
  state = s; message = msg;
  if (s === "ready" && !panel.classList.contains("hidden")) markSeen(store, lastId);   // arrived while open
  decorateCube();
  if (!panel.classList.contains("hidden")) renderPanel();
}

type RecapStage = "confirmed" | "result" | "turning" | "opponent" | "complete";
let timingInstall = false;
let devInfo: Promise<{ dev: boolean; built?: string | null }> | undefined;
let timingStart = 0;
let timingStages: Partial<Record<RecapStage, number>> = {};
let timingCacheHit = false;

function markRecapStage(stage: RecapStage) {
  if (!timingInstall || timingStages[stage] !== undefined) return;
  timingStages[stage] = performance.measure(`cc:recap stage ${stage}`, { start: timingStart }).duration;
  host.dataset.chessCheckRecapTiming = JSON.stringify({ stages: timingStages, games: basis, cached: timingCacheHit });
}

function renderPanel() {
  reset.hidden = !accounts.length || !!signedIn;
  view = panelView(view, state, pageUrl(), due().length);
  if (view === "review") { renderReview(); return; }
  boardWatcher.stop();
  boardResult = null;
  setCompact(false);
  if (state === "ready" && recap) {
    // Keep the turning point and its controls mounted while the history fills in.
    if (!recapView || !body.contains(recapView.element)) {
      recapView = createRecapView({ sameTab: true });
      body.replaceChildren(recapView.element);
      body.insertAdjacentHTML("beforeend", `<p class="fine recap-progress" role="status"></p>
        <p class="fine recap-review" hidden><button class="linkish" data-act="review"></button></p>`);
    }
    recapView.update(recap);
    const progress = body.querySelector<HTMLElement>(".recap-progress")!;
    const status = partial || (basis < 150 ? `Based on your last ${basis} games so far. The rest are added between games.` : "");
    if (progress.textContent !== status) progress.textContent = status;
    progress.hidden = !status;
    updateRecapReviewLink();
    if (typeof __CC_PROFILE__ !== "undefined" && __CC_PROFILE__) {
      markRecapStage("result");
      if (!recap.pending?.turning && !recap.turningError) markRecapStage("turning");
      if (recap.opponentNote) markRecapStage("opponent");
      if (!partial) markRecapStage("complete");
    }
    return;
  }
  if (state === "choose" && players) {
    const names = [players.white, players.black];
    const me = signedInUser();
    const known = me ? [me] : accounts;
    const intro = known.length
      ? `This is not one of your games (${esc(known.join(", "))}). Whose recap do you want?`
      : `Which player are you? Chess Check remembers this, so you only answer once. Signing in to ${site.name} skips this.`;
    body.innerHTML = `<p class="note">${intro}</p><div class="who">${names.map(n =>
      `<button data-name="${esc(n)}">${known.length ? "Recap for " : "I am "}${esc(n)}</button>`).join("")}</div>`;
    body.querySelectorAll<HTMLButtonElement>("button[data-name]").forEach(b => b.addEventListener("click", () => {
      const name = b.dataset.name!;
      if (!known.length) { accounts = [name.toLowerCase()]; void save(accountKey, accounts); }
      viewer = name;
      setState("loading", "Loading your recap…");
      void requestRecap();
    }));
    return;
  }
  const text: Record<State, string> = {
    choose: "", ready: "",
    idle: ["Open one of your finished games to see its recap.", nextText()].filter(Boolean).join(" "),
    loading: message || "Looking up this game…",
    finished: "", aborted: "This game was aborted.",
    building: `Setting up for ${viewer}: ${message}`,
    pending: "<strong>Your recap will appear when this game ends.</strong>",
    error: `Something went wrong: ${message}`,
  };
  body.innerHTML = `<p class="note">${state === "pending" ? text[state] : esc(text[state])}</p>`;
}

// ---------- position and dragging ----------

let pos = { right: 24, bottom: 120 };
let placeRetry: ReturnType<typeof setTimeout> | undefined, placeTries = 0;
function place() {
  clearTimeout(placeRetry);
  pos.right = Math.min(Math.max(pos.right, 4), window.innerWidth - 48);
  pos.bottom = Math.min(Math.max(pos.bottom, 4), window.innerHeight - 48);
  cube.style.right = `${pos.right}px`; cube.style.bottom = `${pos.bottom}px`;
  if (panel.classList.contains("compact")) {
    // Keep the compact review card off the board and the move list where the player's try appears:
    // left of the board when there is room, else at the bottom of the column right of the board
    // (below Chess.com's move list), else the bottom-left corner on narrow windows.
    const width = Math.min(280, window.innerWidth - 16);
    const boardRect = reviewAllowed(pageUrl(), state) ? site.readBoard(document)?.element.getBoundingClientRect() : null;
    if (boardRect && boardRect.width > 0 && boardRect.left >= width + 16) {
      const top = Math.max(8, Math.round(boardRect.top));
      panel.style.left = `${Math.max(8, Math.round(boardRect.left - width - 12))}px`;
      panel.style.right = "";
      panel.style.top = `${top}px`;
      panel.style.bottom = "";
      panel.style.maxHeight = `${Math.max(160, window.innerHeight - top - 8)}px`;
    } else if (boardRect && boardRect.width > 0 && window.innerWidth - boardRect.right >= width + 24) {
      // 120px up, where the full panel sits, leaves the site's move buttons below it clickable.
      panel.style.left = `${Math.round(boardRect.right + 12)}px`;
      panel.style.right = "";
      panel.style.bottom = "120px";
      panel.style.top = "";
      panel.style.maxHeight = `${Math.min(360, window.innerHeight - 128)}px`;
    } else {
      // The site may not have drawn its board yet when the card turns compact; look again shortly.
      if (!boardRect && placeTries < 10) { placeTries++; placeRetry = setTimeout(place, 500); }
      panel.style.left = "8px";
      panel.style.right = "";
      panel.style.bottom = "8px";
      panel.style.top = "";
      panel.style.maxHeight = `${Math.min(360, window.innerHeight - 16)}px`;
    }
    return;
  }
  // open the panel on whichever side of the cube has room, or centered when neither does (narrow windows)
  const width = Math.min(340, window.innerWidth - 16);
  const cubeLeft = window.innerWidth - pos.right - 44, cubeRight = window.innerWidth - pos.right;
  const beside = cubeLeft - 8 >= width || window.innerWidth - cubeRight - 8 >= width;
  if (cubeLeft - 8 >= width) { panel.style.right = `${pos.right + 52}px`; panel.style.left = ""; }
  else if (window.innerWidth - cubeRight - 8 >= width) { panel.style.left = `${cubeRight + 8}px`; panel.style.right = ""; }
  else { panel.style.left = `${Math.round((window.innerWidth - width) / 2)}px`; panel.style.right = ""; }
  // When there is no room beside the cube, leave its button clear above or below the panel.
  const cubeTop = window.innerHeight - pos.bottom - 44;
  const offset = beside ? 0 : 52;
  const maxHeight = beside ? window.innerHeight : Math.max(240, window.innerHeight * 0.43);
  if (cubeTop < window.innerHeight / 2) {
    const top = Math.max(cubeTop + offset, 8);
    panel.style.top = `${top}px`; panel.style.bottom = "";
    panel.style.maxHeight = `${Math.min(maxHeight, window.innerHeight - top - 8)}px`;
  } else {
    const bottom = Math.max(pos.bottom + offset, 8);
    panel.style.bottom = `${bottom}px`; panel.style.top = "";
    panel.style.maxHeight = `${Math.min(maxHeight, window.innerHeight - bottom - 8)}px`;
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


function togglePanel(force?: boolean) {
  const open = force ?? panel.classList.contains("hidden");
  const wasOpen = !panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !open);
  if (!open) {
    boardWatcher.stop();
    boardResult = null;
    checkingCardId = null;
    boardError = "";
    setCompact(false);
  }
  if (open && state === "ready") { markSeen(store, lastId); decorateCube(); }
  if (open && state === "idle" && reviewAllowed(pageUrl(), state)
      && (!queue.length || pendingReviewRates(queue).length || queue.some(q => !q.fen || q.timeClass === undefined))) {
    const user = whoAmI();
    if (user) void collect(null, user);
  }
  cube.setAttribute("aria-expanded", String(open));
  if (open) renderPanel();
  else if (wasOpen) cube.focus();
}
root.querySelector('[data-act="close"]')!.addEventListener("click", () => togglePanel(false));
// Escape closes the panel whether focus is in it or still on the cube that opened it
for (const el of [panel, cube]) el.addEventListener("keydown", e => {
  if (e.key === "Escape" && !panel.classList.contains("hidden")) { e.stopPropagation(); togglePanel(false); }
});

// "Find it on the board" loads the game at the move; remember what to reopen once it is back.
panel.addEventListener("click", e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = (e.target as HTMLElement).closest<HTMLAnchorElement>(".quiz-board");
  const game = link && gameIdFromPage(link.href);
  if (!game || !link) return;
  markFind(store, game, link.dataset.review ?? null);
  if (site.id === "lichess" && link.href.split("#")[0] === location.href.split("#")[0]) {
    // Lichess initializes the replay from the fragment on page load. Changing only the fragment
    // fires a route change in this page first, and a check here would take the intent that the
    // reloaded page needs to reopen the panel, so this page stops checking.
    e.preventDefault();
    leaving = true;
    location.href = link.href;
    location.reload();
  }
});
reset.addEventListener("click", () => {
  accounts = []; void save(accountKey, accounts); lastId = null; void check();
});

// ---------- the game in the tab ----------

let lastId: string | null = null;
let checkVersion = 0;
let lookup: AbortController | null = null;
let boardIntent: BoardIntent | null = null;
let retryBoardLookup = false;
let leaving = false;                      // reloading for "Find it on the board"; leave the intent alone

/** The signed-in user, or the one picked earlier when signed out. */
const whoAmI = () => signedInUser() ?? accounts[0] ?? null;

/** Called when the address changes, and every few seconds while a live game is in progress. */
async function check() {
  if (leaving) return;
  const url = pageUrl();
  const id = gameIdFromPage(url);
  const onPlay = isPlayPage(new URL(url));
  host.classList.toggle("hidden", onPlay);
  const intent = takeBoardIntent(store, id);
  // Same game as before (Chess.com rewrites /game/<id> to /live/game/<id> after loading): leave
  // any polling running. Clearing the timer first left the cube stuck on "Setting up" for good.
  // Pages that are not games always run, to warm up or stop.
  if (id && id === lastId && state !== "error" && state !== "pending") {
    // Only the move changed (the site's arrows): an open review card may now be at its position again.
    if (view === "review" && !panel.classList.contains("hidden")) renderPanel();
    return;
  }
  const pageKey = site.pageSafetyKey(new URL(url));
  const markPage = (finished: boolean) => ask({ type: "page-state", pageKey, finished }).catch(() => {});
  const changedGame = id !== lastId;
  if (typeof __CC_PROFILE__ !== "undefined" && __CC_PROFILE__ && timingInstall && changedGame) {
    timingStart = performance.now();
    timingStages = {};
    timingCacheHit = false;
    delete host.dataset.chessCheckRecapTiming;
  }
  if (changedGame || onPlay) {
    boardWatcher.stop();
    gradedVisits.clear();
    boardResult = null;
    checkingCardId = null;
    boardError = "";
    togglePanel(false);
  }
  if (id !== lastId || intent) {
    boardIntent = intent;
    retryBoardLookup = !!intent;
  }
  const version = ++checkVersion;
  lookup?.abort();
  lookup = null;
  const isCurrent = () => version === checkVersion
    && (id ? gameIdFromPage(pageUrl()) === id : pageUrl() === url);
  if (timer) { clearTimeout(timer); timer = null; }
  lastId = id; players = null; served = null; viewer = ""; recap = null; partial = "";
  const pageMarked = markPage(false);
  if (!id) {
    view = "game";
    if (onPlay) {
      togglePanel(false);
      setState("idle");
      return;
    }
    const me = whoAmI();
    if (me && queueOwner !== me.toLowerCase()) await loadQueue(me, isCurrent);
    await pageMarked;
    if (!isCurrent()) return;
    setState("idle");
    if (me) void rateQueuedItems(me.toLowerCase());
    if (me) void ask({ type: "warm", username: me })
      .then(r => {
        if (!isCurrent()) return;
        if (r.status === "ready") void collect(null, me);
        if (r.status === "paused") timer = setTimeout(check, 3_000);
      })
      .catch(() => { /* try again next page */ });
    return;
  }
  if (state !== "pending") setState("loading");      // a recheck of a game in progress stays on "pending"
  try {
    lookup = new AbortController();
    const g = await site.lookupFinishedPage(id, new URL(url), lookup.signal);
    if (!isCurrent()) return;
    const reopen = boardIntent && boardIntent.expires > Date.now() ? boardIntent : null;
    const finished = g && typeof g === "object" && "players" in g ? g : null;
    const step = afterLookup(finished ? { finished: true, ...finished.players } : g as Exclude<typeof g, FinishedPage>,
                             url, finished ? signedInUser() : null, accounts,
                             reopen?.item ?? null, !!reopen && !reopen.item);
    if (step.next === "pending") {
      setState("pending");
      timer = setTimeout(check, step.delay);
      return;
    }
    await pageMarked;
    if (!isCurrent()) return;
    await markPage(true);
    if (!isCurrent()) return;
    boardIntent = null;
    if (step.next === "aborted") { setState("aborted"); return; }
    served = finished;
    players = finished!.players;
    if (typeof __CC_PROFILE__ !== "undefined" && __CC_PROFILE__ && timingInstall) {
      markRecapStage("confirmed");
      togglePanel(true);
    }
    if (step.next === "choose") { setState("choose"); if (step.open) togglePanel(true); return; }
    viewer = step.viewer;
    if (queueOwner !== viewer.toLowerCase()) await loadQueue(viewer, isCurrent);
    if (!isCurrent()) return;
    if (step.next === "review") { setState("finished"); openReview(step.item); return; }
    if (step.open) { view = "game"; togglePanel(true); }
  } catch (e) {
    if (!isCurrent()) return;
    setState("error", (e as Error).message);
    if (retryBoardLookup && boardIntent && boardIntent.expires > Date.now()) {
      retryBoardLookup = false;
      timer = setTimeout(check, 1_000);
    } else {
      boardIntent = null;
    }
    return;
  }
  view = "game";
  await requestRecap();
}

async function requestRecap() {
  if (timer) { clearTimeout(timer); timer = null; }
  const id = lastId, g = served, version = checkVersion;
  if (!id || !viewer || !g) return;
  const isCurrent = () => version === checkVersion && gameIdFromPage(pageUrl()) === id;
  let reply: Reply;
  try { reply = await ask({ type: "recap", username: viewer, gameId: id, evidence: g.evidence }); }
  catch (e) { if (isCurrent()) setState("error", (e as Error).message); return; }
  if (!isCurrent()) return;
  switch (reply.status) {
    case "building": setState("building", reply.progress); timer = setTimeout(requestRecap, 1000); break;
    case "pending": setState("pending"); break;
    case "paused":
      setState("loading", "Recap paused while Play or an unconfirmed game is open.");
      timer = setTimeout(requestRecap, 3_000);
      break;
    case "recap":
      recap = reply.recap; basis = reply.games; partial = reply.partial ?? "";
      if (typeof __CC_PROFILE__ !== "undefined" && __CC_PROFILE__) timingCacheHit = !!reply.timingCacheHit;
      if (state !== "ready" || !panel.classList.contains("hidden")) setState("ready");
      if (!reply.partial) void collect(recap, viewer);     // complete, so the profile exists too
      if (reply.partial && reply.retry !== false) timer = setTimeout(requestRecap, 1000);
      break;
    case "error": setState("error", reply.message); break;
    case "ready": break;
  }
}

// Tell the analysis page when this page stutters, so a background profile build uses fewer workers
// (browser/pace.ts). Long frames are measured by the browser; only their timing is read.
try {
  const watch = new StallWatch(performance.now());
  const type = PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame") ? "long-animation-frame" : "longtask";
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      if (!host.classList.contains("hidden") && watch.frame(e.startTime + e.duration, e.duration, document.visibilityState === "visible")) {
        void ask({ type: "stalls" }).catch(() => { /* no build to slow down */ });
      }
    }
  }).observe({ type, buffered: false });
} catch { /* the browser cannot report long frames */ }

// Developer installs only: a page can ask the extension to reload itself after a new build
// (window.postMessage({ type: "chess-check:dev-reload" })), and the cube's host element carries the
// build time, so a test can check which build is running. The background script checks that this is
// an unpacked install before doing either; an install from the Chrome Web Store ignores both.
try {
  const info = chrome.runtime.sendMessage<{ dev: boolean; built?: string | null }>({ target: "dev", type: "info" });
  if (typeof __CC_PROFILE__ !== "undefined" && __CC_PROFILE__) devInfo = info;
  void info.then(r => { if (r?.dev) host.dataset.chessCheckBuild = r.built ?? "unknown"; })
    .catch(() => { /* not a developer install */ });
  window.addEventListener("message", e => {
    if (e.source === window && (e.data as { type?: string } | null)?.type === "chess-check:dev-reload") {
      void chrome.runtime.sendMessage({ target: "dev", type: "reload" }).catch(() => {});
    }
  });
} catch { /* development harness */ }

// Chess.com changes pages without reloading, so watch the address.
let lastUrl = "";
function checkRoute() {
  if (lastUrl && pageUrl() !== lastUrl) { lastUrl = pageUrl(); void check(); }
}
(window as Window & { navigation?: EventTarget }).navigation?.addEventListener("currententrychange", checkRoute);
window.addEventListener("popstate", checkRoute);
setInterval(checkRoute, 1000);

try {
  chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg.type === "toggle") { host.style.display = host.style.display === "none" ? "" : "none"; }
    return false;
  });
} catch { /* dev harness */ }

void (async () => {
  accounts = await load<string[]>(accountKey, []);
  const old = site.id === DEFAULT_SITE ? await load("username", "") : "";                  // v0.2 stored one typed username
  if (!accounts.length && old) { accounts = [old.toLowerCase()]; void save(accountKey, accounts); }
  pos = await load("position", pos);
  if (document.readyState === "loading") {
    await new Promise<void>(resolve => document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
  }
  document.documentElement.appendChild(host);
  place();
  if (typeof __CC_PROFILE__ !== "undefined" && __CC_PROFILE__) {
    timingInstall = !!(await devInfo?.catch(() => null))?.dev;
  }
  lastUrl = pageUrl();
  await check();
})();
