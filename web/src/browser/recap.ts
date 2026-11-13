// Post-game recap: a short card for one finished game, read against the
// player's history. Everything here is about a game that is already over;
// nothing is computed or shown before or during a game (Chess.com's fair-play
// rules forbid outside help while playing).
import { BLUNDER_DROP, moveLabel, type GameAnalysis } from "./engine";
import type { Game } from "./games";
import { expectedScore, type GameRow } from "./stats";
import { MOTIF_LABEL, type BlunderRec, type TacticSummary } from "./tactics";

export interface Recap {
  url: string; endTime: number; opponent: string; myRating: number; oppRating: number;
  color: "white" | "black"; timeClass: string; score: number; how: string;
  expected: number; surprise: number; verdict: string;
  opening: { name: string; family: string; history: { n: number; score: number; expected: number } | null; flag: string | null };
  turning: null | { label: string; loss: number; phase: string; best: string | null; fen: string; ply: number; moveNo: number; san: string;
                    tactics: { kind: "allowed" | "missed"; motif: string }[]; clockFrac: number | null };
  pattern: null | { kind: string; motif: string; count: number; verdict: string };
  clean: boolean;
  opponentNote: string | null;
}

const HOW_WON: Record<string, string> = { timeout: "on time", checkmated: "by checkmate", resigned: "by resignation", abandoned: "by abandonment" };
const HOW_LOST: Record<string, string> = { timeout: "on time", checkmated: "by checkmate", resigned: "by resignation", abandoned: "by abandonment" };
const HOW_DREW: Record<string, string> = { agreed: "by agreement", repetition: "by repetition", stalemate: "by stalemate",
  insufficient: "with insufficient material", "50move": "by the 50-move rule", timevsinsufficient: "on time vs insufficient material" };

/** How surprising a result was, from the pre-game expected score (Elo). */
export function upset(score: number, expected: number): string {
  if (score === 1) return expected < 0.35 ? "Big upset win" : expected < 0.45 ? "Upset win" : expected > 0.65 ? "Win as the favorite" : "Win";
  if (score === 0) return expected > 0.65 ? "Upset loss" : expected > 0.55 ? "Loss as the favorite" : expected < 0.35 ? "Loss to a stronger player" : "Loss";
  return expected < 0.35 ? "Draw against a stronger player" : expected > 0.65 ? "Draw as the favorite" : "Draw";
}

export function howEnded(g: Game): string {
  if (g.score === 1) return `won ${HOW_WON[g.oppResult] ?? ""}`.trim();
  if (g.score === 0) return `lost ${HOW_LOST[g.result] ?? ""}`.trim();
  return `drew ${HOW_DREW[g.result] ?? ""}`.trim();
}

/**
 * Build the recap for `game` (analysed in `analysis`, its blunders classified in `blunders`)
 * against the player's `history` (earlier games, which must not include this one).
 */
export function buildRecap(game: Game, analysis: GameAnalysis, blunders: BlunderRec[], history: GameRow[],
                           openings: { family: string; color: string; verdict: string }[], tactics: TacticSummary | null,
                           opponentNote: string | null = null): Recap {
  const expected = expectedScore(game.myRating, game.oppRating);
  const past = history.filter(r => r.url !== game.url && r.family === game.family && r.color === game.color);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const row = openings.find(o => o.family === game.family && o.color === game.color);
  const flag = row && row.verdict !== "not enough evidence" ? row.verdict : null;

  // turning point: the user's biggest mistake, by the confirmed (deep) loss when available
  const mine = analysis.moves.filter(m => m.is_me).map(m => {
    const d = m as typeof m & { deep_loss?: number; deep_best?: string | null };
    return { m, loss: d.deep_loss ?? m.wp_loss, best: d.deep_loss !== undefined ? (d.deep_best ?? null) : m.best };
  });
  let worst = mine[0] ?? null;
  for (const x of mine) if (x.loss > (worst?.loss ?? -1)) worst = x;
  let turning: Recap["turning"] = null, pattern: Recap["pattern"] = null;
  if (worst && worst.loss >= 5) {
    const rec = blunders.find(b => b.ply === worst!.m.ply && b.is_me);
    const tags = rec ? [...rec.missed.map(motif => ({ kind: "missed" as const, motif })),
                        ...rec.allowed.map(motif => ({ kind: "allowed" as const, motif }))] : [];
    turning = { label: moveLabel(worst.m), loss: worst.loss, phase: worst.m.phase, best: worst.best, fen: worst.m.fen,
      ply: worst.m.ply, moveNo: worst.m.move_no, san: worst.m.san, tactics: tags, clockFrac: worst.m.clock_frac };
    // does it match one of the player's known patterns? (only problems: rates above the opponents')
    for (const t of tags) {
      const stat = tactics?.motifs.find(s => s.kind === t.kind && s.motif === t.motif);
      if (stat && stat.higher && stat.verdict !== "no difference") {
        pattern = { kind: t.kind, motif: t.motif, count: stat.me + 1, verdict: stat.verdict };
        break;
      }
    }
  }
  return {
    url: game.url, endTime: game.endTime, opponent: game.opponent ?? "your opponent", myRating: game.myRating, oppRating: game.oppRating,
    color: game.color, timeClass: game.timeClass, score: game.score, how: howEnded(game),
    expected, surprise: game.score - expected, verdict: upset(game.score, expected),
    opening: { name: game.opening, family: game.family,
      history: past.length ? { n: past.length, score: mean(past.map(r => r.score)), expected: mean(past.map(r => r.expected)) } : null,
      flag },
    turning, pattern, clean: !mine.some(x => x.loss >= BLUNDER_DROP), opponentNote,
  };
}

/** One post-game line about the opponent in this opening, from their own recent games. */
export function opponentNote(opponent: string, oppGames: Game[], family: string, oppColor: "white" | "black"): string | null {
  const asColor = oppGames.filter(g => g.color === oppColor);
  if (asColor.length < 5) return null;
  const inFamily = asColor.filter(g => g.family === family);
  const side = oppColor === "white" ? "White" : "Black";
  const counts = new Map<string, number>();
  for (const g of asColor) counts.set(g.family, (counts.get(g.family) ?? 0) + 1);
  const [topFamily, topN] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const pct = (x: number) => `${Math.round(100 * x)}%`;
  if (inFamily.length >= 3) {
    const sc = inFamily.reduce((a, g) => a + g.score, 0) / inFamily.length;
    const exp = inFamily.reduce((a, g) => a + expectedScore(g.myRating, g.oppRating), 0) / inFamily.length;
    return `${opponent} has played the ${family} as ${side} in ${inFamily.length} of their last ${asColor.length} games as ${side}, ` +
      `scoring ${pct(sc)} against an expected ${pct(exp)}.` + (topFamily !== family ? ` Their most common opening as ${side} is the ${topFamily} (${topN} games).` : "");
  }
  return `The ${family} was new territory for ${opponent}: ${inFamily.length ? `only ${inFamily.length}` : "none"} of their last ${asColor.length} games as ${side}. ` +
    `They usually play the ${topFamily} (${topN} games).`;
}

export const motifName = (kind: string, motif: string) =>
  `${kind === "missed" ? "missed" : "allowed"} ${MOTIF_LABEL[motif] ?? motif}`;
