// Full analysis in the browser, producing the same payload shape as the
// Python server's /api/analyze (wf/pipeline.py to_payload), so the page
// renders either one.
import { analyseGames, BLUNDER_DROP, moveLabel, phaseSummary, worstBlunders } from "./engine";
import { fetchGames } from "./games";
import { playerRisk, rowsOf } from "./model";
import { formatMoves, openingTable, overall, withExpected, worstBranch } from "./stats";

export interface BrowserOptions {
  username: string; games: number; timeClass: string | null; depth: number; engineUrl: string;
  onStatus?: (msg: string) => void; signal?: AbortSignal;
}

export async function analyzeInBrowser(o: BrowserOptions) {
  o.onStatus?.(`Fetching ${o.username}'s games from Chess.com…`);
  const games = await fetchGames(o.username, o.games, o.timeClass, o.signal);
  if (games.length < 5) throw new Error(`Only ${games.length} standard games found for "${o.username}".`);
  const rows = withExpected(games);
  const t0 = performance.now();
  const analyses = await analyseGames(games, {
    depth: o.depth, engineUrl: o.engineUrl, signal: o.signal,
    onProgress: (done, total, cached) => {
      const secs = Math.round((performance.now() - t0) / 1000);
      const left = done > cached ? Math.round(((performance.now() - t0) / (done - cached)) * (total - done) / 1000) : null;
      o.onStatus?.(`Running Stockfish in your browser: game ${done} of ${total}` +
        (cached ? ` (${cached} cached)` : "") + ` · ${secs}s` + (left !== null && done < total ? ` · about ${left}s left` : ""));
    },
  });
  o.onStatus?.("Training the blunder model on your opponents' moves…");
  await new Promise(r => setTimeout(r, 0));   // let the status paint
  const risk = playerRisk(rowsOf(analyses));
  const openings = openingTable(rows).map(r => {
    const flagged = r.verdict.endsWith("weakness") || r.verdict === "worth watching";
    const b = flagged ? worstBranch(rows, r.color, r.family) : null;
    return { color: r.color, family: r.family, n: r.n, score: r.score, expected: r.expected,
             raw: r.mean_resid, shrunk: r.shrunk, ci_low: r.ci_low, ci_high: r.ci_high,
             p_below: r.p_below, verdict: r.verdict,
             branch: b ? { moves: formatMoves(b.moves), n: b.n, score: b.score, expected: b.expected } : null };
  });
  const blunders = worstBlunders(analyses, 5).filter(m => m.wp_loss >= BLUNDER_DROP)
    .map(m => ({ move: moveLabel(m), best: m.best, loss: m.wp_loss, phase: m.phase, url: m.url, fen: m.fen }));
  return {
    username: o.username, time_class: o.timeClass, generated_at: new Date().toISOString(),
    overall: overall(rows), openings, phases: phaseSummary(analyses), blunders,
    risk, facts: [], engine: true, analyses,
    seconds: Math.round((performance.now() - t0) / 1000),
  };
}
