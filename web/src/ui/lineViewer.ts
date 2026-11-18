// Example positions you can step through: what happened after your move, or the better line.
// Lines come from Stockfish in the browser, computed on demand (hovering a card starts it), so
// saved reports need no stored lines. The first move of each line is already known, so the
// viewer never blocks: the rest of the line fills in when the engine answers.
import { Chess } from "chess.js";
import { Engine } from "../browser/engine";
import { boardSvg, moveSquares } from "./board";
import { esc, moveLink } from "./recapCard";

export interface ExampleData { fen: string; ply: number; move_no: number; san: string; wp_loss: number; best: string | null; url: string; }
interface Step { san: string; fen: string; from: string; to: string; }
type Mode = "played" | "better";
interface State { data: ExampleData; mode: Mode; step: number; lines: Record<Mode, Step[]>; loading: Record<Mode, boolean>; failed: boolean; }

const LINE_DEPTH = 14;     // the same depth as the browser's blunder re-check
const LINE_PLIES = 7;      // engine moves shown after the first move
const PLAYED = "#d0452f", BETTER = "#2f9a5a", NEXT = "#3d6fb0";

let engineUrl = "";
let engine: Promise<Engine> | null = null;
let queue: Promise<unknown> = Promise.resolve();
const memo = new Map<string, Promise<Step[]>>();
const states = new WeakMap<HTMLElement, State>();


const moveName = (ply: number, san: string, first: boolean) =>
  ply % 2 === 0 ? `${Math.floor(ply / 2) + 1}.${san}` : first ? `${Math.floor(ply / 2) + 1}...${san}` : san;

export function exampleCard(e: ExampleData, caption: string): string {
  const flip = e.ply % 2 === 1;
  const better = e.best && e.best !== e.san ? e.best : null;
  return `<div class="example" tabindex="0" aria-label="Example position, ${esc(moveName(e.ply, e.san, true))}"
      data-ex="${esc(JSON.stringify(e))}">
    <div class="board-wrap">${initialBoard(e, flip)}</div>
    <div class="cap"><span class="moves">${esc(moveName(e.ply, e.san, true))}</span> lost <strong class="weak">${Math.round(e.wp_loss)}%</strong> winning chances.
      ${caption}</div>
    <div class="keyline"><span style="color:${PLAYED}">●</span> your move${better ? ` &nbsp;<span style="color:${BETTER}">●</span> better: <span class="moves">${esc(better)}</span>` : ""}</div>
    <div class="line">
      <div class="line-modes" role="group" aria-label="Which line to show">
        <button type="button" class="line-mode" data-line-mode="played" aria-pressed="false">What happened</button>
        ${better ? `<button type="button" class="line-mode" data-line-mode="better" aria-pressed="false">Better line</button>` : ""}
      </div>
      <div class="line-moves" aria-live="polite"><span class="line-hint">Step through the moves with the arrows.</span></div>
      <div class="line-nav">
        <button type="button" class="line-btn" data-line-step="start" aria-label="Back to the position" disabled>⟲</button>
        <button type="button" class="line-btn" data-line-step="prev" aria-label="Previous move" disabled>‹</button>
        <button type="button" class="line-btn" data-line-step="next" aria-label="Next move">›</button>
        <a class="line-open" href="${esc(moveLink(e.url, e.ply))}" target="_blank" rel="noopener" title="Open this move on Chess.com">Open on Chess.com ↗</a>
      </div>
    </div></div>`;
}

function initialBoard(e: ExampleData, flip: boolean): string {
  const played = moveSquares(e.fen, e.san), best = e.best && e.best !== e.san ? moveSquares(e.fen, e.best) : null;
  return boardSvg(e.fen, flip, [...(played ? [{ ...played, color: PLAYED }] : []), ...(best ? [{ ...best, color: BETTER }] : [])]);
}

function firstStep(fen: string, san: string | null): Step | null {
  if (!san) return null;
  try { const c = new Chess(fen); const m = c.move(san); return { san: m.san, fen: c.fen(), from: m.from, to: m.to }; }
  catch { return null; }
}

