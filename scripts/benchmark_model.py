"""Benchmark the blunder-risk models on one or more players' games.

  python scripts/benchmark_model.py player1 player2 --games 200 --time-class blitz
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wf import db, engine, model  # noqa: E402
from wf.fetch import fetch_games  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("users", nargs="+")
    ap.add_argument("--games", type=int, default=200)
    ap.add_argument("--time-class", default="blitz")
    ap.add_argument("--depth", type=int, default=10)
    args = ap.parse_args()

    frames, seen = [], set()
    for u in args.users:
        games = [g for g in fetch_games(u, args.games, {args.time_class}) if g.url not in seen]
        seen |= {g.url for g in games}
        an = engine.analyse_games(games, depth=args.depth,
                                  progress=lambda d, n: print(f"\r{u}: {d}/{n}", end="", flush=True))
        print()
        frames.append(db.moves_frame(an))
    moves = pd.concat(frames, ignore_index=True)
    b = model.benchmark(moves)
    print(f"\n{b['n_moves']} moves from {b['n_games']} games, blunder rate {b['blunder_rate']:.2%}, "
          f"{b['test_moves']} test moves (split grouped by game)\n")
    print(b["table"].round(3).to_markdown(index=False))
    print("\nPermutation importance (AUC drop, gradient boosting):")
    print(b["importance"].head(8).round(4).to_markdown())


if __name__ == "__main__":
    main()
