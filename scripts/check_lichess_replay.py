#!/usr/bin/env python3
"""Compare Rust and python-chess boards across the full month's Lichess archive."""
import argparse
from datetime import datetime, timezone
from itertools import groupby
import json
import os
from pathlib import Path
import subprocess
import sys

import chess.pgn
import duckdb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from chesscheck.lichess_dataset import register_views


def check(archive, ingested, count):
    strata = min(10, count)
    with duckdb.connect() as con:
        con.execute("SET memory_limit = '8GB'; SET max_temp_directory_size = '0B'")
        register_views(con, ingested)
        chosen = con.execute("""
            WITH ordered AS (
                SELECT game_id, start_ts,
                       ntile(?) OVER (ORDER BY start_ts, shard, game_id) AS stratum
                FROM lichess_games WHERE position_sampled
            )
            SELECT game_id, start_ts, stratum FROM ordered
            QUALIFY row_number() OVER (
                PARTITION BY stratum ORDER BY hash(game_id, 'replay'), game_id
            ) <= ? + (stratum <= ?)::INTEGER
        """, [strata, count // strata, count % strata]).fetchall()
        ids = [game_id for game_id, _, _ in chosen]
        rows = con.execute("""
            SELECT game_id, ply, fen FROM lichess_positions
            WHERE game_id IN (SELECT unnest(?::VARCHAR[]))
            ORDER BY game_id, ply
        """, [ids]).fetchall()
    expected = {game_id: [(ply, fen) for _, ply, fen in positions]
                for game_id, positions in groupby(rows, key=lambda row: row[0])}
    if len(chosen) != count or len(expected) != count:
        raise ValueError(f"Found {len(expected)} sampled games, expected {count}")

    default = ROOT / "tools/lichess-ingest/target/release/lichess-ingest"
    binary = Path(os.environ.get("LICHESS_INGEST_BIN", str(default))).with_name("lichess-replay-pgn")
    with subprocess.Popen([str(binary), "--input", str(archive)], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, text=True, encoding="utf-8") as pg:
        try:
            pg.stdin.write("\n".join(ids) + "\n")
            pg.stdin.close()
            while (game := chess.pgn.read_game(pg.stdout)) is not None:
                game_id = game.headers.get("GameId") or game.headers["Site"].rsplit("/", 1)[-1]
                if game.errors:
                    raise ValueError(f"{game_id} has PGN errors: {game.errors}")
                board = game.board()
                actual = [(0, board.fen())]
                for ply, move in enumerate(game.mainline_moves(), 1):
                    board.push(move)
                    actual.append((ply, board.fen()))
                if actual != expected.pop(game_id):
                    raise ValueError(f"{game_id}: Rust and python-chess replay differ")
            if pg.wait() != 0:
                raise ValueError("The PGN extractor failed")
        finally:
            if pg.poll() is None:
                pg.terminate()
    if expected:
        raise ValueError(f"PGN ended with {len(expected)} sampled games missing")
    timestamps = [timestamp for _, timestamp, _ in chosen if timestamp is not None]
    dates = sorted({datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat() for ts in timestamps})
    return {"games": count, "boards": len(rows), "strata": strata, "utc_dates": dates}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("ingested", type=Path)
    parser.add_argument("--games", type=int, default=1_000)
    args = parser.parse_args()
    if args.games < 1:
        parser.error("--games must be positive")
    print(json.dumps(check(args.archive, args.ingested, args.games)), flush=True)


if __name__ == "__main__":
    main()
