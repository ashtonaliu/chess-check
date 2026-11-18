// Board diagrams for the website: an SVG board with move arrows. Kept apart from recapCard.ts
// because it needs chess.js, which the extension's Chess.com script does without.
import { Chess } from "chess.js";

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

/** The recap's turning point: the move played in red and, once revealed, the better one in green. */
export function turningBoard(fen: string, flip: boolean, played: string, best: string | null): string {
  const p = moveSquares(fen, played), b = best ? moveSquares(fen, best) : null;
  return boardSvg(fen, flip, [...(p ? [{ ...p, color: "#d0452f" }] : []), ...(b ? [{ ...b, color: "#2f9a5a" }] : [])]);
}
