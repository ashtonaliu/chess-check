// Blunder-risk model in the browser: a port of wf/model.py player_risk with
// model="logreg". Logistic regression (L2, C=1, intercept unpenalized, on
// standardized features) is fitted exactly by Newton's method, so it reaches
// the same optimum as scikit-learn's solver; folds reproduce GroupKFold.
// Parity with scikit-learn is tested in test/model.test.ts.
import { BLUNDER_DROP, type GameAnalysis, type MoveRow } from "./engine";

export const FEATURES = [
  "move_no", "legal_moves", "in_check", "captures_available",
  "material_balance", "non_pawn_material", "cp_before_clip", "abs_cp",
  "clock_frac_f", "clock_missing", "log_clock", "log_spent",
  "phase_opening", "phase_middlegame", "phase_endgame",
  // band indicators: keep a linear model calibrated within each clock band
  "clock_lt10", "clock_10_30", "abs_cp_gt300", "abs_cp_gt700",
] as const;

export interface Row extends MoveRow { url: string; }

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Feature matrix, labels and game ids (wf/model.py features). */
export function features(rows: Row[]): { X: number[][]; y: number[]; groups: string[] } {
  const clocks = rows.map(r => r.clock).filter((c): c is number => c !== null && Number.isFinite(c));
  const clockFill = clocks.length ? median(clocks) : 0;
  const X = rows.map(r => {
    const cp = Math.max(-1000, Math.min(1000, r.cp_before));
    const abs = Math.abs(cp);
    const frac = r.clock_frac;
    const f: Record<(typeof FEATURES)[number], number> = {
      move_no: r.move_no, legal_moves: r.legal_moves, in_check: r.in_check,
      captures_available: r.captures_available, material_balance: r.material_balance,
      non_pawn_material: r.non_pawn_material, cp_before_clip: cp, abs_cp: abs,
      clock_frac_f: frac === null ? 1 : Math.max(0, Math.min(2, frac)),
      clock_missing: r.clock === null ? 1 : 0,
      log_clock: Math.log1p(Math.max(0, r.clock ?? clockFill)),
      log_spent: Math.log1p(Math.max(0, r.time_spent ?? 0)),
      phase_opening: +(r.phase === "opening"), phase_middlegame: +(r.phase === "middlegame"),
      phase_endgame: +(r.phase === "endgame"),
      clock_lt10: +(frac !== null && frac <= 0.1), clock_10_30: +(frac !== null && frac > 0.1 && frac <= 0.3),
      abs_cp_gt300: +(abs > 300), abs_cp_gt700: +(abs > 700),
    };
    return FEATURES.map(k => f[k]);
  });
  return { X, y: rows.map(r => +(r.wp_loss >= BLUNDER_DROP)), groups: rows.map(r => r.url) };
}

/** Fold per row, reproducing scikit-learn's GroupKFold (no shuffle). */
export function groupFolds(groups: string[], nSplits = 5): number[] {
  const unique = [...new Set(groups)].sort();               // np.unique
  const idx = new Map(unique.map((g, i) => [g, i]));
  const counts = new Array(unique.length).fill(0);
  for (const g of groups) counts[idx.get(g)!]++;
  // np.argsort(kind="stable")[::-1]: by size descending, ties by larger index first
  const order = unique.map((_, i) => i).sort((a, b) => counts[a] - counts[b] || a - b).reverse();
  const load = new Array(nSplits).fill(0), groupFold = new Array(unique.length).fill(0);
  for (const gi of order) {
    let k = 0;
    for (let j = 1; j < nSplits; j++) if (load[j] < load[k]) k = j;   // np.argmin: first minimum
    load[k] += counts[gi];
    groupFold[gi] = k;
  }
  return groups.map(g => groupFold[idx.get(g)!]);
}

/** Solve A x = b (A symmetric positive definite) by Cholesky. */
function solveSpd(A: number[][], b: number[]): number[] {
  const n = b.length, L = A.map(r => r.map(() => 0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j];
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
  }
  const z = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * z[k]; z[i] = s / L[i][i]; }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = z[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}

const sigmoid = (t: number) => (t >= 0 ? 1 / (1 + Math.exp(-t)) : Math.exp(t) / (1 + Math.exp(t)));

export interface LogReg { mean: number[]; scale: number[]; w: number[]; b: number; }

