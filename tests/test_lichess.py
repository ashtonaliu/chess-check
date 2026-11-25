"""Lichess parsing, cross-language parity, rate limiting, and server routing tests (no network)."""
from __future__ import annotations

import io
import json
from pathlib import Path

import chess.pgn
import pytest

from chesscheck import coach, lichess, pipeline

FIXTURE = Path(__file__).resolve().parents[1] / "web" / "test" / "fixtures" / "lichess_parity.json"
LICHESS_GAME_PREFIX = "https://" + "lichess.org/game/"


def _base_export(**over) -> dict:
    doc = {
        "id": "AbCdEf12",
        "variant": "standard",
        "speed": "blitz",
        "createdAt": 1_760_000_000_000,
        "lastMoveAt": 1_760_000_120_000,
        "status": "resign",
        "winner": "white",
        "moves": "e4 e5 Nf3 Nc6",
        "clocks": [18000, 18000, 17850, 17700],
        "clock": {"initial": 180, "increment": 2},
        "opening": {"eco": "C44", "name": "King's Knight Opening: Normal Variation"},
        "players": {
            "white": {"user": {"id": "alice", "name": "Alice"}, "rating": 1500, "ratingDiff": 8},
            "black": {"user": {"id": "bob", "name": "Bob"}, "rating": 1520, "ratingDiff": -8},
        },
    }
    doc.update(over)
    return doc


def _pgn_clocks(pgn_text: str) -> list[float | None]:
    pg = chess.pgn.read_game(io.StringIO(pgn_text))
    assert pg is not None
    out: list[float | None] = []
    node = pg
    while node.variations:
        node = node.variations[0]
        out.append(node.clock())
    return out


def test_cross_language_parity_with_20_phase_a_games():
    fixture = json.loads(FIXTURE.read_text())
    expected = fixture["expected"]
    exports = fixture["exports"]
    assert len(expected) == 20

    for exp in expected:
        raw = exports[exp["game_id"]]
        white_view = lichess.parse_lichess_game(raw, exp["white"])
        assert white_view is not None, exp["url"]
        assert white_view.site == "lichess"
        assert white_view.url == f"{LICHESS_GAME_PREFIX}{exp['game_id']}"
        assert white_view.moves_san == [m["san"] for m in exp["moves"]]
        assert white_view.my_rating == exp["white_rating_before"]
        assert white_view.opp_rating == exp["black_rating_before"]
        assert white_view.time_class == exp["time_class"]
        assert white_view.time_control == exp["time_control"]
        assert white_view.eco == exp["eco"]
        assert white_view.opening == exp["opening"]
        expected_white_score = 1.0 if exp["result"] == "1-0" else 0.0 if exp["result"] == "0-1" else 0.5
        assert white_view.score == expected_white_score

        clocks = _pgn_clocks(white_view.pgn)
        assert len(clocks) == len(exp["moves"])
        for ply, (actual_sec, move_exp) in enumerate(zip(clocks, exp["moves"], strict=True)):
            if move_exp["clock_after"] is not None:
                assert actual_sec is not None, f"{exp['url']} ply {ply}"
                assert abs(actual_sec - move_exp["clock_after"]) <= 1.0, f"{exp['url']} ply {ply}"

        black_view = lichess.parse_lichess_game(raw, exp["black"])
        assert black_view is not None, exp["url"]
        assert black_view.my_rating == exp["black_rating_before"]
        assert black_view.opp_rating == exp["white_rating_before"]
        assert black_view.score == 1.0 - expected_white_score


