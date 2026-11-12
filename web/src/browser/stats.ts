// Rating-adjusted opening statistics. A line-by-line port of wf/stats.py
// (same grids, same prior, same verdict rules); parity is tested against the
// Python output in test/parity.test.ts.
import type { Game } from "./games";

export interface GameRow extends Game { expected: number; residual: number; }

export const expectedScore = (my: number, opp: number) => 1 / (1 + 10 ** ((opp - my) / 400));

export function withExpected(games: Game[]): GameRow[] {
  return games.map(g => {
    const expected = expectedScore(g.myRating, g.oppRating);
    return { ...g, expected, residual: g.score - expected };
  });
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function variance(xs: number[]): number {  // ddof = 1
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}
const linspace = (a: number, b: number, n: number) =>
  Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

// Normal CDF via erf (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7).
function erf(x: number): number {
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
export const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

const TAU_PRIOR_SCALE = 0.10;
const TAU_GRID = linspace(0.005, 0.40, 80);
const THETA_GRID = linspace(-1, 1, 2001);

export interface OpeningRow {
  color: "white" | "black"; family: string; n: number;
  score: number; expected: number; mean_resid: number;
  shrunk: number; post_sd: number; ci_low: number; ci_high: number; p_below: number;
  raw_z: number; n_openings: number; verdict: string;
}

/** Hierarchical normal model with the between-opening SD integrated out (see wf/stats.py). */
function shrink(groups: { n: number; mean_resid: number }[], sigma2: number, mu: number) {
  const G = groups.length;
  const noise = groups.map(g => sigma2 / g.n);
  const y = groups.map(g => g.mean_resid);
  const lw = TAU_GRID.map(tau => {
    const t2 = tau * tau;
    let ll = 0;
    for (let i = 0; i < G; i++) {
      const mv = t2 + noise[i];
      ll += Math.log(mv) + (y[i] - mu) ** 2 / mv;
    }
    return -0.5 * ll - 0.5 * (tau / TAU_PRIOR_SCALE) ** 2;
  });
  const mx = Math.max(...lw);
  let w = lw.map(v => Math.exp(v - mx));
  const ws = w.reduce((a, b) => a + b, 0);
  w = w.map(v => v / ws);

  return groups.map((_, i) => {
    let pm = 0, second = 0, p0 = 0;
    const ms: number[] = [], sds: number[] = [];
    TAU_GRID.forEach((tau, t) => {
      const t2 = tau * tau;
      const k = t2 / (t2 + noise[i]);
      const m = mu + k * (y[i] - mu);
      const v = 1 / (1 / t2 + 1 / noise[i]);
      ms.push(m); sds.push(Math.sqrt(v));
      pm += w[t] * m;
      second += w[t] * (v + m * m);
      p0 += w[t] * normCdf((0 - m) / Math.sqrt(v));
    });
    // mixture CDF on the theta grid -> 5% / 95% points
    let lo = NaN, hi = NaN;
    for (const x of THETA_GRID) {
      let c = 0;
      for (let t = 0; t < TAU_GRID.length; t++) c += w[t] * normCdf((x - ms[t]) / sds[t]);
      if (Number.isNaN(lo) && c >= 0.05) lo = x;
      if (c >= 0.95) { hi = x; break; }
    }
    return { shrunk: pm, post_sd: Math.sqrt(Math.max(second - pm * pm, 0)), ci_low: lo, ci_high: hi, p_below: p0 };
  });
}

export function verdict(r: Pick<OpeningRow, "p_below" | "ci_high" | "ci_low" | "n" | "raw_z">): string {
  if (r.p_below >= 0.9 && r.ci_high < 0) return "weakness";
  if (r.p_below >= 0.75) return "possible weakness";
  if (r.p_below <= 0.1 && r.ci_low > 0) return "strength";
  if (r.p_below <= 0.25) return "possible strength";
  if (r.n >= 8 && r.raw_z <= -1.645) return "worth watching";
  return "not enough evidence";
}

export function openingTable(rows: GameRow[], minGames = 3): OpeningRow[] {
  if (!rows.length) return [];
  const sigma2 = rows.length > 1 ? Math.max(variance(rows.map(r => r.residual)), 0.05) : 0.2;
  const mu = mean(rows.map(r => r.residual));
  const byKey = new Map<string, GameRow[]>();
  for (const r of rows) {
    const k = `${r.color}\u0000${r.family}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
  }
  const groups = [...byKey.values()].filter(g => g.length >= minGames).map(g => ({
    color: g[0].color, family: g[0].family, n: g.length,
    score: mean(g.map(r => r.score)), expected: mean(g.map(r => r.expected)),
    mean_resid: mean(g.map(r => r.residual)),
  }));
  if (!groups.length) return [];
  const post = shrink(groups, sigma2, mu);
  const out = groups.map((g, i) => {
    const raw_z = g.mean_resid / Math.sqrt(sigma2 / g.n);
    const row = { ...g, ...post[i], raw_z, n_openings: groups.length, verdict: "" };
    row.verdict = verdict(row);
    return row;
  });
  return out.sort((a, b) => a.shrunk - b.shrunk);
}

export interface Branch { moves: string; ply: number; n: number; score: number; expected: number; mean_resid: number; gap: number; }

/** The longest, worst-scoring move prefix inside one opening (wf/stats.py worst_branch). */
export function worstBranch(rows: GameRow[], color: string, family: string, minGames = 3, maxPly = 12): Branch | null {
  const sub = rows.filter(r => r.color === color && r.family === family);
  if (sub.length < minGames) return null;
  const base = mean(sub.map(r => r.residual));
  let best: Branch | null = null;
  for (let ply = 4; ply <= maxPly; ply++) {
    const groups = new Map<string, GameRow[]>();
    for (const r of sub) {
      const pre = r.moves.slice(0, Math.min(16, r.moves.length)).slice(0, ply);
      if (pre.length < ply) continue;
      const key = pre.join(" ");
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
    }
    for (const key of [...groups.keys()].sort()) {
      const g = groups.get(key)!;
      if (g.length < minGames) continue;
      const mr = mean(g.map(r => r.residual));
      const cand: Branch = { moves: key, ply, n: g.length, score: mean(g.map(r => r.score)),
                             expected: mean(g.map(r => r.expected)), mean_resid: mr, gap: mr - base };
      if (cand.gap < -0.1 && (best === null || cand.mean_resid < best.mean_resid ||
          (cand.mean_resid === best.mean_resid && -ply < -best.ply))) best = cand;
    }
  }
  return best;
}

export function formatMoves(moves: string): string {
  return moves.split(" ").filter(Boolean).map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}.${san}` : san)).join(" ");
}

export function overall(rows: GameRow[]) {
  const res = rows.map(r => r.residual);
  return {
    games: rows.length, score: mean(rows.map(r => r.score)), expected: mean(rows.map(r => r.expected)),
    resid: mean(res), avg_rating: Math.round(mean(rows.map(r => r.myRating))),
    se: rows.length > 1 ? Math.sqrt(variance(res) / rows.length) : null,
  };
}