/** StandardScaler + LogisticRegression(C=1): minimize sum(log loss) + ||w||^2 / 2. */
export function fitLogReg(X: number[][], y: number[], C = 1, maxIter = 50): LogReg {
  const n = X.length, d = X[0].length;
  const mean = new Array(d).fill(0), scale = new Array(d).fill(0);
  for (const r of X) r.forEach((v, j) => (mean[j] += v / n));
  for (const r of X) r.forEach((v, j) => (scale[j] += (v - mean[j]) ** 2 / n));
  for (let j = 0; j < d; j++) scale[j] = Math.sqrt(scale[j]) || 1;      // ddof=0; constant -> 1
  const Z = X.map(r => r.map((v, j) => (v - mean[j]) / scale[j]));
  let theta = new Array(d + 1).fill(0);                                  // [w..., b]
  for (let it = 0; it < maxIter; it++) {
    const g = new Array(d + 1).fill(0);
    const H = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const z = Z[i];
      let t = theta[d];
      for (let j = 0; j < d; j++) t += theta[j] * z[j];
      const p = sigmoid(t), r = p - y[i], s = p * (1 - p);
      for (let j = 0; j <= d; j++) {
        const zj = j < d ? z[j] : 1;
        g[j] += r * zj;
        for (let k = 0; k <= j; k++) H[j][k] += s * zj * (k < d ? z[k] : 1);
      }
    }
    for (let j = 0; j < d; j++) { g[j] += theta[j] / C; H[j][j] += 1 / C; }
    for (let j = 0; j <= d; j++) for (let k = j + 1; k <= d; k++) H[j][k] = H[k][j];
    const step = solveSpd(H, g);
    theta = theta.map((v, j) => v - step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-10) break;
  }
  return { mean, scale, w: theta.slice(0, d), b: theta[d] };
}

export function predict(m: LogReg, x: number[]): number {
  let t = m.b;
  for (let j = 0; j < x.length; j++) t += m.w[j] * ((x[j] - m.mean[j]) / m.scale[j]);
  return sigmoid(t);
}

/** 90% interval for actual/expected with a Poisson count (Byar's approximation). */
export function poissonRatioInterval(a: number, expected: number, z = 1.645): [number, number] {
  const lo = a === 0 ? 0 : a * (1 - 1 / (9 * a) - z / (3 * Math.sqrt(a))) ** 3;
  const hi = (a + 1) * (1 - 1 / (9 * (a + 1)) + z / (3 * Math.sqrt(a + 1))) ** 3;
  return [lo / expected, hi / expected];
}

const BUCKETS: [number, number, string][] = [
  [-0.01, 0.1, "under 10% of the clock left"],
  [0.1, 0.3, "10-30% of the clock left"],
  [0.3, 10, "over 30% of the clock left"],
];

export interface Risk {
  model: string; moves: number; actual: number; expected: number; ratio: number; ci_low: number; ci_high: number;
  buckets: { label: string; moves: number; actual: number; expected: number; ratio: number; ci_low: number; ci_high: number }[];
}

/** Actual vs expected blunders: train on opponents' moves, score the user's held-out games. */
export function playerRisk(rows: Row[], nSplits = 5, folds?: number[]): Risk | null {
  const { X, y, groups } = features(rows);
  const me = rows.map(r => r.is_me);
  const oppBlunders = y.reduce((a, v, i) => a + (me[i] ? 0 : v), 0);
  if (oppBlunders < 10 || new Set(groups).size < nSplits) return null;
  const fold = folds ?? groupFolds(groups, nSplits);
  const oof = new Array(rows.length).fill(0);
  for (let k = 0; k < nSplits; k++) {
    const tr = rows.map((_, i) => i).filter(i => fold[i] !== k && !me[i]);
    const m = fitLogReg(tr.map(i => X[i]), tr.map(i => y[i]));
    rows.forEach((_, i) => { if (fold[i] === k) oof[i] = predict(m, X[i]); });
  }
  const sum = (sel: (i: number) => boolean, v: number[]) => v.reduce((a, x, i) => a + (sel(i) ? x : 0), 0);
  const actual = sum(i => me[i], y), expected = sum(i => me[i], oof);
  const [ci_low, ci_high] = poissonRatioInterval(actual, expected);
  const out: Risk = { model: "logistic regression", moves: me.filter(Boolean).length, actual, expected,
                      ratio: actual / expected, ci_low, ci_high, buckets: [] };
  for (const [lo, hi, label] of BUCKETS) {
    const sel = (i: number) => me[i] && rows[i].clock_frac !== null && rows[i].clock_frac! > lo && rows[i].clock_frac! <= hi;
    const n = rows.filter((_, i) => sel(i)).length, a = sum(sel, y), e = sum(sel, oof);
    if (n >= 30 && e > 0) {
      const [l, h] = poissonRatioInterval(a, e);
      out.buckets.push({ label, moves: n, actual: a, expected: e, ratio: a / e, ci_low: l, ci_high: h });
    }
  }
  return out;
}

export const rowsOf = (analyses: GameAnalysis[]): Row[] =>
  analyses.flatMap(a => a.moves.map(m => ({ ...m, url: a.url })));
