"""MySQL backend: a persistent store for analyses, and the coach's SQL tool.

Each analysis gets its own schema (wf_<hash>) with `games` and `moves`
tables, so the coach only ever sees the current player's data. Two users:
wf_writer loads data; wf_reader, which the coach's tool connects as, has only
SELECT on wf_% schemas (deploy/mysql/init.sh). The reader session is also set
to read-only transactions with a statement timeout.

DuckDB stays the in-process analytics engine (wf/db.py); this module is
enabled with WF_SQL_BACKEND=mysql plus WF_MYSQL_WRITER_URL / WF_MYSQL_READER_URL.
"""
from __future__ import annotations

import hashlib
import math
import os
from urllib.parse import unquote, urlparse

import pandas as pd
import pymysql

DIALECT = "MySQL 8"
MAX_ROWS = 50
TIMEOUT_MS = 5000

GAMES_DDL = """
CREATE TABLE games (
  url VARCHAR(120) NOT NULL PRIMARY KEY,
  color VARCHAR(5) NOT NULL,
  my_rating INT, opp_rating INT,
  score DOUBLE, expected DOUBLE, residual DOUBLE,
  time_class VARCHAR(10), eco VARCHAR(8),
  opening VARCHAR(255), family VARCHAR(120),
  end_time BIGINT, moves TEXT,
  KEY family_color (family, color)
)"""

MOVES_DDL = """
CREATE TABLE moves (
  url VARCHAR(120) NOT NULL, ply INT NOT NULL,
  move_no INT, san VARCHAR(12), best VARCHAR(12), mover VARCHAR(5),
  is_me BOOLEAN, phase VARCHAR(10),
  cp_before INT, cp_after INT, wp_loss DOUBLE,
  clock DOUBLE NULL, clock_frac DOUBLE NULL, time_spent DOUBLE NULL,
  legal_moves INT, in_check BOOLEAN, captures_available INT,
  material_balance INT, non_pawn_material INT, is_capture BOOLEAN,
  PRIMARY KEY (url, ply),
  KEY phase_me (phase, is_me)
)"""

GAMES_COLS = ["url", "color", "my_rating", "opp_rating", "score", "expected", "residual",
              "time_class", "eco", "opening", "family", "end_time", "moves"]
MOVES_COLS = ["url", "ply", "move_no", "san", "best", "mover", "is_me", "phase", "cp_before",
              "cp_after", "wp_loss", "clock", "clock_frac", "time_spent", "legal_moves", "in_check",
              "captures_available", "material_balance", "non_pawn_material", "is_capture"]


def enabled() -> bool:
    return os.environ.get("WF_SQL_BACKEND", "").lower() == "mysql"


def _connect(url: str, database: str | None = None) -> pymysql.connections.Connection:
    u = urlparse(url)
    return pymysql.connect(host=u.hostname or "127.0.0.1", port=u.port or 3306,
                           user=unquote(u.username or ""), password=unquote(u.password or ""),
                           database=database, charset="utf8mb4", autocommit=True)


def schema_for(games: pd.DataFrame) -> str:
    """Stable schema name for one analysis (same games -> same schema)."""
    key = "|".join(sorted(games.url)) if not games.empty else "empty"
    return "wf_" + hashlib.sha1(key.encode()).hexdigest()[:16]


def _clean(v):
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if hasattr(v, "item"):            # numpy scalar -> Python
        v = v.item()
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
    return v


def load(games: pd.DataFrame, moves: pd.DataFrame | None, writer_url: str | None = None) -> str:
    """Write one analysis into its own schema and return the schema name."""
    schema = schema_for(games)
    conn = _connect(writer_url or os.environ["WF_MYSQL_WRITER_URL"])
    try:
        with conn.cursor() as cur:
            cur.execute(f"CREATE DATABASE IF NOT EXISTS `{schema}`")
            cur.execute(f"USE `{schema}`")
            cur.execute("DROP TABLE IF EXISTS moves")
            cur.execute("DROP TABLE IF EXISTS games")
            cur.execute(GAMES_DDL)
            cur.execute(MOVES_DDL)
            g = games.reindex(columns=GAMES_COLS)
            cur.executemany(
                f"INSERT INTO games ({', '.join(GAMES_COLS)}) VALUES ({', '.join(['%s'] * len(GAMES_COLS))})",
                [tuple(_clean(v) for v in row) for row in g.itertuples(index=False, name=None)])
            if moves is not None and not moves.empty:
                m = moves.reindex(columns=MOVES_COLS)
                rows = [tuple(_clean(v) for v in row) for row in m.itertuples(index=False, name=None)]
                sql = f"INSERT INTO moves ({', '.join(MOVES_COLS)}) VALUES ({', '.join(['%s'] * len(MOVES_COLS))})"
                for i in range(0, len(rows), 2000):
                    cur.executemany(sql, rows[i:i + 2000])
    finally:
        conn.close()
    return schema


class MySQLReadOnlySQL:
    """The coach's SQL tool on MySQL. Same interface as db.ReadOnlySQL."""

    dialect = DIALECT

    def __init__(self, schema: str, reader_url: str | None = None):
        self.conn = _connect(reader_url or os.environ["WF_MYSQL_READER_URL"], database=schema)
        with self.conn.cursor() as cur:
            cur.execute("SET SESSION TRANSACTION READ ONLY")
            cur.execute(f"SET SESSION max_execution_time = {TIMEOUT_MS}")

    def run(self, sql: str) -> str:
        head = sql.strip().lstrip("(").split(None, 1)[0].upper() if sql.strip() else ""
        if head not in ("SELECT", "WITH"):
            return "Error: only SELECT/WITH queries are allowed."
        try:
            with self.conn.cursor() as cur:
                cur.execute(sql)
                cols = [d[0] for d in cur.description or []]
                rows = cur.fetchmany(MAX_ROWS + 1)
        except pymysql.MySQLError as e:
            return f"SQL error: {e.args[-1] if e.args else e}"
        df = pd.DataFrame(list(rows[:MAX_ROWS]), columns=cols)
        for c in df.columns:   # DECIMAL results (e.g. SUM) arrive as Decimal; make them numbers
            if df[c].map(lambda v: v.__class__.__name__ == "Decimal").any():
                df[c] = df[c].astype(float)
                if df[c].dropna().map(float.is_integer).all():
                    df[c] = df[c].astype("Int64")
        out = df.round(3).to_csv(index=False)
        return out + (f"... (more than {MAX_ROWS} rows; first {MAX_ROWS} shown)\n"
                      if len(rows) > MAX_ROWS else "")

    def close(self):
        try:
            self.conn.close()
        except Exception:
            pass
