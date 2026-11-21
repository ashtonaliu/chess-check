#!/usr/bin/env python3
"""Measure evaluation coverage and write find-rate rows from the cached Lichess table."""
import argparse
import fcntl
import io
import json
from pathlib import Path
import sys
import tempfile
import time

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chesscheck.dataset import CRITICAL_GAP, _literal
from chesscheck.engine import OPENING_PLIES, PIECE_VALUES
from chesscheck.lichess_dataset import register_views
from scripts.lichess_data import LICHESS, LIMIT, OCTOBER, data_bytes


def moves_with_metadata(positions):
    material = " + ".join(
        f"{PIECE_VALUES[piece]} * (length(placement) - length(translate(placement, '{letters}', '')))"
        for piece, letters in enumerate(("Nn", "Bb", "Rr", "Qq"), 2)
    )
    return f"""
        WITH scored AS (
            SELECT p.* EXCLUDE (placement),
                   CASE WHEN p.ply < {OPENING_PLIES} THEN 'opening'
                        WHEN {material} <= 26 THEN 'endgame' ELSE 'middlegame' END AS phase,
                   g.time_class, g.base_seconds, g.increment_seconds,
                   lower(CASE WHEN p.mover = 'white' THEN g.white ELSE g.black END) AS player,
                   CASE WHEN p.mover = 'white' THEN g.white_rating_before
                        ELSE g.black_rating_before END AS pregame_rating,
                   p.clock_after::BIGINT + p.time_spent - g.increment_seconds AS clock_before
            FROM {positions} p
            JOIN (SELECT * FROM lichess_games WHERE position_sampled) g USING (shard, game_id)
        )
        SELECT *,
               floor(pregame_rating / 200)::INTEGER * 200 AS rating_band,
               CASE WHEN clock_before IS NOT NULL AND base_seconds > 0
                    THEN least(1.5, greatest(0, clock_before::DOUBLE / base_seconds)) END AS clock_frac
        FROM scored
    """


def register_labels(con, games, evals):
    register_views(con, games)
    con.execute(f"""
        CREATE TEMP MACRO lichess_wp(cp, mate, mover) AS
            100.0 / (1.0 + exp(-0.00368208 *
                coalesce(CASE WHEN mate > 0 THEN 3000 WHEN mate < 0 THEN -3000 END, cp) *
                CASE WHEN mover = 'white' THEN 1 ELSE -1 END));

        CREATE TEMP VIEW lichess_move_rows AS
        SELECT p.shard, p.game_id, p.ply, p.fen, p.mover, p.move_uci,
               p.clock_after, p.time_spent, p.source,
               split_part(p.fen, ' ', 1) AS placement,
               regexp_extract(p.fen, '^([^ ]+ [^ ]+ [^ ]+ [^ ]+)', 1) AS fen_key
        FROM lichess_positions p WHERE p.move_uci IS NOT NULL;

        CREATE TEMP VIEW lichess_moves AS {moves_with_metadata('lichess_move_rows')};

        CREATE TEMP VIEW lichess_eval_scores AS
        WITH with_mover AS (
            SELECT *, CASE WHEN split_part(fen, ' ', 2) = 'w' THEN 'white' ELSE 'black' END AS mover
            FROM read_parquet({_literal(str(evals / 'part-*.parquet'))})
        ), scores AS (
            SELECT fen, best_uci, second_uci, depth, knodes,
                   lichess_wp(cp, mate, mover) AS best_wp,
                   lichess_wp(second_cp, second_mate, mover) AS second_wp
            FROM with_mover
        )
        SELECT *, best_wp - second_wp AS gap FROM scores;

        CREATE TEMP VIEW lichess_scored AS
        SELECT p.* EXCLUDE (fen_key), e.* EXCLUDE (fen)
        FROM lichess_moves p LEFT JOIN lichess_eval_scores e ON e.fen = p.fen_key
    """)


COVERAGE = f"""
    SELECT ply, phase, time_class, rating_band,
           grouping(ply, phase, time_class, rating_band) AS grouping_mask,
           count(*) AS positions, count(best_uci) AS matched,
           count(best_uci)::DOUBLE / nullif(count(*), 0) AS coverage,
           count(*) FILTER (WHERE gap >= {CRITICAL_GAP}) AS critical_rows
    FROM lichess_scored
    GROUP BY GROUPING SETS ((), (ply), (phase), (time_class, rating_band))
    ORDER BY grouping_mask DESC, ply, phase, time_class, rating_band
"""


