"""Write web/test/fixtures/parity.json: Python's inputs and outputs for the
TypeScript port's parity test (web/test/parity.test.ts).

  python scripts/make_parity_fixture.py USERNAME --games 300
"""
from __future__ import annotations

import argparse
import json
import sys
from itertools import product
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from chesscheck.facts import build_facts  # noqa: E402
from chesscheck.fetch import Game, fetch_games, opening_names  # noqa: E402
from chesscheck.stats import (  # noqa: E402
    games_frame, opening_table, overall, pregame_expected, verdict, worst_branch,
)


FIXTURES = ROOT / "web" / "test" / "fixtures"


def fixture_games(rows):
    """Rebuild the report inputs from a checked-in browser fixture."""
    return [Game(
        url=g["url"], color=g["color"], my_rating=g["myRating"], opp_rating=g["oppRating"],
        score=g["score"], time_class=g["timeClass"], time_control=g["timeControl"],
        eco=g["eco"], opening=g["opening"], family=g["family"], end_time=g["endTime"],
        result=g.get("result", ""), opp_result=g.get("oppResult", ""), moves_san=g["moves"], pgn=g["pgn"],
    ) for g in rows]


def expected_score_grid():
    ratings = (100, 1200, 1400, 1600, 3000)
    return [
        [my, opp, color, time_class, pregame_expected(my, opp, color, time_class)]
        for my, opp, color, time_class in product(
            ratings, ratings, ("white", "black"), ("bullet", "blitz", "rapid", "daily", "unknown")
        )
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("username", nargs="?")
    ap.add_argument("--games", type=int, default=300)
    ap.add_argument("--time-class", default="blitz")
    ap.add_argument("--refresh", action="store_true", help="Reuse the fixture's saved games")
    args = ap.parse_args()
    out = FIXTURES / "parity.json"
    if args.refresh:
        browser_games = json.loads(out.read_text())["games"]
        games = fixture_games(browser_games)
    else:
        if not args.username:
            ap.error("username is required unless refreshing")
        games = fetch_games(args.username, args.games, {args.time_class})
        browser_games = [
            {"url": g.url, "color": g.color, "myRating": g.my_rating, "oppRating": g.opp_rating,
             "score": g.score, "timeClass": g.time_class, "timeControl": g.time_control,
             "eco": g.eco, "opening": g.opening, "family": g.family, "endTime": g.end_time,
             "moves": g.moves_san[:16], "pgn": ""} for g in games
        ]
    df = games_frame(games)
    t = opening_table(df)
    t["verdict"] = [verdict(r) for r in t.itertuples()]
    branches = []
    for r in t.itertuples():
        b = worst_branch(df, r.color, r.family)
        branches.append({"color": r.color, "family": r.family, "branch": b})
    slugs = ["https://www.chess.com/openings/Closed-Sicilian-Defense-3.g3",
             "https://www.chess.com/openings/Caro-Kann", "x/Kings-Indian-Attack",
             "x/Van-t-Kruijs-Opening", "x/Magnus-Sicilian", "", "x/Indian-Game-2.c4",
             "x/Nimzowitsch-Larsen-Attack-Modern-Variation", "x/Four-Knights-Game-Scotch-Variation-Accepted",
             "x/Kings-Indian-Defense-Fianchetto", "x/Petrovs-Defense", "x/Alekhines-Defense-Modern",
             "x/Nimzo-Indian-Defense-4.e3", "x/Queens-Gambit-Declined-Semi-Slav"]
    fixture = {
        "games": browser_games,
        "expected_score_grid": expected_score_grid(),
        "opening_table": t.drop(columns=["tau_post_mean"]).to_dict(orient="records"),
        "branches": branches,
        "overall": overall(df),
        "opening_names": [[s, list(opening_names(s))] for s in slugs],
        "facts": [{"id": f["id"], "text": f["text"]} for f in build_facts(df)[0]],
    }
    out.write_text(json.dumps(fixture, default=float))
    print(f"wrote {out.relative_to(ROOT)}: {len(games)} games, {len(t)} openings")


if __name__ == "__main__":
    main()
