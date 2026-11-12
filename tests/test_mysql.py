"""MySQL backend tests against a real server. Skipped unless configured:

  docker compose up -d mysql
  WF_TEST_MYSQL=1 .venv/bin/python -m pytest tests/test_mysql.py

Credentials come from WF_MYSQL_WRITER_URL / WF_MYSQL_READER_URL, or are built
from the passwords in .env (MySQL on 127.0.0.1:3306).
"""
from __future__ import annotations

import io
import json
import os
from pathlib import Path

import pandas as pd
import pymysql
import pytest

from wf import coach, mysql_store
from wf.db import ReadOnlySQL
from wf.env import load_env
from wf.stats import expected_score

ROOT = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.skipif(os.environ.get("WF_TEST_MYSQL") != "1", reason="set WF_TEST_MYSQL=1 with MySQL running")


class Secret(str):
    """A URL that never shows its password in test output or tracebacks."""

    def __repr__(self):
        return "'mysql://***'"


@pytest.fixture(scope="module")
def urls():
    load_env()
    w = os.environ.get("WF_MYSQL_WRITER_URL") or f"mysql://wf_writer:{os.environ['WF_WRITER_PASSWORD']}@127.0.0.1:3306"
    r = os.environ.get("WF_MYSQL_READER_URL") or f"mysql://wf_reader:{os.environ['WF_READER_PASSWORD']}@127.0.0.1:3306"
    return Secret(w), Secret(r)


@pytest.fixture(scope="module")
def frames():
    """Real engine-analysed games from the TypeScript parity fixture."""
    fx = json.loads((ROOT / "web/test/fixtures/model.json").read_text())
    games = pd.DataFrame([{
        "url": g["url"], "color": g["color"], "my_rating": g["myRating"], "opp_rating": g["oppRating"],
        "score": g["score"], "time_class": g["timeClass"], "eco": g["eco"], "opening": g["opening"],
        "family": g["family"], "end_time": g["endTime"], "moves": " ".join(g["moves"][:16]),
    } for g in fx["games"]])
    games["expected"] = [expected_score(a, b) for a, b in zip(games.my_rating, games.opp_rating)]
    games["residual"] = games.score - games.expected
    moves = pd.DataFrame(fx["rows"])
    return games, moves


@pytest.fixture(scope="module")
def loaded(urls, frames):
    games, moves = frames
    schema = mysql_store.load(games, moves, writer_url=urls[0])
    yield schema
    conn = mysql_store._connect(urls[0])
    with conn.cursor() as cur:
        cur.execute(f"DROP DATABASE IF EXISTS `{schema}`")
    conn.close()


PORTABLE_QUERIES = [
    "SELECT phase, COUNT(*) AS n, AVG(wp_loss) AS avg_loss FROM moves WHERE is_me GROUP BY phase ORDER BY phase",
    "SELECT color, family, COUNT(*) AS n, AVG(score) AS score FROM games GROUP BY color, family "
    "HAVING COUNT(*) >= 2 ORDER BY n DESC, family, color",
    "SELECT g.family, SUM(CASE WHEN m.wp_loss >= 20 THEN 1 ELSE 0 END) AS blunders FROM moves m "
    "JOIN games g ON g.url = m.url WHERE m.is_me GROUP BY g.family ORDER BY blunders DESC, g.family LIMIT 5",
    "WITH worst AS (SELECT url, MAX(wp_loss) AS w FROM moves WHERE is_me GROUP BY url) "
    "SELECT COUNT(*) AS games, SUM(CASE WHEN w >= 20 THEN 1 ELSE 0 END) AS with_blunder FROM worst",
    "SELECT ROUND(AVG(clock_frac), 3) AS avg_frac, COUNT(clock) AS with_clock FROM moves WHERE is_me",
]


def _csv(text: str) -> pd.DataFrame:
    return pd.read_csv(io.StringIO(text.split("...")[0]))


def test_same_answers_on_duckdb_and_mysql(urls, frames, loaded):
    games, moves = frames
    duck = ReadOnlySQL(games, moves)
    my = mysql_store.MySQLReadOnlySQL(loaded, reader_url=urls[1])
    for q in PORTABLE_QUERIES:
        a, b = _csv(duck.run(q)), _csv(my.run(q))
        assert list(a.columns) == list(b.columns), q
        pd.testing.assert_frame_equal(a.reset_index(drop=True), b.reset_index(drop=True),
                                      check_dtype=False, atol=1e-3, obj=q)


@pytest.mark.parametrize("sql", [
    "INSERT INTO games (url, color) VALUES ('x', 'white')",
    "DROP TABLE moves",
    "CREATE DATABASE wf_should_not_exist",
    "SELECT * FROM games INTO OUTFILE '/tmp/leak.csv'",
])
def test_reader_cannot_write_even_bypassing_the_tool(urls, loaded, sql):
    """Straight to MySQL as wf_reader, skipping the tool's SELECT-only check."""
    conn = mysql_store._connect(urls[1], database=loaded)
    with pytest.raises(pymysql.MySQLError):
        with conn.cursor() as cur:
            cur.execute(sql)
    conn.close()


def test_tool_refuses_writes_and_stops_runaway_queries(urls, loaded):
    my = mysql_store.MySQLReadOnlySQL(loaded, reader_url=urls[1])
    assert my.run("DELETE FROM games").startswith("Error: only SELECT")
    # must touch every row (a bare COUNT(*) of a cross join is answered from table sizes)
    out = my.run("SELECT SUM(a.ply * b.ply + c.ply) AS s FROM moves a, moves b, moves c")
    assert out.startswith("SQL error") and "time" in out.lower(), out


def test_coach_toolbox_runs_on_mysql(monkeypatch, urls, frames):
    games, moves = frames
    monkeypatch.setenv("WF_SQL_BACKEND", "mysql")
    monkeypatch.setenv("WF_MYSQL_WRITER_URL", urls[0])
    monkeypatch.setenv("WF_MYSQL_READER_URL", urls[1])
    box = coach.ToolBox(games, moves, [])
    assert box.sql.dialect == "MySQL 8"
    assert "MySQL 8 SQL" in coach.tools_for(box.sql.dialect)[0]["description"]
    out, err = box.run("run_sql", {"query": "SELECT COUNT(*) AS n FROM games"})
    assert not err and out.startswith("[T1]") and f"\n{len(games)}\n" in out
