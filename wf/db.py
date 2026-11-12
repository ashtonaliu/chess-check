"""DuckDB storage and SQL.

Two tables: `games` (one row per game, from the user's side) and `moves`
(one row per ply, both players, with engine + engineered features). The SQL
is standard and runs unchanged on BigQuery apart from the table names.
"""
from __future__ import annotations

import duckdb
import pandas as pd

OPENING_SQL = """
SELECT color, family,
       COUNT(*)               AS n,
       AVG(score)             AS score,
       AVG(expected)          AS expected,
       AVG(score - expected)  AS mean_resid
FROM games
GROUP BY color, family
HAVING COUNT(*) >= ?
ORDER BY mean_resid
"""

SCHEMA_DOC = """\
games(url, color, my_rating, opp_rating, score, expected, residual,
      time_class, eco, opening, family, end_time, moves)
  -- one row per game; score is 1/0.5/0 for the user; expected is the Elo
  -- expected score; residual = score - expected; family e.g. 'Sicilian Defense'
moves(url, ply, move_no, san, best, mover, is_me, phase, cp_before, cp_after,
      wp_loss, clock, clock_frac, time_spent, legal_moves, in_check,
      captures_available, material_balance, non_pawn_material, is_capture)
  -- one row per ply for BOTH players; wp_loss = win% lost by the move (0-100);
  -- blunder = wp_loss >= 20; phase in ('opening','middlegame','endgame');
  -- clock = seconds left before the move; cp_* are from the mover's view
"""


def moves_frame(analyses: list[dict]) -> pd.DataFrame:
    rows = [dict(m, url=a["url"]) for a in analyses for m in a["moves"]]
    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.drop(columns=["fen"], errors="ignore")
    return df


def connect(games: pd.DataFrame, moves: pd.DataFrame | None = None,
            path: str = ":memory:") -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(path)
    con.register("games_df", games)
    con.execute("CREATE OR REPLACE TABLE games AS SELECT * FROM games_df")
    con.unregister("games_df")
    if moves is not None and not moves.empty:
        con.register("moves_df", moves)
        con.execute("CREATE OR REPLACE TABLE moves AS SELECT * FROM moves_df")
        con.unregister("moves_df")
    return con


def opening_groups(games: pd.DataFrame, min_games: int = 3) -> pd.DataFrame:
    con = connect(games)
    try:
        return con.execute(OPENING_SQL, [min_games]).df()
    finally:
        con.close()


class ReadOnlySQL:
    """SQL tool for the agent: in-memory copy, no file or network access."""

    MAX_ROWS = 50
    dialect = "DuckDB"

    def __init__(self, games: pd.DataFrame, moves: pd.DataFrame | None):
        self.con = connect(games, moves)
        self.con.execute("SET enable_external_access = false")
        self.con.execute("SET lock_configuration = true")

    def run(self, sql: str) -> str:
        head = sql.strip().lstrip("(").split(None, 1)[0].upper() if sql.strip() else ""
        if head not in ("SELECT", "WITH"):
            return "Error: only SELECT/WITH queries are allowed."
        try:
            df = self.con.execute(sql).df()
        except Exception as e:  # report SQL errors back to the model
            return f"SQL error: {e}"
        more = len(df) > self.MAX_ROWS
        out = df.head(self.MAX_ROWS).round(3).to_csv(index=False)
        return out + (f"... ({len(df)} rows total, first {self.MAX_ROWS} shown)\n"
                      if more else "")

    def close(self):
        self.con.close()
