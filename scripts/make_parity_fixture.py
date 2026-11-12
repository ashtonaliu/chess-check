"""Write web/test/fixtures/parity.json: Python's inputs and outputs for the
TypeScript port's parity test (web/test/parity.test.ts).

  python scripts/make_parity_fixture.py USERNAME --games 300
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from wf.facts import build_facts  # noqa: E402
from wf.fetch import fetch_games, opening_names  # noqa: E402
from wf.stats import games_frame, opening_table, overall, verdict, worst_branch  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("username")
    ap.add_argument("--games", type=int, default=300)
    ap.add_argument("--time-class", default="blitz")
    args = ap.parse_args()
    games = fetch_games(args.username, args.games, {args.time_class})
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
        "games": [{"url": g.url, "color": g.color, "myRating": g.my_rating, "oppRating": g.opp_rating,
                   "score": g.score, "timeClass": g.time_class, "timeControl": g.time_control,
                   "eco": g.eco, "opening": g.opening, "family": g.family, "endTime": g.end_time,
                   "moves": g.moves_san[:16], "pgn": ""} for g in games],
        "opening_table": t.drop(columns=["tau_post_mean"]).to_dict(orient="records"),
        "branches": branches,
        "overall": overall(df),
        "opening_names": [[s, list(opening_names(s))] for s in slugs],
        "facts": [{"id": f["id"], "text": f["text"]} for f in build_facts(df)[0]],
    }
    out = ROOT / "web" / "test" / "fixtures" / "parity.json"
    out.write_text(json.dumps(fixture, default=float))
    print(f"wrote {out.relative_to(ROOT)}: {len(games)} games, {len(t)} openings")


if __name__ == "__main__":
    main()
