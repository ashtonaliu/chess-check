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
