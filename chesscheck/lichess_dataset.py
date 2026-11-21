"""Read completed Rust ingest shards without copying or materializing them."""
from pathlib import Path

import duckdb

from .dataset import _literal, _parquet


def register_views(connection: duckdb.DuckDBPyConnection, root: str | Path) -> None:
    """Register one month's game and position views on this connection."""
    root = Path(root).resolve()
    game_shards = _literal(str(root / "games" / "part-*.parquet"))
    connection.execute(f"""
        CREATE OR REPLACE TEMP VIEW lichess_games AS
        SELECT * EXCLUDE (_dataset_file), parse_filename(_dataset_file) AS shard
        FROM {_parquet(root, "games")};

        CREATE OR REPLACE TEMP VIEW lichess_positions AS
        SELECT p.* EXCLUDE (_dataset_file), parse_filename(p._dataset_file) AS shard
        FROM {_parquet(root, "positions")} p
        WHERE parse_filename(p._dataset_file) IN (
            SELECT parse_filename(file) FROM glob({game_shards})
        );
    """)
