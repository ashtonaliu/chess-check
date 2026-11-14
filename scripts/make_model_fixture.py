"""Write web/test/fixtures/model.json: scikit-learn's folds, fitted
probabilities and player-risk output on real engine-analysed games, for the
TypeScript port's parity test (web/test/model.test.ts).

  python scripts/make_model_fixture.py USERNAME --games 40
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from chesscheck import db, engine, model  # noqa: E402
from chesscheck.facts import build_facts  # noqa: E402
from chesscheck.fetch import fetch_games  # noqa: E402
from chesscheck.stats import games_frame  # noqa: E402
from make_parity_fixture import FIXTURES, fixture_games  # noqa: E402

COLS = ["url", "ply", "move_no", "san", "best", "mover", "is_me", "phase", "cp_before", "cp_after",
        "wp_loss", "clock", "clock_frac", "time_spent", "legal_moves", "in_check",
        "captures_available", "material_balance", "non_pawn_material", "is_capture"]


def refresh_facts(out):
    fixture = json.loads(out.read_text())
    games = fixture_games(fixture["games"])
    moves_by_url = {g.url: [] for g in games}
    for move in fixture["rows"]:
        # FEN is only used in fact metadata, which this fixture omits.
        moves_by_url[move["url"]].append({**move, "fen": None})
    analyses = [
        {"url": g.url, "color": g.color, "opening_eval": fixture["opening_eval"][g.url],
         "moves": moves_by_url[g.url]} for g in games
    ]
    write_facts(fixture, games, analyses)
    out.write_text(json.dumps(fixture))
    print(f"refreshed facts in {out.relative_to(ROOT)}")


def write_facts(fixture, games, analyses):
    facts, _ = build_facts(games_frame(games), analyses, fixture["risk"])
    fixture["facts"] = [{"id": f["id"], "text": f["text"]} for f in facts]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("username", nargs="?")
    ap.add_argument("--games", type=int, default=40)
    ap.add_argument("--refresh-facts", action="store_true", help="Reuse saved analysis and risk")
    args = ap.parse_args()
    out = FIXTURES / "model.json"
    if args.refresh_facts:
        refresh_facts(out)
        return
    if not args.username:
        ap.error("username is required unless refreshing facts")
    games = fetch_games(args.username, args.games, {"blitz"})
    analyses = engine.analyse_games(games, depth=8)
    moves = db.moves_frame(analyses)[COLS]
    X, y, groups = model.features(moves)
    me = moves.is_me.to_numpy().astype(bool)
    fold = model.group_folds(groups)
    full = model._logreg().fit(X[~me], y[~me])          # opponents only, all folds
    rows = json.loads(moves.to_json(orient="records", double_precision=15))
    fixture = {
        "rows": rows,
        "folds": fold.tolist(),
        "features": X.columns.tolist(),
        "full_fit_proba": full.predict_proba(X)[:, 1].tolist(),
        "risk": model.player_risk(moves, model="logreg"),
        "games": [{"url": g.url, "color": g.color, "myRating": g.my_rating, "oppRating": g.opp_rating,
                   "score": g.score, "timeClass": g.time_class, "timeControl": g.time_control,
                   "eco": g.eco, "opening": g.opening, "family": g.family, "endTime": g.end_time,
                   "result": g.result, "oppResult": g.opp_result,
                   "moves": g.moves_san, "pgn": ""} for g in games],
        "opening_eval": {a["url"]: a["opening_eval"] for a in analyses},
    }
    write_facts(fixture, games, analyses)

    # search: summaries, BM25 scores, embeddings and hybrid rankings
    from chesscheck.search import GameIndex, embedder
    idx = GameIndex.build(games, analyses)
    queries = ["ran out of clock and got flagged", "threw away a completely winning game",
               "my king got mated", "games that ended in a draw"]
    fixture["search"] = {
        "summaries": idx.texts,
        "queries": queries,
        "bm25": [idx.scores(q, "bm25").tolist() for q in queries],
        "doc_vectors": idx.vectors.round(7).tolist(),
        "query_vectors": embedder().encode(queries, normalize_embeddings=True).round(7).tolist(),
        "hybrid_top5": [[i for i, _ in idx.search(q, 5, "hybrid")] for q in queries],
        "embed_top5": [[i for i, _ in idx.search(q, 5, "embed")] for q in queries],
    }
    out.write_text(json.dumps(fixture))
    print(f"wrote {out.relative_to(ROOT)}: {len(rows)} moves from {len(games)} games, "
          f"{int(y.sum())} blunders, {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
