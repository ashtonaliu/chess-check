// Shared rendering for the website and the Chrome extension's side panel: the post-game recap
// card. Board diagrams are in board.ts, which needs chess.js; the extension leaves the board to
// Chess.com, so its script does not load chess.js at all.
import type { Recap } from "../browser/recap";

export const esc = (s: string) => s.replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export const PLURAL: Record<string, string> = { mate: "forced mates", fork: "forks", skewer: "skewers",
  discoveredAttack: "discovered attacks", hangingPiece: "free pieces", promotion: "pawn promotions" };
export const PUZZLE: Record<string, string> = { mate: "mate", fork: "fork", skewer: "skewer", discoveredAttack: "discoveredAttack",
  hangingPiece: "hangingPiece", promotion: "promotion" };
export const MOTIF_SINGULAR: Record<string, string> = { mate: "forced mate", fork: "fork", skewer: "skewer",
  discoveredAttack: "discovered attack", hangingPiece: "free piece", promotion: "promotion" };

// ---------- recap card ----------

export const ago = (t: number) => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  return s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t * 1000).toLocaleDateString();
};
const VERDICT_CLASS = (r: Recap) => r.surprise >= 0.4 ? "good" : r.surprise <= -0.4 ? "weak" : r.score === 1 ? "good" : "";

/** Link to a game on Chess.com, opened at the position before move `ply` (0-based half-moves). */
const article = (w: string) => (/^[aeiou]/.test(w) ? "an " : "a ") + w;

/** The answer's tactic sentence, such as " You allowed a fork and missed a skewer." */
export function tacticSentence(tactics: { kind: "allowed" | "missed"; motif: string }[]): string {
  const names = (kind: string) => tactics.filter(x => x.kind === kind).map(x => article(MOTIF_SINGULAR[x.motif] ?? x.motif));
  const did = (["allowed", "missed"] as const).map(k => [k, names(k)] as const).filter(([, ws]) => ws.length)
    .map(([verb, ws]) => `${verb} ${ws.join(" and ")}`);
  return did.length ? ` You ${did.join(" and ")}.` : "";
}

/** The question's hint: what your move allowed, and what kind of move you missed. */
export function quizHint(tactics: { kind: "allowed" | "missed"; motif: string }[]): string {
  const names = (kind: string) => tactics.filter(x => x.kind === kind).map(x => article(MOTIF_SINGULAR[x.motif] ?? x.motif));
  const allowed = names("allowed"), missed = names("missed");
  return (allowed.length ? ` It allowed ${allowed.join(" and ")}.` : "") + (missed.length ? ` Hint: look for ${missed.join(" or ")}.` : "");
}

export function moveLink(url: string, ply: number): string {
  try { const u = new URL(url); u.searchParams.set("move", String(ply)); return u.toString(); } catch { return url; }
}

// Whether the player has revealed a recap's answer, per tab, so it survives the page reload that
// "Find it on the board" causes on Chess.com.
const revealKey = (r: Recap) => `chess-check-revealed:${r.url}:${r.turning?.ply ?? ""}`;
const wasRevealed = (r: Recap) => { try { return sessionStorage.getItem(revealKey(r)) === "1"; } catch { return false; } };
const rememberReveal = (r: Recap) => { try { sessionStorage.setItem(revealKey(r), "1"); } catch { /* not remembered */ } };

export interface RecapOptions {
  /** Draws the turning point on a small board (the website passes board.ts's turningBoard). The
   *  extension leaves the board to Chess.com, whose own board is on the page. */
  drawBoard?: (fen: string, flip: boolean, played: string, best: string | null) => string;
  /** Open "Find it on the board" in this tab (the extension, on the game's own page). */
  sameTab?: boolean;
}

/** Move consequences are expressed on the same scale at both ends of the move. */
export function describeTurningPoint(t: NonNullable<Recap["turning"]>): string {
  return t.chances
    ? `dropped your estimated winning chances from ${Math.round(t.chances.before)}% to ${Math.round(t.chances.after)}%`
    : `cost ${Math.round(t.loss)} percentage points of estimated winning chances`;
}

