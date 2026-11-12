"""Retrieval eval for the coach's search_games tool.

Each query has a ground-truth predicate computed from the structured game
data (never from the summary text), and is worded differently from the
summaries ("flagged" vs "lost on time"), so keyword overlap alone can't win.
Metrics per query: precision@5 and recall@10; averaged over queries and
players. Random retrieval's expected precision is the share of relevant games.

  python scripts/eval_search.py USER1 USER2 ... --games 150
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wf import engine  # noqa: E402
from wf.fetch import fetch_games  # noqa: E402
from wf.search import GameIndex  # noqa: E402

B = engine.BLUNDER_DROP


def worst(a):
    mine = [m for m in a["moves"] if m["is_me"]]
    return max(mine, key=lambda m: m["wp_loss"], default=None)


def my_evals(a):
    return [m["cp_after"] for m in a["moves"] if m["is_me"]] or [0]


# (query, predicate(game, analysis)) - queries avoid the summaries' wording
QUERIES = [
    ("ran out of clock and got flagged", lambda g, a: g.score == 0 and g.result == "timeout"),
    ("my opponent's clock ran out and I won that way", lambda g, a: g.score == 1 and g.opp_result == "timeout"),
    ("threw away a completely winning game", lambda g, a: g.score < 1 and max(my_evals(a)) >= 300),
    ("saved or won a game that looked lost", lambda g, a: g.score >= 0.5 and min(my_evals(a)) <= -300),
    ("terrible mistake made while nearly out of time",
     lambda g, a: (w := worst(a)) is not None and w["wp_loss"] >= B and w.get("clock_frac") is not None
     and w["clock_frac"] <= 0.1),
    ("already in a bad position early on, right after the opening",
     lambda g, a: a.get("opening_eval") is not None and a["opening_eval"] <= -100),
    ("my king got mated", lambda g, a: g.score == 0 and g.result == "checkmated"),
    ("beat someone rated well above me", lambda g, a: g.score == 1 and g.opp_rating - g.my_rating >= 50),
    ("lost because of an error late in the game with few pieces left",
     lambda g, a: g.score == 0 and (w := worst(a)) is not None and w["wp_loss"] >= B and w["phase"] == "endgame"),
    ("clean games without any big errors", lambda g, a: (w := worst(a)) is None or w["wp_loss"] < B),
    ("games that ended in a draw", lambda g, a: g.score == 0.5),
    ("Sicilian games with the black pieces", lambda g, a: g.family == "Sicilian Defense" and g.color == "black"),
    ("I gave up and resigned", lambda g, a: g.score == 0 and g.result == "resigned"),
    ("several blunders in one game", lambda g, a: sum(m["wp_loss"] >= B for m in a["moves"] if m["is_me"]) >= 2),
]
METHODS = ["random", "bm25", "embed", "hybrid"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("users", nargs="+")
    ap.add_argument("--games", type=int, default=150)
    ap.add_argument("--depth", type=int, default=8)
    args = ap.parse_args()
    per_query = {q: {m: [] for m in METHODS} for q, _ in QUERIES}
    for i, user in enumerate(args.users, 1):
        games = fetch_games(user, args.games, {"blitz"})
        analyses = engine.analyse_games(games, depth=args.depth)
        idx = GameIndex.build(games, analyses)
        by_url = {a["url"]: a for a in analyses}
        for q, pred in QUERIES:
            rel = {j for j, g in enumerate(games) if pred(g, by_url[g.url])}
            if len(rel) < 3:            # too rare in this player's games to score
                continue
            base = len(rel) / len(games)
            per_query[q]["random"].append((base, min(1.0, 10 / len(games) * 1.0)))
            for m in ("bm25", "embed", "hybrid"):
                top = [j for j, _ in idx.search(q, 10, m)]
                p5 = sum(j in rel for j in top[:5]) / 5
                r10 = sum(j in rel for j in top) / len(rel)
                per_query[q][m].append((p5, r10))
        print(f"player {i}: {len(games)} games indexed", flush=True)

    print("\nPrecision@5 by query (mean over players where the query had >= 3 relevant games)\n")
    print("| Query | Players | Random | BM25 | Embeddings | Hybrid |")
    print("|---|---:|---:|---:|---:|---:|")
    totals = {m: [] for m in METHODS}
    for q, _ in QUERIES:
        r = per_query[q]
        if not r["bm25"]:
            continue
        cells = []
        for m in METHODS:
            vals = [p for p, _ in r[m]]
            totals[m].extend(vals)
            cells.append(f"{np.mean(vals):.2f}")
        print(f"| {q} | {len(r['bm25'])} | " + " | ".join(cells) + " |")
    print("| **Mean over all query-player pairs** | | " +
          " | ".join(f"**{np.mean(totals[m]):.2f}**" for m in METHODS) + " |")
    print("\nRecall@10 (mean): " + ", ".join(
        f"{m} {np.mean([r10 for q, _ in QUERIES for _, r10 in per_query[q][m]]):.2f}"
        for m in ("bm25", "embed", "hybrid")))


if __name__ == "__main__":
    main()
