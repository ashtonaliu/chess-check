import os
from pathlib import Path
import shutil
import subprocess

import duckdb
import pytest

from chesscheck.lichess_dataset import register_views
from scripts.check_lichess_replay import check


PGN = """[Site "https://lichess.org/game/01234567"]
[White "ExampleWhite"]
[Black "ExampleBlack"]
[WhiteElo "1701"]
[BlackElo "1733"]
[UTCDate "2026.10.01"]
[UTCTime "00:00:00"]
[TimeControl "480+0"]
[Result "1-0"]

1. e4 { [%clk 0:08:00] [%eval 0.35] } e5 { [%clk 0:08:00] }
2. Nf3 { [%clk 0:07:55] } Nc6 { [%clk 0:07:53] } 1-0

[Site "https://lichess.org/01234568"]
[WhiteTitle "BOT"]
[TimeControl "180+0"]
[Result "0-1"]

1. e4 { [%clk 0:03:00] } e5 { [%clk 0:03:00] } 0-1
"""


@pytest.fixture
def ingested(tmp_path):
    default = Path(__file__).resolve().parents[1] / "tools/lichess-ingest/target/release/lichess-ingest"
    binary = Path(os.environ.get("LICHESS_INGEST_BIN", str(default)))
    if not binary.is_file():
        pytest.skip("build the Rust release binary to generate the test fixture")
    archive = tmp_path / "fixture.pgn.zst"
    subprocess.run(["zstd", "-q", "-o", str(archive)], input=PGN.encode(), check=True)
    output = tmp_path / "dataset"
    subprocess.run([str(binary), "--input", str(archive), "--output", str(output),
                    "--position-mod", "1", "--byte-budget", "1000000"], check=True)
    return archive, output


def test_reads_completed_shards_only(ingested):
    _, root = ingested
    original = root / "positions" / "part-00000.parquet"
    shutil.copyfile(original, root / "positions" / "part-00001.parquet")
    (root / "games" / "part-00001.parquet.tmp").write_bytes(b"partial")
    with duckdb.connect() as con:
        register_views(con, root)
        assert con.execute("""
            SELECT game_id, time_class, white_rating_before, exclusion, position_sampled, source
            FROM lichess_games ORDER BY game_id
        """).fetchall() == [
            ("01234567", "rapid", 1701, None, True, "lichess"),
            ("01234568", "blitz", None, "bot", False, "lichess"),
        ]
        assert con.execute("""
            SELECT ply, move_uci, clock_after, time_spent, eval_cp
            FROM lichess_positions ORDER BY ply
        """).fetchall() == [
            (0, "e2e4", 480, None, 35), (1, "e7e5", 480, None, None),
            (2, "g1f3", 475, 5, None), (3, "b8c6", 473, 7, None),
            (4, None, None, None, None),
        ]


def test_replay_matches_python_chess(ingested):
    assert check(*ingested, count=1) == {"games": 1, "boards": 5, "strata": 1, "utc_dates": ["2026-10-01"]}


def test_stockfish_sample_uses_distinct_played_moves(ingested, tmp_path, monkeypatch):
    from scripts import stockfish_lichess as stockfish
    import pyarrow.parquet as pq

    _, games = ingested
    monkeypatch.setattr(stockfish, "GAMES", games)
    monkeypatch.setattr(stockfish, "OUT", tmp_path)
    monkeypatch.setattr(stockfish, "data_bytes", lambda: 0)
    sample = tmp_path / "sample.parquet"
    stockfish.write_sample(sample, {"rapid": 3}, {"rapid": 4}, "test")
    first = pq.read_table(sample).to_pylist()
    assert len({row["ply"] for row in first}) == 3
    assert all(row["time_class"] == "rapid" and row["move_uci"] for row in first)
    stockfish.write_sample(sample, {"rapid": 3}, {"rapid": 4}, "test")
    assert pq.read_table(sample).to_pylist() == first


def test_stockfish_resume_keeps_published_shards_and_charges_interrupted_time(tmp_path, monkeypatch):
    from contextlib import nullcontext

    import pyarrow as pa
    import pyarrow.parquet as pq
    from scripts import stockfish_lichess as stockfish

    monkeypatch.setattr(stockfish, "OUT", tmp_path)
    monkeypatch.setattr(stockfish, "data_bytes", lambda: 0)
    plan = {"initial_engine_seconds": 20, "identity": {}, "searches_by_speed": {"rapid": 2}}
    monkeypatch.setattr(stockfish, "make_plan", lambda _: plan)
    monkeypatch.setattr(stockfish, "engines", lambda _: nullcontext())
    pq.write_table(pa.table({"ply": [2, 3]}), tmp_path / "sample.parquet", row_group_size=1)
    seen = []

    def search(_, rows, deadline):
        ply = rows[0]["ply"]
        seen.append(ply)
        if seen == [2, 3]:
            raise RuntimeError("interrupted")
        return pa.Table.from_pylist([{}], schema=stockfish.SCORES)

    monkeypatch.setattr(stockfish, "search_batch", search)
    with pytest.raises(RuntimeError, match="interrupted"):
        stockfish.label({})
    completed = tmp_path / "positions" / "part-00000.parquet"
    before = completed.read_bytes()
    run = stockfish.label({})
    assert seen == [2, 3, 3]
    assert completed.read_bytes() == before
    assert run["spent_seconds"] >= 200
    assert run["inflight"] is None


