#!/usr/bin/env python3
"""Time the Stockfish fallback and audit cloud coverage on new Lichess positions."""
import fcntl
import hashlib
import json
import math
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import time

import chess
import chess.engine
import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chesscheck.dataset import CRITICAL_GAP, _literal
from chesscheck.engine import find_stockfish, win_pct
from chesscheck.lichess_dataset import register_views
from scripts.lichess_data import DATA, LICHESS, LIMIT, OCTOBER, data_bytes

WORKERS = 17
TARGET = 20_000


def sample_positions():
    with duckdb.connect() as con:
        con.execute("SET memory_limit = '8GB'")
        con.execute("SET max_temp_directory_size = '0B'")
        register_views(con, LICHESS / OCTOBER)
        con.execute("""
            CREATE TEMP TABLE audit_games AS
            SELECT shard, game_id, time_class FROM lichess_games WHERE position_sampled
            QUALIFY row_number() OVER (
                PARTITION BY time_class ORDER BY hash(game_id, 'stockfish-audit'), game_id
            ) <= 500;

            CREATE TEMP TABLE audit_moves AS
            SELECT g.time_class, p.game_id, p.ply, p.fen,
                   regexp_extract(p.fen, '^([^ ]+ [^ ]+ [^ ]+ [^ ]+)', 1) AS fen_key
            FROM lichess_positions p JOIN audit_games g USING (shard, game_id)
            WHERE p.ply >= 2 AND p.move_uci IS NOT NULL
            QUALIFY row_number() OVER (
                PARTITION BY g.time_class ORDER BY hash(p.game_id, p.ply, 'stockfish-audit'), p.game_id, p.ply
            ) <= 200;
        """)
        evals = _literal(str(LICHESS / "evaluations" / "part-*.parquet"))
        return con.execute(f"""
            WITH present AS (
                SELECT e.fen FROM read_parquet({evals}) e
                SEMI JOIN audit_moves p ON e.fen = p.fen_key
            )
            SELECT p.time_class, p.fen, e.fen IS NOT NULL AS joined
            FROM audit_moves p LEFT JOIN present e ON e.fen = p.fen_key
            ORDER BY p.time_class, p.game_id, p.ply
        """).fetchall()


def analyze(rows, binary, settings):
    def chance(score, mover):
        score = score.pov(mover)
        if score.is_mate():
            return win_pct(3000 if score.mate() > 0 else -3000)
        return win_pct(score.score())

    with chess.engine.SimpleEngine.popen_uci(binary) as engine:
        engine.configure({"Threads": settings["threads"], "Hash": settings["hash_mb"],
                          "UCI_ShowWDL": settings["wdl"]})
        depth = chess.engine.Limit(depth=settings["depth"])
        results = []
        for speed, fen, joined in rows:
            board = chess.Board(fen)
            lines = engine.analyse(board, depth, multipv=settings["multipv"], game=object())
            critical = len(lines) >= 2 and (
                chance(lines[0]["score"], board.turn) - chance(lines[1]["score"], board.turn) >= CRITICAL_GAP
            )
            results.append((speed, joined, critical))
        return results


def run():
    label_dir = LICHESS / f"{OCTOBER}-labels"
    label_report = json.loads((label_dir / "run.json").read_text())
    output = label_dir / "stockfish-pilot.json"
    if output.exists():
        raise FileExistsError(output)
    if data_bytes() + 1_000_000 > LIMIT:
        raise ValueError("No space remains for the pilot report")
    settings = json.loads((DATA / "engine" / "v1" / "runs.json").read_text())
    binary = find_stockfish()
    if not binary:
        raise ValueError("Stockfish 19 is required for the pilot")
    with open(binary, "rb") as handle:
        fingerprint = hashlib.file_digest(handle, "sha256").hexdigest()
    if fingerprint != settings["binary_sha256"]:
        raise ValueError("The Stockfish binary differs from the one recorded for v1")
    rows = sample_positions()
    if len(rows) != 1000:
        raise ValueError(f"Expected 1,000 pilot positions, got {len(rows):,}")

    started = time.perf_counter()
    with ThreadPoolExecutor(WORKERS) as pool:
        jobs = [pool.submit(analyze, rows[index::WORKERS], binary, settings) for index in range(WORKERS)]
        results = [result for job in jobs for result in job.result()]
    seconds = time.perf_counter() - started
    cloud_rows = {r["time_class"]: r["rows"] for r in label_report["training"] if r["grouping_mask"] == 5}
    by_speed = {}
    for speed in sorted(cloud_rows):
        group = [(joined, critical) for key, joined, critical in results if key == speed]
        yes = sum(critical for _, critical in group)
        covered = sum(joined and critical for joined, critical in group)
        missing = yes - covered
        deficit = max(0, TARGET - cloud_rows[speed])
        projected = math.ceil(deficit * len(group) / missing) if missing else None
        by_speed[speed] = {"positions": len(group), "reference_critical": yes,
                           "covered_critical": covered, "row_deficit": deficit,
                           "projected_positions": projected,
                           "projected_seconds": projected * seconds / len(results) if projected is not None else None}
    report = {"positions": len(results), "seconds": seconds, "workers": WORKERS,
              "engine": {key: settings[key] for key in ("engine", "binary_sha256", "network", "depth",
                                                        "multipv", "hash_mb", "threads", "wdl")},
              "by_speed": by_speed}
    staged = output.with_suffix(".json.tmp")
    staged.write_text(json.dumps(report, indent=2) + "\n")
    staged.rename(output)
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    with (LICHESS / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run()
