// search_games in the browser: the same per-game summaries as wf/search.py,
// BM25 matching rank_bm25's BM25Okapi exactly, all-MiniLM-L6-v2 embeddings
// through transformers.js (loaded only when the coach searches), and the
// same reciprocal-rank fusion. Summaries and BM25 are parity-tested.
export { outcomeText, summarize } from "./summary";

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

// Keep the most recent corpus for follow-up coach requests in this page.
let recentCorpus: { key: string; vectors: Promise<number[][]> } | undefined;

function embedCorpus(texts: string[]): Promise<number[][]> {
  const key = JSON.stringify(texts);
  if (recentCorpus?.key === key) return recentCorpus.vectors;
  const vectors = embed(texts).catch(error => {
    if (recentCorpus?.vectors === vectors) recentCorpus = undefined;
    throw error;
  });
  recentCorpus = { key, vectors };
  return vectors;
}

/** Positions sorted by descending score, ties in original order (numpy's stable argsort of -score). */
const order = (s: number[]) => s.map((_, i) => i).sort((a, b) => s[b] - s[a] || a - b);

export class GameIndex {
  private bm25: BM25;
  private vectors?: Promise<number[][]>;
  constructor(public urls: string[], public texts: string[], private embedFn = embed) {
    this.bm25 = new BM25(texts.map(tokens));
  }
  bm25Scores(query: string) { return this.bm25.scores(tokens(query)); }
  async embedScores(query: string): Promise<number[]> {
    const pending = this.vectors ??= this.embedFn === embed ? embedCorpus(this.texts) : this.embedFn(this.texts);
    const vectors = await pending.catch(error => {
      if (this.vectors === pending) this.vectors = undefined;
      throw error;
    });
    const [q] = await this.embedFn([query]);
    return vectors.map(v => v.reduce((a, x, i) => a + x * q[i], 0));
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
