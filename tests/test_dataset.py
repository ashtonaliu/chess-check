"""Feature tests using stored engine evaluations. No engine process is needed."""
import io
import os
from collections import Counter, defaultdict
from pathlib import Path

import chess.pgn
import duckdb
import pytest

from chesscheck.dataset import EngineDataset
from chesscheck.engine import BLUNDER_DROP, phase, win_pct
from chesscheck.fetch import DRAW_RESULTS

SAMPLE_ROOT = Path(__file__).resolve().parent / "fixtures" / "engine-v1"
SAMPLE_SHARDS = ("part-00000.parquet", "part-00001.parquet")


def records(relation):
    return [dict(zip(relation.columns, row)) for row in relation.fetchall()]


@pytest.fixture(scope="module")
def stored_sample(tmp_path_factory):
    source = Path(os.environ.get("CHESSCHECK_TEST_DATASET", SAMPLE_ROOT))
    # Use only the original two batches, even when pointed at a live dataset.
    sample = tmp_path_factory.mktemp("engine-sample")
    for table in ("games", "positions"):
        folder = sample / table
        folder.mkdir()
        for name in SAMPLE_SHARDS:
            (folder / name).symlink_to((source / table / name).resolve(strict=True))
        (folder / "part-99999.parquet.tmp").touch()
    # A valid positions shard without a games completion marker must be ignored.
    (sample / "positions" / "part-99998.parquet").symlink_to(
        (source / "positions" / SAMPLE_SHARDS[0]).resolve()
    )
    return sample


def mover_cp(row, side, *, prefix=""):
    if prefix != "second_" and row["terminal"]:
        if row["terminal"] == "checkmate":
            return -3000 if row["mover"] == side else 3000
        return 0
    mate = row[f"{prefix}mate"]
    cp = row[f"{prefix}cp"]
    value = (3000 if mate > 0 else -3000) if mate is not None else cp
    return value if value is None or side == "white" else -value


