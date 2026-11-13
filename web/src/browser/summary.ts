// Plain-English one-paragraph summary of a game, used by search_games and the
// coach. Kept apart from search.ts so code that only needs summaries (like the
// Chrome extension) does not bundle the embedding library.
import { BLUNDER_DROP, OPENING_PLIES, moveLabel, type GameAnalysis } from "./engine";
import { pyRound } from "./facts";
import type { Game } from "./games";

const HOW_LOST: Record<string, string> = { timeout: "lost on time", checkmated: "got checkmated", resigned: "resigned",
  abandoned: "abandoned the game", timevsinsufficient: "drew on time" };
const HOW_WON: Record<string, string> = { timeout: "won on time", checkmated: "won by checkmate",
  resigned: "won by resignation", abandoned: "won when the opponent abandoned" };
const HOW_DREW: Record<string, string> = { agreed: "drew by agreement", repetition: "drew by repetition",
  stalemate: "drew by stalemate", insufficient: "drew with insufficient material", "50move": "drew by the 50-move rule",
  timevsinsufficient: "drew on time against insufficient material" };

const signed1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;   // Python's {:+.1f}

export function outcomeText(g: Game): string {
  if (g.score === 1) return HOW_WON[g.oppResult] ?? "won";
  if (g.score === 0) return HOW_LOST[g.result] ?? "lost";
  return HOW_DREW[g.result] ?? "drew";
}

export function summarize(g: Game, a: GameAnalysis | null): string {
  const side = g.color === "white" ? "White" : "Black";
  const diff = g.oppRating - g.myRating;
  const opp = diff >= 150 ? "a much stronger" : diff >= 50 ? "a stronger" : diff <= -150 ? "a much weaker"
    : diff <= -50 ? "a weaker" : "an evenly matched";
  const plies = g.moves.length;
  const parts = [`You ${outcomeText(g)} as ${side} against ${opp} opponent (${g.myRating} vs ${g.oppRating}) ` +
    `in the ${g.opening} (${g.family}), ${Math.floor((plies + 1) / 2)} moves.`];
  if (a) {
    const mine = a.moves.filter(m => m.is_me);
    const oe = a.opening_eval;
    if (oe !== null && oe !== undefined) {
      const lead = oe <= -100 ? "You were worse out of the opening" : oe >= 100 ? "You were better out of the opening"
        : "The opening went about equal";
      parts.push(`${lead} (${signed1(oe / 100)} after move 12).`);
    }
    if (mine.length) {
      const evals = mine.map(m => m.cp_after);
      const hi = Math.max(...evals), lo = Math.min(...evals);
      if (hi >= 300 && g.score < 1) parts.push(`You had a winning position (up to ${signed1(hi / 100)}) but did not convert it.`);
      if (lo <= -300 && g.score >= 0.5) parts.push(`You recovered from a losing position (down to ${signed1(lo / 100)}).`);
    }
    let worst = null as (typeof mine)[number] | null;
    for (const m of mine) if (!worst || m.wp_loss > worst.wp_loss) worst = m;   // first maximum, like Python's max()
    if (worst && worst.wp_loss >= BLUNDER_DROP) {
      const f = worst.clock_frac;
      const clock = f !== null && f <= 0.1 ? "in time trouble" : f !== null && f <= 0.3 ? "with little time left"
        : "with time on the clock";
      const best = worst.best ? `; ${worst.best} was better` : "";
      parts.push(`Your worst mistake was ${moveLabel(worst)} in the ${worst.phase}, ${clock}, ` +
        `losing ${pyRound(worst.wp_loss)}% winning chances${best}.`);
      const n = mine.filter(m => m.wp_loss >= BLUNDER_DROP).length;
      if (n > 1) parts.push(`You made ${n} blunders in this game.`);
    } else {
      parts.push("You made no serious blunders.");
    }
    if (plies > OPENING_PLIES && mine.length) parts.push(`The game reached the ${mine[mine.length - 1].phase}.`);
  }
  return parts.join(" ");
}