function renderTurningPoint(section: HTMLElement, r: Recap, opts: RecapOptions) {
  const t = r.turning;
  if (r.turningError || r.pending?.turning || !t) {
    section.className = "recap-turning noboard";
    section.innerHTML = `<p><span class="lbl">Turning point</span>${r.turningError
      ? "Stockfish could not analyze this game."
      : r.pending?.turning ? '<span class="pending">Finding the turning point</span>' : "No major mistakes in this game."}</p>`;
    return;
  }
  const quiz = t.loss >= 20 && !!t.best && t.best !== t.san;
  const boardFor = (withAnswer: boolean) =>
    opts.drawBoard?.(t.fen, t.ply % 2 === 1, t.san, withAnswer && t.best !== t.san ? t.best : null) ?? "";
  const revealed = !quiz || wasRevealed(r);
  const board = boardFor(revealed);
  const clock = t.clockFrac !== null && t.clockFrac <= 0.3
    ? (t.clockFrac <= 0.1 ? ", in time trouble" : ", low on time") : "";
  const tags = tacticSentence(t.tactics);
  const consequence = `<strong class="moves">${esc(t.label)}</strong> ${describeTurningPoint(t)}.`;
  const context = `<span class="recap-context">${esc(t.phase[0].toUpperCase() + t.phase.slice(1))}${clock}</span>`;
  section.className = "recap-turning recap-grid" + (board ? "" : " noboard");
  section.innerHTML = `<div class="recap-lines"><p><span class="lbl">Turning point</span>
      ${t.loss < 20 ? "No blunders. " : ""}${consequence}${context}
      ${quiz ? `<span class="quiz-q">${esc(quizHint(t.tactics))}</span>` : esc(tags)}</p>
      ${quiz ? `<div class="quiz-actions">
        <a class="quiz-board" href="${esc(moveLink(r.url, t.ply))}"${opts.sameTab ? "" : ' target="_blank" rel="noopener"'}>Find it on the board</a>
        <button type="button" class="quiz-reveal">Reveal the move</button>
      </div>
      <p class="quiz-answer" tabindex="-1"><span class="lbl">Answer</span>Better was <span class="moves">${esc(t.best!)}</span>.${esc(tags)}</p>` : ""}
    </div>${board ? `<div class="recap-board">${board}</div>` : ""}`;
  section.classList.toggle("revealed", revealed);
  section.querySelector(".quiz-reveal")?.addEventListener("click", () => {
    rememberReveal(r);
    section.classList.add("revealed");
    const diagram = section.querySelector<HTMLElement>(".recap-board");
    if (diagram) diagram.innerHTML = boardFor(true);
    section.querySelector<HTMLElement>(".quiz-answer")?.focus();
  });
}