function analyse(fen: string) {
  const run = queue.then(async () => {
    engine ??= (async () => { const e = new Engine(engineUrl); await e.init(); return e; })();
    return (await engine).analyse(fen, LINE_DEPTH);
  });
  queue = run.catch(() => undefined);
  return run;
}

/** The engine's line from a position (after the first move), as playable steps. */
function continuation(fen: string): Promise<Step[]> {
  let p = memo.get(fen);
  if (!p) {
    p = (async () => {
      const c = new Chess(fen);
      if (c.isGameOver()) return [];
      const { pv } = await analyse(fen);
      const out: Step[] = [];
      for (const uci of pv.slice(0, LINE_PLIES)) {
        try {
          const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
          out.push({ san: m.san, fen: c.fen(), from: m.from, to: m.to });
        } catch { break; }
      }
      return out;
    })();
    p.catch(() => memo.delete(fen));
    memo.set(fen, p);
  }
  return p;
}

function stateOf(el: HTMLElement): State | null {
  let st = states.get(el);
  if (!st) {
    let data: ExampleData;
    try { data = JSON.parse(el.dataset.ex ?? ""); } catch { return null; }
    const played = firstStep(data.fen, data.san), better = data.best && data.best !== data.san ? firstStep(data.fen, data.best) : null;
    st = { data, mode: "played", step: 0, lines: { played: played ? [played] : [], better: better ? [better] : [] },
      loading: { played: false, better: false }, failed: false };
    states.set(el, st);
  }
  return st;
}

function load(el: HTMLElement, st: State, mode: Mode) {
  const first = st.lines[mode][0];
  if (!first || st.loading[mode] || st.lines[mode].length > 1 || !engineUrl) return;
  st.loading[mode] = true;
  if (st.mode === mode) render(el, st);
  continuation(first.fen).then(rest => { st.lines[mode] = [first, ...rest]; })
    .catch(() => { st.failed = true; })
    .finally(() => { st.loading[mode] = false; if (st.mode === mode) render(el, st); });
}

function render(el: HTMLElement, st: State) {
  const line = st.lines[st.mode], flip = st.data.ply % 2 === 1;
  st.step = Math.max(0, Math.min(st.step, line.length));
  const board = el.querySelector<HTMLElement>(".board-wrap");
  if (board) {
    if (st.step === 0) board.innerHTML = initialBoard(st.data, flip);
    else {
      const s = line[st.step - 1];
      const color = st.step === 1 ? (st.mode === "played" ? PLAYED : BETTER) : NEXT;
      board.innerHTML = boardSvg(s.fen, flip, [{ from: s.from, to: s.to, color }]);
    }
  }
  el.querySelectorAll<HTMLButtonElement>("[data-line-mode]").forEach(b =>
    b.setAttribute("aria-pressed", String(st.step > 0 && b.dataset.lineMode === st.mode)));
  const moves = el.querySelector<HTMLElement>(".line-moves");
  if (moves) {
    const chips = line.map((s, i) => `<button type="button" class="line-move${i + 1 === st.step ? " on" : ""}${i === 0 ? ` first ${st.mode}` : ""}"
        data-line-i="${i}"${i + 1 === st.step ? ` aria-current="step"` : ""}>${esc(moveName(st.data.ply + i, s.san, i === 0))}</button>`).join("");
    const tail = st.loading[st.mode] ? `<span class="line-wait">finding the line</span>`
      : st.failed && line.length < 2 ? `<span class="line-hint">The engine line could not load.</span>` : "";
    moves.innerHTML = st.step === 0 && !st.loading[st.mode] && line.length < 2
      ? `<span class="line-hint">Step through the moves with the arrows.</span>` : chips + tail;
  }
  const nav = (name: string) => el.querySelector<HTMLButtonElement>(`[data-line-step="${name}"]`);
  const atEnd = st.step >= line.length && !st.loading[st.mode];
  nav("start")!.disabled = st.step === 0;
  nav("prev")!.disabled = st.step === 0;
  nav("next")!.disabled = atEnd;
}

function go(el: HTMLElement, st: State, step: number, mode: Mode = st.mode) {
  if (mode !== st.mode) { st.mode = mode; }
  st.step = step;
  load(el, st, st.mode);
  render(el, st);
}

