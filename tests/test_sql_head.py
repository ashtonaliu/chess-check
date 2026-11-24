from chesscheck.db import _sql_head


def test_leading_comments_are_skipped_before_the_statement_check():
    assert _sql_head("-- top openings\nSELECT 1") == "SELECT"
    assert _sql_head("/* note */ (WITH t AS (SELECT 1) SELECT * FROM t)") == "WITH"
    assert _sql_head("-- a\n/* b */\n  select 1") == "SELECT"


def test_comments_cannot_hide_a_write():
    assert _sql_head("-- SELECT\nDROP TABLE games") == "DROP"
    assert _sql_head("/* SELECT */ DELETE FROM games") == "DELETE"
    assert _sql_head("/* unterminated SELECT") == ""
    assert _sql_head("") == ""
