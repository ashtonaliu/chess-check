"""Validate the tactic detector against Lichess puzzle themes.

Each Lichess puzzle gives a position, the opponent's setup move, the solution
moves, and theme tags written by Lichess's own tagger. The app tags a single
move (the reply to a blunder, or the move that was missed), so the main score
runs the detector on the first solution move only. "--any-move" instead takes
the union over all of the solver's moves, closer to what the themes describe.
Reports precision, recall and F1 per motif. Lichess themes are not exhaustive
(a puzzle may contain a fork without being tagged "fork"), so precision is a
lower bound.

  python scripts/eval_tactics.py data/puzzles_50k.csv --n 20000
"""
from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from pathlib import Path

import chess

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wf.tactics import MOTIFS, motifs  # noqa: E402


def truth(themes: set[str]) -> set[str]:
    t = {m for m in MOTIFS if m in themes}
    if any(x.startswith("mateIn") for x in themes) or "mate" in themes:
        t.add("mate")
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--n", type=int, default=20000)
    ap.add_argument("--any-move", action="store_true")
    args = ap.parse_args()
    tp, fp, fn, support = Counter(), Counter(), Counter(), Counter()
    n = 0
    with open(args.csv, newline="") as f:
        for row in csv.DictReader(f):
            if n >= args.n:
                break
            board = chess.Board(row["FEN"])
            ucis = row["Moves"].split()
            board.push_uci(ucis[0])                      # the opponent's setup move
            found = set()
            for i, u in enumerate(ucis[1:]):
                mv = chess.Move.from_uci(u)
                if i % 2 == 0 and (args.any_move or i == 0):   # the solver's moves
                    found |= motifs(board, mv)
                board.push(mv)
            want = truth(set(row["Themes"].split()))
            for m in MOTIFS:
                support[m] += m in want
                if m in found and m in want:
                    tp[m] += 1
                elif m in found:
                    fp[m] += 1
                elif m in want:
                    fn[m] += 1
            n += 1
    print(f"{n} Lichess puzzles, {'all solver moves' if args.any_move else 'first solution move'}\n")
    print("| Motif | Puzzles with this theme | Precision | Recall | F1 |")
    print("|---|---:|---:|---:|---:|")
    for m in MOTIFS:
        p = tp[m] / (tp[m] + fp[m]) if tp[m] + fp[m] else float("nan")
        r = tp[m] / (tp[m] + fn[m]) if tp[m] + fn[m] else float("nan")
        f1 = 2 * p * r / (p + r) if p + r else float("nan")
        print(f"| {m} | {support[m]} | {p:.2f} | {r:.2f} | {f1:.2f} |")


if __name__ == "__main__":
    main()
