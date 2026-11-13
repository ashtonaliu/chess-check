"""Write web/test/fixtures/tactics.json for the TypeScript tactics parity test:
Python's motif labels for Lichess puzzle positions (CC0 data), and Python's
tactic summary and coach facts for real games with the deep re-check.

  python scripts/make_tactics_fixture.py data/puzzles_50k.csv USERNAME
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import chess

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from wf import engine  # noqa: E402
from wf.facts import build_facts  # noqa: E402
from wf.fetch import fetch_games  # noqa: E402
from wf.stats import games_frame  # noqa: E402
from wf.tactics import motifs, summarize  # noqa: E402


def main():
    puzzles_csv, user = sys.argv[1], sys.argv[2]
    positions = []
    with open(puzzles_csv, newline="") as f:
        for i, row in enumerate(csv.DictReader(f)):
            if i < 30000:            # skip the rows used to tune the detector
                continue
            if len(positions) >= 3000:
                break
            b = chess.Board(row["FEN"])
            ucis = row["Moves"].split()
            b.push_uci(ucis[0])
            mv = chess.Move.from_uci(ucis[1])
            positions.append({"fen": b.fen(), "from": chess.square_name(mv.from_square),
                              "to": chess.square_name(mv.to_square),
                              "promotion": chess.piece_symbol(mv.promotion) if mv.promotion else None,
                              "motifs": sorted(motifs(b, mv))})
    games = fetch_games(user, 25, {"blitz"})
    analyses = engine.analyse_games(games, depth=10)
    engine.recheck_blunders(analyses)
    pgns = {g.url: g.pgn for g in games}
    summary = summarize(analyses, pgns)
    facts, _ = build_facts(games_frame(games), analyses, None, summary)
    fixture = {
        "positions": positions,
        "games": [{"url": g.url, "color": g.color, "myRating": g.my_rating, "oppRating": g.opp_rating,
                   "score": g.score, "timeClass": g.time_class, "timeControl": g.time_control, "eco": g.eco,
                   "opening": g.opening, "family": g.family, "endTime": g.end_time, "result": g.result,
                   "oppResult": g.opp_result, "moves": g.moves_san, "pgn": g.pgn} for g in games],
        "analyses": [{"url": a["url"], "color": a["color"], "opening_eval": a["opening_eval"], "moves": a["moves"]}
                     for a in analyses],
        "summary": {k: summary[k] for k in ("motifs", "pieces", "n_tests", "flagged", "confirmed",
                                            "forks_allowed_by", "pieces_lost")},
        "facts": [{"id": f["id"], "text": f["text"]} for f in facts],
    }
    out = ROOT / "web/test/fixtures/tactics.json"
    def clean(x):   # JSON has no NaN/Infinity: NaN -> null, infinities -> strings
        if isinstance(x, float):
            return None if x != x else ("Infinity" if x == float("inf") else "-Infinity" if x == float("-inf") else x)
        if isinstance(x, dict):
            return {k: clean(v) for k, v in x.items()}
        if isinstance(x, list):
            return [clean(v) for v in x]
        return x

    out.write_text(json.dumps(clean(fixture), allow_nan=False))
    print(f"wrote {out.relative_to(ROOT)}: {len(positions)} positions, {len(games)} games, "
          f"{len(facts)} facts, {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
