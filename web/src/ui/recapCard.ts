// Shared rendering for the website and the Chrome extension's side panel:
// board diagrams and the post-game recap card.
import { Chess } from "chess.js";
import { motifName, type Recap } from "../browser/recap";

export const esc = (s: string) => s.replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export const PLURAL: Record<string, string> = { mate: "forced mates", fork: "forks", skewer: "skewers",
  discoveredAttack: "discovered attacks", hangingPiece: "free pieces", promotion: "pawn promotions" };
export const PUZZLE: Record<string, string> = { mate: "mate", fork: "fork", skewer: "skewer", discoveredAttack: "discoveredAttack",
  hangingPiece: "hangingPiece", promotion: "promotion" };
export const MOTIF_SINGULAR: Record<string, string> = { mate: "forced mate", fork: "fork", skewer: "skewer",
  discoveredAttack: "discovered attack", hangingPiece: "free piece", promotion: "promotion" };

// ---------- board diagrams ----------

const GLYPH: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const sqXY = (sq: string, flip: boolean) => {
  const f = sq.charCodeAt(0) - 97, r = Number(sq[1]) - 1;
  return flip ? [7 - f, r] : [f, 7 - r];
};

/** SVG board for a FEN, oriented for `flip` (Black at the bottom), with move arrows. */
export function boardSvg(fen: string, flip: boolean, arrows: { from: string; to: string; color: string }[]): string {
  const S = 40, rows = fen.split(" ")[0].split("/");
  let svg = `<svg class="board" viewBox="0 0 ${8 * S} ${8 * S}" role="img" aria-label="Chess position">`;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    svg += `<rect x="${x * S}" y="${y * S}" width="${S}" height="${S}" fill="var(${(x + y) % 2 ? "--sq-dark" : "--sq-light"})"/>`;
  }
  rows.forEach((row, ri) => {
    let fi = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { fi += Number(ch); continue; }
      const sq = String.fromCharCode(97 + fi) + String(8 - ri);
      const [x, y] = sqXY(sq, flip);
      const white = ch === ch.toUpperCase();
      svg += `<text x="${x * S + S / 2}" y="${y * S + S * 0.78}" text-anchor="middle" font-size="${S * 0.82}"
        fill="${white ? "#fafaf7" : "#1b1d1c"}" stroke="${white ? "#1b1d1c" : "none"}" stroke-width="${white ? 1.1 : 0}"
        style="font-family:'Segoe UI Symbol','Noto Sans Symbols 2','DejaVu Sans',sans-serif">${GLYPH[ch.toLowerCase()]}</text>`;
      fi++;
    }
  });
  arrows.forEach((a, i) => {
    const [x1, y1] = sqXY(a.from, flip), [x2, y2] = sqXY(a.to, flip);
    const cx1 = x1 * S + S / 2, cy1 = y1 * S + S / 2, cx2 = x2 * S + S / 2, cy2 = y2 * S + S / 2;
    const len = Math.hypot(cx2 - cx1, cy2 - cy1) || 1, sx = cx2 - (cx2 - cx1) / len * 12, sy = cy2 - (cy2 - cy1) / len * 12;
    svg += `<defs><marker id="ah${i}${a.color}" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto">
      <path d="M0,0 L4,2 L0,4 z" fill="${a.color}"/></marker></defs>
      <line x1="${cx1}" y1="${cy1}" x2="${sx}" y2="${sy}" stroke="${a.color}" stroke-width="7" stroke-linecap="round"
        opacity=".8" marker-end="url(#ah${i}${a.color})"/>`;
  });
  return svg + "</svg>";
}

export function moveSquares(fen: string, san: string | null): { from: string; to: string } | null {
  if (!san) return null;
  try { const m = new Chess(fen).move(san); return { from: m.from, to: m.to }; } catch { return null; }
}

// ---------- recap card ----------

export const ago = (t: number) => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  return s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t * 1000).toLocaleDateString();
};
const VERDICT_CLASS = (r: Recap) => r.surprise >= 0.4 ? "good" : r.surprise <= -0.4 ? "weak" : r.score === 1 ? "good" : "";

/** The recap card as a DOM element (no side effects). */
export function recapCard(r: Recap, isNew: boolean): HTMLElement {

  const col = r.color === "white" ? "White" : "Black";
  const resultPos = r.score * 100, expPos = r.expected * 100;
  const resultColor = r.score === 1 ? "var(--good)" : r.score === 0 ? "var(--weak)" : "var(--neutral)";
  const t = r.turning;
  const board = t ? (() => {
    const flip = t.ply % 2 === 1;
    const played = moveSquares(t.fen, t.san), best = t.best && t.best !== t.san ? moveSquares(t.fen, t.best) : null;
    return boardSvg(t.fen, flip, [...(played ? [{ ...played, color: "#d0452f" }] : []), ...(best ? [{ ...best, color: "#2f9a5a" }] : [])]);
  })() : "";
  const clock = t?.clockFrac !== null && t?.clockFrac !== undefined
    ? (t.clockFrac <= 0.1 ? ", in time trouble" : t.clockFrac <= 0.3 ? ", low on time" : "") : "";
  const tags = t?.tactics.length ? ` You ${t.tactics.map(x => motifName(x.kind, x.motif)).join(" and ")}.` : "";
  const turning = !t ? `<p>Clean game: no mistakes worth noting.</p>`
    : t.loss >= 20
      ? `<p><span class="lbl">Turning point</span><span class="moves">${esc(t.label)}</span> lost <strong class="weak">${Math.round(t.loss)}%</strong>
         winning chances (${esc(t.phase)}${clock}).${t.best ? ` Better was <span class="moves">${esc(t.best)}</span>.` : ""}${esc(tags)}</p>`
      : `<p><span class="lbl">Turning point</span>No blunders. Your biggest slip, <span class="moves">${esc(t.label)}</span>, cost ${Math.round(t.loss)}%.</p>`;
  const h = r.opening.history;
  const variation = r.opening.name.toLowerCase().replace(/[^a-z]/g, "") !== r.opening.family.toLowerCase().replace(/[^a-z]/g, "")
    ? ` <span class="ci">(${esc(r.opening.name)})</span>` : "";
  const opening = `<p><span class="lbl">Opening</span>${esc(r.opening.family)} as ${col}${variation}. ` + (h
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
    <div class="meter" title="Pre-game expected score from both ratings, shown only after the game">
      <div class="track"><span class="mark" style="left:${expPos.toFixed(1)}%"></span>
        <span class="result" style="left:${resultPos}%;background:${resultColor}"></span></div>
      <div class="labels"><span>loss</span><span>Before the game you had a ${Math.round(expPos)}% expected score</span><span>win</span></div></div>
    <div class="recap-grid${t ? "" : " noboard"}">${board ? `<div>${board}</div>` : ""}
      <div class="recap-lines">${turning}${pat}${opening}${opp}</div></div>`;
  if (!t) (card.querySelector(".recap-grid") as HTMLElement).style.gridTemplateColumns = "1fr";
  return card;
}

/** Short text for a browser notification about a new recap. */
export function notificationText(r: Recap): { title: string; body: string } {
  const t = r.turning;
  return { title: `${r.verdict} vs ${r.opponent}`, body: r.pattern
    ? `Matches your pattern: you ${r.pattern.kind === "missed" ? "missed" : "walked into"} a ${MOTIF_SINGULAR[r.pattern.motif] ?? r.pattern.motif}.`
    : t && t.loss >= 20 ? `Turning point: ${t.label} lost ${Math.round(t.loss)}%.` : "Recap ready." };
}
