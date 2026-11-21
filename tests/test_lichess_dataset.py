import os
from pathlib import Path
import shutil
import subprocess

import duckdb
import pytest

from chesscheck.lichess_dataset import register_views
from scripts.check_lichess_replay import check


PGN = """[Site "https://lichess.org/01234567"]
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
    assert check(*ingested, count=1) == 5


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
