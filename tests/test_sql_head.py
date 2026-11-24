import pandas as pd

from chesscheck.db import ReadOnlySQL, _sql_head


def test_leading_comments_are_skipped_before_the_statement_check():
    assert _sql_head("-- top openings\nSELECT 1") == "SELECT"
    assert _sql_head("/* note */ (WITH t AS (SELECT 1) SELECT * FROM t)") == "WITH"
    assert _sql_head("-- a\n/* b */\n  select 1") == "SELECT"


def test_comments_cannot_hide_a_write():
    assert _sql_head("-- SELECT\nDROP TABLE games") == "DROP"
    assert _sql_head("/* SELECT */ DELETE FROM games") == "DELETE"
    assert _sql_head("/* unterminated SELECT") == ""
    assert _sql_head("") == ""


def test_readonly_sql_requires_a_single_select_statement():
    sql = ReadOnlySQL(pd.DataFrame([{"url": "u1", "score": 1.0}]), None)
    try:
        assert sql.run("SELECT ';' AS sep;").strip() == "sep\n;"
        assert sql.run("SELECT 1 AS n;").strip() == "n\n1"
        assert sql.run("WITH t AS (SELECT 1 AS n) SELECT n FROM t;").strip() == "n\n1"
        assert sql.run("SELECT 1; DROP TABLE games;").startswith("Error:")
        assert sql.run("SELECT 1; SELECT 2;").startswith("Error:")
        assert sql.run("SELECT COUNT(*) AS n FROM games").strip() == "n\n1"
    finally:
        sql.close()
