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

/** The recap card as a DOM element. Its only side effect is remembering a revealed answer. */
export function recapCard(r: Recap, isNew: boolean, opts: RecapOptions = {}): HTMLElement {

  const col = r.color === "white" ? "White" : "Black";
  const resultPos = r.score * 100, expPos = r.expected * 100;
  const resultColor = r.score === 1 ? "var(--good)" : r.score === 0 ? "var(--weak)" : "var(--neutral)";
  const t = r.turning;
  // A real blunder with a better move becomes a question: find the move, then reveal it.
  const quiz = !!(t && t.loss >= 20 && t.best && t.best !== t.san);
  let revealed = !quiz || wasRevealed(r);
  const boardFor = (withAnswer: boolean) => {
    if (!t || !opts.drawBoard) return "";
    return opts.drawBoard(t.fen, t.ply % 2 === 1, t.san, withAnswer && t.best && t.best !== t.san ? t.best : null);
  };
  const board = boardFor(revealed);
  const clock = t?.clockFrac !== null && t?.clockFrac !== undefined
    ? (t.clockFrac <= 0.1 ? ", in time trouble" : t.clockFrac <= 0.3 ? ", low on time" : "") : "";
  // Before the reveal: what went wrong with your move ("allowed") and a hint ("missed").
  const tags = t ? tacticSentence(t.tactics) : "";
  const question = t ? quizHint(t.tactics) : "";
  const link = t ? moveLink(r.url, t.ply) : r.url;
  const turning = r.turningError
    ? `<p><span class="lbl">Turning point</span>Unavailable: Stockfish could not analyze this game.</p>`
    : r.pending?.turning
    ? `<p><span class="lbl">Turning point</span><span class="pending">Finding the turning point</span></p>`
    : !t ? `<p>Clean game: no mistakes worth noting.</p>`
    : quiz
      ? `<div class="quiz"><p><span class="lbl">Turning point</span><span class="moves">${esc(t.label)}</span> lost <strong class="weak">${Math.round(t.loss)}%</strong>
           winning chances (${esc(t.phase)}${clock}). There was a much better move.<span class="quiz-q">${esc(question)}</span></p>
         <div class="quiz-actions">
           <a class="quiz-board" href="${esc(link)}"${opts.sameTab ? "" : ` target="_blank" rel="noopener"`}>Find it on the board</a>
           <button type="button" class="quiz-reveal">Reveal the move</button>
         </div>
         <p class="quiz-answer"><span class="lbl">Answer</span>Better was <span class="moves">${esc(t.best!)}</span>.${esc(tags)}</p></div>`
      : t.loss >= 20
        ? `<p><span class="lbl">Turning point</span><span class="moves">${esc(t.label)}</span> lost <strong class="weak">${Math.round(t.loss)}%</strong>
           winning chances (${esc(t.phase)}${clock}).${esc(tags)}</p>`
        : `<p><span class="lbl">Turning point</span>No blunders. Your biggest slip, <span class="moves">${esc(t.label)}</span>, cost ${Math.round(t.loss)}%.</p>`;
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
  const card = document.createElement("article");
  card.className = "recap" + (isNew ? " new" : "");
  card.innerHTML = `<div class="recap-head"><span class="chip ${VERDICT_CLASS(r)}">${esc(r.verdict)}</span>
      <strong>You ${esc(r.how)}</strong> vs ${esc(r.opponent)} (${r.oppRating}) as ${col}
      <span class="when">${esc(r.timeClass)} · ${ago(r.endTime)} · <a href="${esc(r.url)}" target="_blank" rel="noopener">open game</a></span></div>
    ${r.odds === "unknown" ? "" : `<div class="meter" title="${r.odds === "estimated"
        ? "Pre-game expected score, from ratings estimated from your previous game (the game archive only stores ratings after each game), shown only after the game"
        : "Pre-game expected score from both ratings, shown only after the game"}">
      <div class="track"><span class="mark" style="left:${expPos.toFixed(1)}%"></span>
        <span class="result" style="left:${resultPos}%;background:${resultColor}"></span></div>
      <div class="labels"><span>loss</span><span>Before the game you had ${r.odds === "estimated" ? "about " : ""}a ${Math.round(expPos)}% expected score</span><span>win</span></div></div>`}
    <div class="recap-grid${board ? "" : " noboard"}">${board ? `<div class="recap-board">${board}</div>` : ""}
      <div class="recap-lines">${turning}${pat}${opening}${opp}</div></div>`;
  if (!board) (card.querySelector(".recap-grid") as HTMLElement).style.gridTemplateColumns = "1fr";
  const show = () => {
    card.classList.toggle("revealed", revealed);
    const b = card.querySelector<HTMLElement>(".recap-board");
    if (b) b.innerHTML = boardFor(revealed);
  };
  card.querySelector(".quiz-reveal")?.addEventListener("click", () => {
    revealed = true; rememberReveal(r); show();
    card.querySelector<HTMLElement>(".quiz-answer")?.focus();
  });
  card.querySelector<HTMLElement>(".quiz-answer")?.setAttribute("tabindex", "-1");
  show();
  return card;
}

/** Short text for a browser notification about a new recap. */
export function notificationText(r: Recap): { title: string; body: string } {
  const t = r.turning;
  return { title: `${r.verdict} vs ${r.opponent}`, body: r.pattern
    ? `Matches your pattern: you ${r.pattern.kind === "missed" ? "missed" : "walked into"} a ${MOTIF_SINGULAR[r.pattern.motif] ?? r.pattern.motif}.`
    : t && t.loss >= 20 ? `Turning point: ${t.label} lost ${Math.round(t.loss)}%.` : "Recap ready." };
}