def test_every_lichess_status_maps_like_typescript():
    for skipped in ("created", "started", "aborted", "noStart", "unknownNewStatus"):
        assert lichess.parse_lichess_game(_base_export(status=skipped), "Alice") is None

    win_cases = [
        ("mate", "checkmated"),
        ("resign", "resigned"),
        ("timeout", "timeout"),
        ("outoftime", "timeout"),
        ("cheat", "cheat"),
        ("variantEnd", "variantEnd"),
        ("unknownFinish", "unknownFinish"),
    ]
    for status, loser_code in win_cases:
        w = lichess.parse_lichess_game(_base_export(status=status, winner="white"), "alice")
        assert w is not None and (w.score, w.result, w.opp_result) == (1.0, "win", loser_code)
        b = lichess.parse_lichess_game(_base_export(status=status, winner="white"), "bob")
        assert b is not None and (b.score, b.result, b.opp_result) == (0.0, loser_code, "win")

    draw_cases = [
        ("draw", "agreed"),
        ("stalemate", "stalemate"),
        ("insufficientMaterialClaim", "insufficient"),
        ("timeout", "timevsinsufficient"),
        ("outoftime", "timevsinsufficient"),
        ("unknownFinish", "agreed"),
        ("variantEnd", "agreed"),
    ]
    for status, draw_code in draw_cases:
        g = lichess.parse_lichess_game(_base_export(status=status, winner=None), "alice")
        assert g is not None and (g.score, g.result, g.opp_result) == (0.5, draw_code, draw_code)


def test_rejects_nonstandard_variants_initial_fen_and_other_players():
    assert lichess.parse_lichess_game(_base_export(variant="chess960"), "alice") is None
    assert lichess.parse_lichess_game(_base_export(initialFen="4k3/8/8/8/8/8/8/4K3 w - - 0 1"), "alice") is None
    assert lichess.parse_lichess_game(_base_export(), "charlie") is None
    assert lichess.parse_lichess_game(None, "alice") is None

    for speed in ("ultraBullet", "bullet", "blitz", "rapid", "classical"):
        g = lichess.parse_lichess_game(_base_export(speed=speed), "alice")
        assert g is not None and g.time_class == speed
    daily = lichess.parse_lichess_game(_base_export(speed="correspondence", clock=None, daysPerTurn=3), "alice")
    assert daily is not None and daily.time_class == "daily" and daily.time_control == "1/259200"


def test_parse_lichess_ndjson_skips_bad_lines_and_filtered_games():
    ndjson = "\n".join([
        json.dumps(_base_export(id="Game0001")),
        "{not json",
        "",
        json.dumps(_base_export(id="Game0002", status="started")),
        json.dumps(_base_export(id="Game0003", variant="antichess")),
        json.dumps(_base_export(id="Game0004")),
    ])
    games, skipped = lichess.parse_lichess_ndjson(ndjson, "alice")
    assert [g.url for g in games] == [f"{LICHESS_GAME_PREFIX}Game0001", f"{LICHESS_GAME_PREFIX}Game0004"]
    assert skipped == 3


