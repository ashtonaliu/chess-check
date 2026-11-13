// Full analysis in the browser, producing the same payload shape as the
// Python server's /api/analyze (wf/pipeline.py to_payload), so the page
// renders either one.
import { analyseGames, BLUNDER_DROP, DEEP_DEPTH_BROWSER, moveLabel, phaseSummary, recheckBlunders, worstBlunders } from "./engine";
import { fetchGames } from "./games";
import { buildFacts } from "./facts";
import { summarize } from "./summary";
import { summarize as summarizeTactics } from "./tactics";
import { playerRisk, rowsOf } from "./model";
import { formatMoves, openingTable, overall, withExpected, worstBranch } from "./stats";

export const STAGES = ["Fetch games", "Run Stockfish", "Double-check blunders", "Find patterns", "Done"];

export interface BrowserOptions {
  username: string; games: number; timeClass: string | null; depth: number; engineUrl: string;
  onStatus?: (msg: string) => void; signal?: AbortSignal;
  /** stage = index into STAGES; frac = progress within it (null if unknown) */
  onProgress?: (stage: number, frac: number | null, text: string) => void;
}

const eta = (t0: number, done: number, total: number, cached = 0) => {
  if (done <= cached || done >= total) return "";
  const s = Math.round(((performance.now() - t0) / (done - cached)) * (total - done) / 1000);
  return ` · about ${s}s left`;
};

export async function analyzeInBrowser(o: BrowserOptions) {
  const report = (stage: number, frac: number | null, text: string) => { o.onStatus?.(text); o.onProgress?.(stage, frac, text); };
  report(0, null, `Fetching ${o.username}'s games from Chess.com…`);
  const games = await fetchGames(o.username, o.games, o.timeClass, o.signal);
  if (games.length < 5) throw new Error(`Only ${games.length} standard games found for "${o.username}".`);
  const rows = withExpected(games);
  const t0 = performance.now();
  const analyses = await analyseGames(games, {
    depth: o.depth, engineUrl: o.engineUrl, signal: o.signal,
    onProgress: (done, total, cached) => report(1, done / total,
      `Stockfish is checking every move: game ${done} of ${total}${cached ? ` (${cached} saved from before)` : ""}${eta(t0, done, total, cached)}`),
  });
  const t1 = performance.now();
  report(2, 0, "Double-checking blunders with a deeper search…");
  await recheckBlunders(analyses, { engineUrl: o.engineUrl, onProgress: (done, total) =>
    report(2, done / total, `Double-checking blunders at depth ${DEEP_DEPTH_BROWSER}: ${done} of ${total}${eta(t1, done, total)}`) });
  report(3, null, "Finding patterns: tactics, pieces, openings and time pressure…");
  await new Promise(r => setTimeout(r, 0));   // let the status paint
  const risk = playerRisk(rowsOf(analyses));
  const tactics = summarizeTactics(analyses, new Map(games.map(g => [g.url, g.pgn])), DEEP_DEPTH_BROWSER);
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
  report(4, 1, "Done");
  return {
    username: o.username, time_class: o.timeClass, generated_at: new Date().toISOString(),
    overall: overall(rows), openings, phases: phaseSummary(analyses), blunders,
    risk, facts: buildFacts(rows, analyses, risk, tactics), engine: true, analyses, tactics,
    gameRows: rows, moveRows: rowsOf(analyses),
    summaries: games.map((g, i) => [g.url, summarize(g, analyses[i])] as [string, string]),
    seconds: Math.round((performance.now() - t0) / 1000),
  };
}
