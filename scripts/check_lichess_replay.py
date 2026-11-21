#!/usr/bin/env python3
"""Check all board FENs, including the final board, for sampled Lichess games."""
import argparse
from itertools import groupby
from pathlib import Path
import subprocess
import sys

import chess.pgn
import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chesscheck.lichess_dataset import register_views


def check(archive, ingested, count):
    with duckdb.connect() as con:
        register_views(con, ingested)
        rows = con.execute("""
            WITH chosen AS (
                SELECT DISTINCT game_id
                FROM lichess_games WHERE position_sampled
                ORDER BY hash(game_id), game_id LIMIT ?
            )
            SELECT game_id, ply, fen FROM lichess_positions
            SEMI JOIN chosen USING (game_id)
            ORDER BY game_id, ply
        """, [count]).fetchall()
    expected = {game_id: [(ply, fen) for _, ply, fen in positions]
                for game_id, positions in groupby(rows, key=lambda row: row[0])}
    if len(expected) != count:
        raise ValueError(f"Found {len(expected)} sampled games, expected {count}")

    class SelectedGames(chess.pgn.GameBuilder):
        def end_headers(self):
            headers = self.game.headers
            self.game_id = headers.get("GameId") or headers["Site"].rsplit("/", 1)[-1]
            if self.game_id not in expected:
                return chess.pgn.SKIP

        def result(self):
            if self.game_id in expected:
                return self.game_id, self.game
            return False

    with subprocess.Popen(["zstd", "-dc", str(archive)], stdout=subprocess.PIPE, text=True) as pg:
        try:
            while expected and (result := chess.pgn.read_game(pg.stdout, Visitor=SelectedGames)) is not None:
                if result:
                    game_id, game = result
                    if game.errors:
                        raise ValueError(f"{game_id} has PGN errors: {game.errors}")
                    board = game.board()
                    actual = [(0, board.fen())]
                    for ply, move in enumerate(game.mainline_moves(), 1):
                        board.push(move)
                        actual.append((ply, board.fen()))
                    if actual != expected.pop(game_id):
                        raise ValueError(f"{game_id}: Rust and python-chess replay differ")
        finally:
            if pg.poll() is None:
                pg.terminate()
    if expected:
        raise ValueError(f"PGN ended with {len(expected)} sampled games missing")
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("ingested", type=Path)
    parser.add_argument("--games", type=int, default=1_000)
    args = parser.parse_args()
    if args.games < 1:
        parser.error("--games must be positive")
    positions = check(args.archive, args.ingested, args.games)
    print(f"Compared {positions:,} board FENs from {args.games:,} games")


if __name__ == "__main__":
    main()