def query_rows(con, sql):
    cursor = con.execute(sql)
    columns = [column[0] for column in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


class BudgetedWriter(io.BufferedWriter):
    """Bound the Parquet file without limiting DuckDB's separate spill files."""

    def __init__(self, raw, budget):
        super().__init__(raw)
        self.budget = budget

    def write(self, data):
        if self.tell() + len(data) > self.budget:
            raise OSError("The training table would exceed its byte budget")
        return super().write(data)


def write_training(con, output, budget):
    from pyarrow.parquet import ParquetWriter

    # Materialize the filtered build side and match moves before looking up player metadata.
    con.execute(f"""
        CREATE TEMP TABLE lichess_critical_evals AS
        SELECT * FROM lichess_eval_scores WHERE gap >= {CRITICAL_GAP};

        CREATE TEMP TABLE lichess_critical_moves AS
        SELECT p.*, e.* EXCLUDE (fen)
        FROM lichess_move_rows p JOIN lichess_critical_evals e ON e.fen = p.fen_key
        WHERE p.ply >= 2;

        DROP TABLE lichess_critical_evals;
    """)
    training = con.sql(f"""
        SELECT * EXCLUDE (fen_key), move_uci = best_uci AS found, 'lichess_cloud' AS evaluation_source
        FROM ({moves_with_metadata('lichess_critical_moves')})
        WHERE pregame_rating IS NOT NULL AND player IS NOT NULL
    """)
    arrow_reader = getattr(training, "to_arrow_reader", training.fetch_record_batch)
    with arrow_reader(65_536) as batches, BudgetedWriter(output.open("wb", buffering=0), budget) as sink:
        with ParquetWriter(sink, batches.schema, compression="zstd") as writer:
            for batch in batches:
                writer.write_batch(batch)


def build(month):
    games = LICHESS / month
    evals = LICHESS / "evaluations"
    destination = LICHESS / f"{month}-labels"
    if destination.exists():
        raise FileExistsError(destination)
    games_run = json.loads((games / "run.json").read_text())
    evals_run = json.loads((evals / "run.json").read_text())
    started = time.perf_counter()
    available = LIMIT - data_bytes() - 1_000_000
    if available <= 0:
        raise ValueError("No disk space remains within the data budget")
    with tempfile.TemporaryDirectory(prefix=".labels-", dir=LICHESS) as working:
        root = Path(working)
        labels = root / "labels"
        labels.mkdir()
        output = labels / "training.parquet"
        output_budget = min(8_000_000_000, available // 5)
        scratch = available - output_budget
        with duckdb.connect() as con:
            con.execute("SET memory_limit = '16GB'")
            con.execute("SET threads = 8")
            con.execute("SET preserve_insertion_order = false")
            con.execute(f"SET temp_directory = {_literal(str(root / 'spill'))}")
            con.execute(f"SET max_temp_directory_size = '{scratch}B'")
            register_labels(con, games, evals)
            coverage = query_rows(con, COVERAGE)
            print(f"Measured coverage on {coverage[0]['positions']:,} played moves", file=sys.stderr)
            write_training(con, output, output_budget)
            con.execute(f"CREATE TEMP VIEW training AS SELECT * FROM read_parquet({_literal(str(output))})")
            summary = query_rows(con, """
                SELECT source, time_class, rating_band,
                       grouping(source, time_class, rating_band) AS grouping_mask,
                       count(*) AS rows, count(DISTINCT player) AS players
                FROM training
                GROUP BY GROUPING SETS ((), (source), (time_class), (rating_band),
                                        (source, time_class, rating_band))
                ORDER BY grouping_mask DESC, source, time_class, rating_band
            """)
        report = {"month": month, "position_mod": games_run["projection"]["position_mod"],
                  "evaluations": evals_run["source"], "training_bytes": output.stat().st_size,
                  "seconds": time.perf_counter() - started, "coverage": coverage, "training": summary}
        (labels / "run.json").write_text(json.dumps(report, indent=2) + "\n")
        labels.rename(destination)
    print(json.dumps({"seconds": report["seconds"], "overall_coverage": coverage[0],
                      "overall_training": summary[0], "report": str(destination / "run.json")}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--month", default=OCTOBER)
    args = parser.parse_args()
    if len(args.month) != 7 or args.month[4] != "-" or not (args.month[:4] + args.month[5:]).isdigit():
        parser.error("month must use YYYY-MM")
    with (LICHESS / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        build(args.month)


if __name__ == "__main__":
    main()