def test_stored_features_against_pgn_and_evals(stored_sample):
    with duckdb.connect(config={"threads": 1}) as connection:
        games = records(connection.read_parquet(str(stored_sample / "games" / "part-*.parquet")))
        positions = defaultdict(list)
        query = """SELECT * FROM read_parquet(?, union_by_name=true) ORDER BY game_id, ply"""
        for row in records(connection.sql(query, params=[[str(stored_sample / "positions" / name)
                                                         for name in SAMPLE_SHARDS]])):
            positions[row["game_id"]].append(row)
    assert len(games) == 50
    cutoff = max(game["end_ts"] for game in games) + 1
    with EngineDataset(stored_sample) as dataset:
        entries = records(dataset.player_games(None, cutoff))
        assert len(entries) == 100
        features = {(row["game_id"], row["color"]): row for row in entries}
        profiles = {(row["player"], row["time_class"]): row
                    for row in records(dataset.player_features(None, cutoff))}

    support = Counter()
    for game in games:
        metrics = defaultdict(lambda: defaultdict(list))
        counts = defaultdict(Counter)
        extremes = defaultdict(list)
        pg = chess.pgn.read_game(io.StringIO(game["pgn"]))
        base = game["base_seconds"]
        clock = {"white": base, "black": base}
        board = pg.board()
        rows = positions[game["game_id"]]
        for ply, move in enumerate(pg.mainline_moves()):
            before, after = rows[ply:ply + 2]
            side = "white" if board.turn else "black"
            assert (before["mover"], before["move_uci"]) == (side, move.uci())
            a, b = mover_cp(before, side), mover_cp(after, side)
            second = mover_cp(before, side, prefix="second_")
            drop = win_pct(a) - win_pct(b)
            loss = max(drop, 0)
            m = metrics[side]
            m["win_pct_loss"].append(loss)
            m[f"{phase(board, ply)}_win_pct_loss"].append(loss)
            extremes[side].extend((a, b))
            if before["second_uci"] is not None:
                band = "critical" if win_pct(a) - win_pct(second) >= 20 else "easy"
                m[f"{band}_best_move_rate"].append(move.uci() == before["best_uci"])
                spent = before["time_spent"]
                if spent is not None and spent >= 0:
                    m[f"{band}_time_spent"].append(spent)
            if clock[side] is not None and clock[side] < 0.10 * base:
                m["low_clock_win_pct_loss"].append(loss)
            clock[side] = before["clock_after"]
            m["depth10_blunder_rate"].append(drop >= BLUNDER_DROP)
            if drop >= BLUNDER_DROP:
                deep_a = mover_cp(before, side, prefix="deep_")
                deep_b = mover_cp(after, side, prefix="deep_")
                if deep_a is None or deep_b is None:
                    counts[side]["unchecked_blunders"] += 1
                else:
                    confirmed = win_pct(deep_a) - win_pct(deep_b) >= BLUNDER_DROP
                    m["confirmed_blunder_rate"].append(confirmed)
                    counts[side]["confirmed_blunders" if confirmed else "shallow_only_blunders"] += 1
            board.push(move)
        for side in ("white", "black"):
            row = features[game["game_id"], side]
            m = metrics[side]
            won = game[f"{side}_result"] == "win"
            drawn = game[f"{side}_result"] in DRAW_RESULTS
            values = extremes[side]
            if values and max(values) >= 300:
                m["conversion"].append(won)
            if values and min(values) <= -300:
                m["resilience"].append(won or drawn)
            for feature, expected in m.items():
                assert row[f"{feature}_n"] == len(expected)
                assert row[feature] == pytest.approx(sum(expected) / len(expected))
                support[feature] += len(expected)
            for count in ("confirmed_blunders", "shallow_only_blunders", "unchecked_blunders"):
                assert row[count] == counts[side][count]
                support[count] += row[count]
            assert row["depth10_blunders"] == sum(m["depth10_blunder_rate"])

    for feature in ("opening_win_pct_loss", "middlegame_win_pct_loss", "endgame_win_pct_loss",
                    "critical_best_move_rate", "easy_best_move_rate", "low_clock_win_pct_loss",
                    "confirmed_blunders", "shallow_only_blunders", "conversion", "resilience"):
        assert support[feature] > 0
    for key, profile in profiles.items():
        rows = [r for r in entries if (r["player"], r["time_class"]) == key]
        assert profile["games"] == len(rows)
        for field in support:
            if field.endswith("_blunders"):
                assert profile[field] == sum(row[field] for row in rows)
                continue
            weight = sum(row[f"{field}_n"] for row in rows)
            assert profile[f"{field}_n"] == weight
            if weight:
                total = sum(row[field] * row[f"{field}_n"] for row in rows if row[f"{field}_n"])
                assert profile[field] == pytest.approx(total / weight)
            else:
                assert profile[field] is None


def test_strict_cutoffs_and_previous_rating(stored_sample):
    with EngineDataset(stored_sample) as dataset:
        games = records(dataset.connection.sql(
            "SELECT game_id, start_ts, end_ts, lower(white) AS white, lower(black) AS black, "
            "white_rating_after, black_rating_after FROM _dataset_games"
        ))
        cutoff = max(game["end_ts"] for game in games) + 1
        rows = records(dataset.player_games(None, cutoff))
        previous_found = 0
        for row in rows:
            prior = [(game["end_ts"], game["game_id"], game[f"{color}_rating_after"])
                     for game in games for color in ("white", "black")
                     if game[color] == row["player"] and 0 < game["end_ts"] < row["start_ts"]]
            expected = max(prior) if prior else (None, None, None)
            assert (row["previous_game_id"], row["pregame_rating"]) == expected[1:]
            previous_found += bool(prior)
        assert previous_found
        player = max(rows, key=lambda row: row["end_ts"])["player"].upper()
        player_rows = records(dataset.player_games(player, cutoff))
        latest = max(player_rows, key=lambda row: row["end_ts"])
        boundary = latest["end_ts"]
        before = records(dataset.player_games(player, boundary))
        assert all(row["end_ts"] < boundary for row in before)
        assert len(before) < len(player_rows)
        rating = dataset.pregame_rating(player, boundary)
        earlier = [(game["end_ts"], game["game_id"], game[f"{color}_rating_after"])
                   for game in games for color in ("white", "black")
                   if game[color] == player.lower() and 0 < game["end_ts"] < boundary]
        assert rating == (max(earlier)[-1] if earlier else None)
        summaries = records(dataset.player_features(player, boundary))
        if before:
            assert summaries[0]["games"] == len(before)
            assert summaries[0]["pregame_rating"] == rating
        else:
            assert summaries == []