def test_stockfish_comparison_keeps_the_cloud_out_of_training(tmp_path, monkeypatch):
    import json

    import pyarrow as pa
    import pyarrow.parquet as pq
    from scripts import stockfish_lichess as stockfish

    cloud = tmp_path / "cloud"
    cloud.mkdir()
    (tmp_path / "positions").mkdir()
    monkeypatch.setattr(stockfish, "OUT", tmp_path)
    monkeypatch.setattr(stockfish, "CLOUD", cloud)
    monkeypatch.setattr(stockfish, "data_bytes", lambda: 0)
    sample = pa.table({"phase": ["opening", "middlegame"], "time_class": ["rapid"] * 2,
                       "rating_band": [1600] * 2, "pregame_rating": [1660] * 2,
                       "ply": [6, 30], "player": ["a", "b"]})
    rows = sample.append_column("found", pa.array([True, False]))
    pq.write_table(sample, tmp_path / "sample.parquet")
    pq.write_table(rows, cloud / "training.parquet")
    scored = rows.append_column("gap", pa.array([24.0, 12.0])).append_column("run_id", pa.array(["run"] * 2))
    pq.write_table(scored, tmp_path / "positions" / "part-00000.parquet")
    stockfish.compare({"inflight": None, "sample_sha256": "run", "spent_seconds": 1,
                       "plan": {"searches_by_speed": {"rapid": 2}}})
    assert pq.read_table(tmp_path / "training.parquet").num_rows == 1
    report = json.loads((tmp_path / "comparison.json").read_text())
    assert [(r["label_source"], r["rows"], r["find_rate"]) for r in report["rows"] if r["grouping_mask"] == 7] == [
        ("cloud", 2, 0.5), ("stockfish", 1, 1.0),
    ]
    assert "| All | 1 | 100.00% | 2 | 50.00% |" in (tmp_path / "comparison.md").read_text()


def test_training_file_budget_is_applied_before_writing(tmp_path):
    from scripts.label_lichess import BudgetedWriter

    path = tmp_path / "limited.parquet"
    with BudgetedWriter(path.open("wb", buffering=0), 3) as output:
        output.write(b"ab")
        with pytest.raises(OSError, match="byte budget"):
            output.write(b"cd")
    assert path.read_bytes() == b"ab"


def test_evaluations_are_reused_and_label_the_pre_move_board(ingested, tmp_path, monkeypatch):
    import json

    from scripts import label_lichess, lichess_data

    default = Path(__file__).resolve().parents[1] / "tools/lichess-ingest/target/release/lichess-ingest"
    binary = Path(os.environ.get("LICHESS_INGEST_BIN", str(default)))
    if not binary.with_name("lichess-evals").is_file():
        pytest.skip("build the Rust evaluation binary to generate the test fixture")
    _, games = ingested
    monkeypatch.setattr(lichess_data, "BINARY", binary)
    monkeypatch.setattr(lichess_data, "LICHESS", tmp_path)
    monkeypatch.setattr(lichess_data, "DATA", tmp_path)
    monkeypatch.setattr(label_lichess, "LICHESS", tmp_path)
    downloads = tmp_path / "downloads"
    downloads.mkdir()
    archive = downloads / lichess_data.EVAL_FILE
    board = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq"
    entries = [
        {"fen": f"{board} {ep}", "evals": [
            {"depth": depth, "knodes": 120, "pvs": [{"cp": 400, "line": "g1f3"}, {"cp": 0, "line": "f1c4"}]}
        ]}
        for ep, depth in (("-", 11), ("e6", 15), ("-", 9))
    ]
    subprocess.run(["zstd", "-q", "-o", str(archive)],
                   input="\n".join(map(json.dumps, entries)).encode(), check=True)
    (downloads / "runs.json").write_text(json.dumps({archive.name: {"size": archive.stat().st_size}}))
    lichess_data.convert_evaluations()
    table = tmp_path / "evaluations"
    report = json.loads((table / "run.json").read_text())
    assert (report["records"], report["eligible"], report["rows"]) == (3, 2, 1)
    assert report["parquet_bytes"] == sum(path.stat().st_size for path in table.glob("part-*.parquet"))
    monkeypatch.setattr(lichess_data, "BINARY", tmp_path / "missing-binary")
    lichess_data.convert_evaluations()
    month = "2026-10"
    games = games.rename(tmp_path / month)
    (games / "run.json").write_text(json.dumps({"projection": {"position_mod": 1}}))
    label_lichess.build(month)
    labels = tmp_path / f"{month}-labels"
    report = json.loads((labels / "run.json").read_text())
    overall = report["coverage"][0]
    assert (overall["positions"], overall["matched"], overall["coverage"], overall["critical_rows"]) == (4, 1, 0.25, 1)
    with duckdb.connect() as con:
        assert con.execute("""
            SELECT ply, best_uci, depth, found, pregame_rating FROM read_parquet(?)
        """, [str(labels / "training.parquet")]).fetchall() == [(2, "g1f3", 15, True, 1701)]


def test_lichess_scripts_exit_clearly_when_data_dir_is_missing(tmp_path, monkeypatch):
    import sys

    from scripts import label_lichess, stockfish_lichess

    missing = tmp_path / "lichess"
    monkeypatch.setattr(label_lichess, "LICHESS", missing)
    monkeypatch.setattr(sys, "argv", ["label_lichess.py"])
    with pytest.raises(SystemExit) as err:
        label_lichess.main()
    assert "scripts/lichess_data.py" in str(err.value)
    assert not missing.exists()

    monkeypatch.setattr(stockfish_lichess, "LICHESS", missing)
    monkeypatch.setattr(sys, "argv", ["stockfish_lichess.py", "benchmark"])
    with pytest.raises(SystemExit) as err:
        stockfish_lichess.main()
    assert "scripts/lichess_data.py" in str(err.value)
    assert not missing.exists()