def test_fetch_lichess_games_params_and_429_cooldown(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(lichess.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(lichess, "_rate_limited_until", 0.0)

    class FakeResponse:
        def __init__(self, status: int, lines: list[str] | None = None):
            self.status_code = status
            self._lines = lines or []
            self.headers: dict[str, str] = {}

        def iter_lines(self, decode_unicode: bool = True):
            return iter(self._lines)

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"HTTP {self.status_code}")

        def close(self):
            pass

    calls = []

    class FakeSession:
        def __init__(self, plan):
            self.plan = list(plan)

        def get(self, url, **kwargs):
            calls.append((url, kwargs))
            return self.plan.pop(0)

    line = json.dumps(_base_export(id="Game0009", speed="correspondence", clock=None, daysPerTurn=2))
    session = FakeSession([FakeResponse(200, [line, "{bad"])])
    games = lichess.fetch_lichess_games("alice", max_games=25, time_class="daily", session=session)
    assert len(games) == 1
    assert games[0].time_class == "daily"
    assert len(calls) == 1
    url, kw = calls[0]
    assert url.endswith("/api/games/user/alice")
    assert kw["headers"]["Accept"] == "application/x-ndjson"
    assert kw["params"] == {
        "max": 25,
        "clocks": "true",
        "opening": "true",
        "ongoing": "false",
        "finished": "true",
        "perfType": "correspondence",
    }

    # 429 fails immediately with no retry and pauses all Lichess requests for 60 seconds
    calls.clear()
    session_429 = FakeSession([FakeResponse(429), FakeResponse(200, [line])])
    with pytest.raises(lichess.LichessRateLimitError, match="minute"):
        lichess.fetch_lichess_games("alice", max_games=25, session=session_429)
    assert len(calls) == 1

    # Next call during the 60-second window fails fast without touching the network
    now[0] += 30.0
    with pytest.raises(lichess.LichessRateLimitError, match="minute"):
        lichess.fetch_lichess_games("bob", max_games=25, session=session_429)
    assert len(calls) == 1

    # After 60 seconds, requests resume
    now[0] += 31.0
    resumed = lichess.fetch_lichess_games("alice", max_games=25, session=session_429)
    assert len(resumed) == 1
    assert len(calls) == 2


def test_server_lichess_validation_cache_isolation_and_rate_limit(monkeypatch):
    fastapi = pytest.importorskip("fastapi")
    assert fastapi is not None
    import server

    monkeypatch.setattr(server, "_cache", server.OrderedDict())
    monkeypatch.setattr(server, "_inflight", {})
    monkeypatch.setattr(lichess, "_rate_limited_until", 0.0)

    from pydantic import ValidationError

    # Site-specific time_class validation
    assert server.AnalyzeReq(username="al", games=20, time_class="classical", site="lichess").time_class == "classical"
    assert server.AnalyzeReq(username="al", games=20, time_class="ultraBullet", site="lichess").time_class == "ultraBullet"
    with pytest.raises(ValidationError):
        server.AnalyzeReq(username="alice", games=20, time_class="classical", site="chesscom")

    # Site-specific username validation and error messages
    with pytest.raises(server.HTTPException) as err_cc:
        server._get(server.AnalyzeReq(username="ab", games=20, site="chesscom"))
    assert err_cc.value.status_code == 400 and "Chess.com" in err_cc.value.detail

    with pytest.raises(server.HTTPException) as err_li:
        server._get(server.AnalyzeReq(username="a" * 21, games=20, site="lichess"))
    assert err_li.value.status_code == 400 and "Lichess" in err_li.value.detail

    # Cache keeps Chess.com and Lichess apart for the same username
    seen = []

    def fake_analyze(username, max_games, time_class, depth, site="chesscom"):
        seen.append((site, username, time_class))
        return f"{site}:{username}"

    monkeypatch.setattr(server, "analyze", fake_analyze)
    cc_res = server._get(server.AnalyzeReq(username="sameuser", games=20, time_class="blitz", site="chesscom"))
    li_res = server._get(server.AnalyzeReq(username="sameuser", games=20, time_class="blitz", site="lichess"))
    assert cc_res == "chesscom:sameuser"
    assert li_res == "lichess:sameuser"
    assert seen == [("chesscom", "sameuser", "blitz"), ("lichess", "sameuser", "blitz")]

    # Lichess 429 through pipeline.analyze -> server._get yields HTTP 429 with Retry-After: 60
    monkeypatch.setattr(server, "analyze", pipeline.analyze)
    monkeypatch.setattr(server, "_cache", server.OrderedDict())
    now = [2000.0]
    monkeypatch.setattr(lichess.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(lichess, "_rate_limited_until", now[0] + 60.0)
    with pytest.raises(server.HTTPException) as rate_err:
        server._get(server.AnalyzeReq(username="al", games=20, time_class="blitz", site="lichess"))
    assert rate_err.value.status_code == 429
    assert rate_err.value.headers == {"Retry-After": "60"}
    assert "Lichess" in rate_err.value.detail

    # Coach system prompt follows site
    assert "Chess.com" in coach.system_prompt("chesscom")
    assert "Lichess" in coach.system_prompt("lichess")
    assert "Chess.com" not in coach.system_prompt("lichess")