function act(el: HTMLElement, action: string) {
  const st = stateOf(el);
  if (!st) return;
  if (action === "next") go(el, st, st.step + 1);
  else if (action === "prev") go(el, st, st.step - 1);
  else if (action === "start") go(el, st, 0);
}

/** Wire every example card on the page (event delegation, so cards can be re-rendered freely). */
export function initExampleViewers(url: string) {
  engineUrl = url;
  document.addEventListener("click", ev => {
    const t = ev.target as HTMLElement;
    const el = t.closest<HTMLElement>(".example");
    if (!el) return;
    const st = stateOf(el);
    if (!st) return;
    const mode = t.closest<HTMLElement>("[data-line-mode]")?.dataset.lineMode as Mode | undefined;
    const step = t.closest<HTMLElement>("[data-line-step]")?.dataset.lineStep;
    const chip = t.closest<HTMLElement>("[data-line-i]")?.dataset.lineI;
    if (mode) go(el, st, st.mode === mode && st.step > 0 ? st.step : 1, mode);
    else if (step) act(el, step);
    else if (chip !== undefined) go(el, st, Number(chip) + 1);
  });
  document.addEventListener("keydown", ev => {
    const t = ev.target as HTMLElement;
    const el = t.closest?.<HTMLElement>(".example");
    if (!el || ev.altKey || ev.ctrlKey || ev.metaKey || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    const action = { ArrowRight: "next", ArrowLeft: "prev", Home: "start" }[ev.key];
    if (!action) return;
    ev.preventDefault();
    act(el, action);
  });
  // Start the engine as soon as someone shows interest in a card, so the line is ready on click.
  const warm = (ev: Event) => {
    const el = (ev.target as HTMLElement).closest?.<HTMLElement>(".example");
    const st = el && stateOf(el);
    if (el && st) { load(el, st, "played"); load(el, st, "better"); }
  };
  document.addEventListener("pointerover", warm, { passive: true });
  document.addEventListener("focusin", warm);
}

// ---------- a dialog that pages through many example positions ----------

export interface DialogItem { data: ExampleData; caption: string; }
let dialog: HTMLDialogElement | null = null;

export function openExamples(title: string, items: DialogItem[]) {
  if (!items.length) return;
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.className = "examples-dialog";
    document.body.appendChild(dialog);
    dialog.addEventListener("click", ev => { if (ev.target === dialog) dialog!.close(); });   // backdrop
  }
  const d = dialog;
  let i = 0;
  const show = (focus: boolean) => {
    d.innerHTML = `<div class="dlg-head"><h3>${esc(title)}</h3>
        <button type="button" class="dlg-close" aria-label="Close">✕</button></div>
      <div class="dlg-pager">
        <button type="button" class="line-btn" data-dlg="prev" aria-label="Previous position"${i === 0 ? " disabled" : ""}>‹</button>
        <span>Position ${i + 1} of ${items.length}, worst first</span>
        <button type="button" class="line-btn" data-dlg="next" aria-label="Next position"${i === items.length - 1 ? " disabled" : ""}>›</button>
      </div>
      ${exampleCard(items[i].data, items[i].caption)}
      <p class="dlg-keys">← → step through the moves · ↑ ↓ change position · Esc closes</p>`;
    d.querySelector<HTMLButtonElement>(".dlg-close")!.onclick = () => d.close();
    d.querySelectorAll<HTMLButtonElement>("[data-dlg]").forEach(b => {
      b.onclick = () => page(b.dataset.dlg === "next" ? 1 : -1);
    });
    if (focus) d.querySelector<HTMLElement>(".example")?.focus();
    const el = d.querySelector<HTMLElement>(".example"), st = el && stateOf(el);
    if (el && st) { load(el, st, "played"); load(el, st, "better"); }
  };
  const page = (delta: number) => {
    const next = Math.max(0, Math.min(items.length - 1, i + delta));
    if (next !== i) { i = next; show(true); }
  };
  d.onkeydown = ev => {
    if (ev.key === "ArrowDown" || ev.key === "PageDown") { ev.preventDefault(); page(1); }
    else if (ev.key === "ArrowUp" || ev.key === "PageUp") { ev.preventDefault(); page(-1); }
  };
  show(false);
  d.showModal();
  d.querySelector<HTMLElement>(".example")?.focus();
}
