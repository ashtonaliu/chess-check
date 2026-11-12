// search_games must match wf/search.py: summaries character for character,
// BM25 scores to 1e-9, and the hybrid ranking exactly (given the same
// embedding vectors, which are injected from the Python fixture).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { GameAnalysis, MoveRow } from "../src/browser/engine";
import type { Game } from "../src/browser/games";
import { BM25, GameIndex, summarize, tokens } from "../src/browser/search";

const fx = JSON.parse(readFileSync(new URL("./fixtures/model.json", import.meta.url), "utf8"));
const S = fx.search;
const games = fx.games as Game[];

function analyses(): GameAnalysis[] {
  const byUrl = new Map<string, MoveRow[]>();
  for (const r of fx.rows) (byUrl.get(r.url) ?? byUrl.set(r.url, []).get(r.url)!).push(r);
  return games.map(g => ({ url: g.url, color: g.color, moves: byUrl.get(g.url) ?? [], opening_eval: fx.opening_eval[g.url] }));
}

test("game summaries match Python exactly", () => {
  const an = analyses();
  assert.deepEqual(games.map((g, i) => summarize(g, an[i])), S.summaries);
});

test("BM25 scores match rank_bm25", () => {
  const bm = new BM25(S.summaries.map(tokens));
  S.queries.forEach((q: string, qi: number) => {
    bm.scores(tokens(q)).forEach((v, i) => assert.ok(Math.abs(v - S.bm25[qi][i]) < 1e-9, `${q} doc ${i}: ${v} vs ${S.bm25[qi][i]}`));
  });
});

test("hybrid ranking matches Python given the same embeddings", async () => {
  // fake embedder: documents get Python's vectors, queries get Python's query vectors
  const docKey = new Map<string, number[]>(S.summaries.map((t: string, i: number) => [t, S.doc_vectors[i]]));
  const qKey = new Map<string, number[]>(S.queries.map((q: string, i: number) => [q, S.query_vectors[i]]));
  const fake = async (texts: string[]) => texts.map(t => docKey.get(t) ?? qKey.get(t)!);
  const idx = new GameIndex(games.map(g => g.url), S.summaries, fake);
  for (const [qi, q] of (S.queries as string[]).entries()) {
    const hits = await idx.search(q, 5);
    assert.deepEqual(hits.map(h => h.i), S.hybrid_top5[qi], q);
  }
});
