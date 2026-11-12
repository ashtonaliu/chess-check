// search_games in the browser: the same per-game summaries as wf/search.py,
// BM25 matching rank_bm25's BM25Okapi exactly, all-MiniLM-L6-v2 embeddings
// through transformers.js (loaded only when the coach searches), and the
// same reciprocal-rank fusion. Summaries and BM25 are parity-tested.
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

// ---------- BM25 (rank_bm25.BM25Okapi: k1 = 1.5, b = 0.75, epsilon = 0.25) ----------

export const tokens = (text: string) => text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

export class BM25 {
  private freqs: Map<string, number>[] = [];
  private lens: number[] = [];
  private idf = new Map<string, number>();
  private avgdl: number;
  constructor(docs: string[][], private k1 = 1.5, private b = 0.75, epsilon = 0.25) {
    const nd = new Map<string, number>();
    let total = 0;
    for (const doc of docs) {
      this.lens.push(doc.length); total += doc.length;
      const f = new Map<string, number>();
      for (const w of doc) f.set(w, (f.get(w) ?? 0) + 1);
      this.freqs.push(f);
      for (const w of f.keys()) nd.set(w, (nd.get(w) ?? 0) + 1);
    }
    this.avgdl = total / docs.length;
    let sum = 0; const negative: string[] = [];
    for (const [w, n] of nd) {
      const idf = Math.log(docs.length - n + 0.5) - Math.log(n + 0.5);
      this.idf.set(w, idf); sum += idf;
      if (idf < 0) negative.push(w);
    }
    const eps = epsilon * (sum / this.idf.size);
    for (const w of negative) this.idf.set(w, eps);
  }
  scores(query: string[]): number[] {
    return this.freqs.map((f, i) => {
      let s = 0;
      for (const q of query) {
        const tf = f.get(q) ?? 0;
        s += (this.idf.get(q) || 0) * (tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + this.b * this.lens[i] / this.avgdl)));
      }
      return s;
    });
  }
}

// ---------- embeddings (transformers.js, all-MiniLM-L6-v2, 8-bit ONNX) ----------

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let extractor: Promise<Extractor> | null = null;

export async function embed(texts: string[]): Promise<number[][]> {
  extractor ??= (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    return (await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" })) as unknown as Extractor;
  })();
  const ext = await extractor;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    out.push(...(await ext(texts.slice(i, i + 32), { pooling: "mean", normalize: true })).tolist());
  }
  return out;
}

/** Positions sorted by descending score, ties in original order (numpy's stable argsort of -score). */
const order = (s: number[]) => s.map((_, i) => i).sort((a, b) => s[b] - s[a] || a - b);

export class GameIndex {
  private bm25: BM25;
  private vectors: number[][] | null = null;
  constructor(public urls: string[], public texts: string[], private embedFn = embed) {
    this.bm25 = new BM25(texts.map(tokens));
  }
  bm25Scores(query: string) { return this.bm25.scores(tokens(query)); }
  async embedScores(query: string): Promise<number[]> {
    this.vectors ??= await this.embedFn(this.texts);
    const [q] = await this.embedFn([query]);
    return this.vectors.map(v => v.reduce((a, x, i) => a + x * q[i], 0));
  }
  /** Reciprocal-rank fusion of BM25 and embeddings, as in wf/search.py. */
  async search(query: string, k = 5): Promise<{ i: number; score: number }[]> {
    const fused = new Array(this.urls.length).fill(0);
    for (const s of [this.bm25Scores(query), await this.embedScores(query)]) {
      order(s).forEach((doc, rank) => { fused[doc] += 1 / (60 + rank); });
    }
    return order(fused).slice(0, k).map(i => ({ i, score: fused[i] }));
  }
}