function recapDetails(r: Recap, col: string): string {
  const resultPos = r.score * 100, expPos = r.expected * 100;
  const resultColor = r.score === 1 ? "var(--good)" : r.score === 0 ? "var(--weak)" : "var(--neutral)";
  const meter = r.odds === "unknown" ? "" : `<div class="meter" title="A win is 1 point and a draw is half a point. The line marks the expected score. The dot marks the result.">
    <p><span class="lbl">Expected score</span>Before the game, ratings suggested ${r.odds === "estimated" ? "about " : ""}${r.expected.toFixed(2)} points out of 1.</p>
    <div class="track" aria-hidden="true"><span class="mark" style="left:${expPos.toFixed(1)}%"></span>
      <span class="result" style="left:${resultPos}%;background:${resultColor}"></span></div>
    <div class="labels" aria-hidden="true"><span>Loss</span><span>Draw</span><span>Win</span></div></div>`;
  const h = r.opening.history;
  const variation = r.opening.name.toLowerCase().replace(/[^a-z]/g, "") !== r.opening.family.toLowerCase().replace(/[^a-z]/g, "")
    ? ` <span class="ci">(${esc(r.opening.name)})</span>` : "";
  // Until the player's history is in, the record is unknown, and without it the opening may only
  // have an ECO code for a name (Chess.com's game endpoint gives no opening name).
  const opening = r.pending?.history
    ? (r.opening.family.startsWith("ECO ") ? "" : `<p><span class="lbl">Opening</span>${esc(r.opening.family)} as ${col}${variation}.</p>`)
    : `<p><span class="lbl">Opening</span>${esc(r.opening.family)} as ${col}${variation}. ` + (h
    ? `Your record before this game: ${Math.round(100 * h.score)}% in ${h.n} game${h.n === 1 ? "" : "s"} (${Math.round(100 * h.expected)}% expected).`
    : "First time in this opening in your recent games.") +
    (r.opening.flag ? ` <span class="chip ${r.opening.flag.includes("weakness") || r.opening.flag === "worth watching" ? "watch" : "good"}">${esc(r.opening.flag)}</span>` : "") + `</p>`;
  const pat = r.pattern
    ? `<p class="patternbox"><strong>Matches your pattern:</strong> you ${r.pattern.kind === "missed" ? "miss" : "walk into"}
       ${esc(PLURAL[r.pattern.motif] ?? r.pattern.motif)}. That makes ${r.pattern.count} in your analyzed games.
       <a href="https://lichess.org/training/${esc(PUZZLE[r.pattern.motif] ?? r.pattern.motif)}" target="_blank" rel="noopener">Practice →</a></p>` : "";
  const opp = r.opponentNote ? `<p><span class="lbl">Your opponent</span>${esc(r.opponentNote)}</p>` : "";
  return `${meter}${pat}${opening}${opp}`;
}

/** Recap sections update independently so a history update leaves the turning point in place. */
export function createRecapView(opts: RecapOptions = {}) {
  const element = document.createElement("article");
  element.innerHTML = '<header class="recap-head"></header><div class="recap-turning"></div><div class="recap-details" hidden></div>';
  const head = element.querySelector<HTMLElement>(".recap-head")!;
  const turning = element.querySelector<HTMLElement>(".recap-turning")!;
  const details = element.querySelector<HTMLElement>(".recap-details")!;
  let shownHead = "", shownTurning = "", shownDetails = "";

  function update(r: Recap, isNew = false) {
    element.className = "recap" + (isNew ? " new" : "");
    const col = r.color === "white" ? "White" : "Black";
    const badge = ["Win", "Loss", "Draw"].includes(r.verdict) ? "" : `<span class="chip ${VERDICT_CLASS(r)}">${esc(r.verdict)}</span>`;
    const headerMarkup = `${badge}<span><strong>You ${esc(r.how)}</strong> vs ${esc(r.opponent)} (${r.oppRating}) as ${col}</span>
      <span class="when">${esc(r.timeClass)} · ${ago(r.endTime)} · <a href="${esc(r.url)}" target="_blank" rel="noopener">Open game</a></span>`;
    if (headerMarkup !== shownHead) {
      shownHead = headerMarkup;
      head.innerHTML = headerMarkup;
    }
    const turningKey = JSON.stringify([r.url, r.turning, r.pending?.turning, r.turningError]);
    if (turningKey !== shownTurning) {
      shownTurning = turningKey;
      renderTurningPoint(turning, r, opts);
    }
    const detailsMarkup = recapDetails(r, col);
    if (detailsMarkup !== shownDetails) {
      shownDetails = detailsMarkup;
      details.innerHTML = detailsMarkup;
      details.hidden = !detailsMarkup;
    }
  }

  return { element, update };
}

export function recapCard(r: Recap, isNew: boolean, opts: RecapOptions = {}): HTMLElement {
  const view = createRecapView(opts);
  view.update(r, isNew);
  return view.element;
}

/** Short text for a browser notification about a new recap. */
export function notificationText(r: Recap): { title: string; body: string } {
  const t = r.turning;
  return { title: `${r.verdict} vs ${r.opponent}`, body: r.pattern
    ? `Matches your pattern: you ${r.pattern.kind === "missed" ? "missed" : "walked into"} a ${MOTIF_SINGULAR[r.pattern.motif] ?? r.pattern.motif}.`
    : t && t.loss >= 20 ? `Turning point: ${t.label} lost ${Math.round(t.loss)}%.` : "Recap ready." };
}
