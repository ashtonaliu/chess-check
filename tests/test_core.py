from types import SimpleNamespace as NS

import numpy as np
import pandas as pd
import pytest

from chesscheck import coach, model
from chesscheck.fetch import opening_names
from chesscheck.stats import expected_score, games_frame, opening_table, pregame_expected, shrink
from chesscheck.verify import verify


# ---------- stats ----------

def test_expected_score():
    assert expected_score(1500, 1500) == pytest.approx(0.5)
    assert expected_score(1900, 1500) == pytest.approx(0.909, abs=1e-3)


def test_pregame_expected():
    white = pregame_expected(1500, 1500, "white", "blitz")
    assert 0.51 < white < 0.52
    assert pregame_expected(1500, 1500, "black", "blitz") == 1 - white

    for time_class in ("bullet", "blitz", "rapid"):
        favored = pregame_expected(1700, 1500, "white", time_class)
        assert pregame_expected(1500, 1700, "black", time_class) == 1 - favored
    bullet = pregame_expected(1700, 1500, "white", "bullet")
    blitz = pregame_expected(1700, 1500, "white", "blitz")
    elo = expected_score(1700, 1500)
    assert 0.5 < bullet < blitz < elo
    assert pregame_expected(1700, 1500, "white", "daily") == elo
    assert pregame_expected(1700, 1500, "black", "unknown") == elo


def test_shrinkage_pulls_small_samples_harder():
    g = pd.DataFrame({"n": [4, 40], "mean_resid": [-0.2, -0.2]})
    out = shrink(g, sigma2=0.2)
    small, big = out.shrunk
    assert abs(small) < abs(big) < 0.2
    assert out.post_sd[0] > out.post_sd[1]


def test_shrinkage_clamps_ci_high_at_grid_top():
    g = pd.DataFrame({"n": [3], "mean_resid": [0.95]})
    out = shrink(g, sigma2=0.2, mu=0.95)
    assert out.ci_high.iloc[0] == 1.0
    assert out.ci_low.iloc[0] < out.ci_high.iloc[0]


def test_opening_names_canonical():
    assert opening_names("x/Closed-Sicilian-Defense-3.g3")[1] == "Sicilian Defense"
    assert opening_names("x/Caro-Kann")[1] == "Caro-Kann Defense"
    assert opening_names("x/Nimzo-Indian-Defense-4.e3")[1] == "Nimzo-Indian Defense"
    assert opening_names("")[1] == "Unknown"
    # the family named first wins, not the first entry in the table
    assert opening_names("x/Nimzowitsch-Larsen-Attack-Modern-Variation")[1] == "Nimzowitsch-Larsen Attack"
    assert opening_names("x/Four-Knights-Game-Scotch-Variation")[1] == "Four Knights Game"
    assert opening_names("x/Kings-Indian-Attack")[1] == "King's Indian Attack"


def _games(n_sic=12, sic_score=0.0):
    rows = []
    for i in range(n_sic):
        rows.append(NS(url=f"s{i}", color="white", my_rating=1500, opp_rating=1500,
                       score=sic_score, time_class="blitz", eco="B20", opening="Sicilian",
                       family="Sicilian Defense", end_time=i, moves_san="e4 c5 Nf3 d6".split()))
    for i in range(30):
        rows.append(NS(url=f"o{i}", color="white", my_rating=1500, opp_rating=1500,
                       score=[1.0, 0.0, 0.5][i % 3], time_class="blitz", eco="C50",
                       opening="Italian", family="Italian Game", end_time=i,
                       moves_san="e4 e5 Nf3 Nc6".split()))
    return games_frame(rows)


def test_opening_table_flags_real_weakness():
    t = opening_table(_games())
    worst = t.iloc[0]
    assert worst.family == "Sicilian Defense"
    assert worst.ci_high < 0
    assert worst.shrunk > worst.mean_resid  # shrunk toward 0


# ---------- verifier ----------

FACTS = [
    {"id": "F1", "text": "Sicilian Defense as White: 12 games, scored 31% versus 50% expected."},
    {"id": "F2", "text": "Your move 23.Qxd5 (middlegame) lost 45 win%; the engine preferred Rd1. "
                         "Game: https://www.chess.com/game/live/1"},
]


def test_verify_accepts_grounded_report():
    r = verify("You score 31% against an expected 50% in the Sicilian [F1]. "
               "On 23.Qxd5 you lost 45 win%; Rd1 was better [F2].", FACTS)
    assert r["ok"], r


def test_verify_catches_invented_number_and_move():
    r = verify("You score 28% in the Sicilian [F1]. Next time play 23.Nf3 [F2].", FACTS)
    kinds = {(u["type"], str(u["claim"])) for u in r["unsupported"]}
    assert ("number", "28.0") in kinds
    assert ("move", "Nf3") in kinds
    assert not r["ok"]


def test_verify_rejects_number_borrowed_from_another_fact():
    # 12 is in F1, but this sentence cites F2
    r = verify("Do 12 puzzles a day [F2].", FACTS)
    assert not r["ok"]
    assert r["unsupported"][0]["type"] == "miscited number"


def test_verify_ignores_numbered_list_markers():
    r = verify("**1. Sicilian Defense.** You score 31% [F1].", FACTS)
    assert r["ok"], r


def test_verify_catches_bad_citation_and_url():
    r = verify("See https://example.com/x for more [F9].", FACTS)
    assert r["bad_citations"] == ["F9"]
    assert any(u["type"] == "url" for u in r["unsupported"])


def test_verify_checks_capture_promotion_piece_and_check():
    facts = [{"id": "F1", "text": "Your move 42.exd8=Q+ (endgame) lost 25 win%."}]
    assert verify("You played 42.exd8=Q+ [F1].", facts)["ok"]
    wrong_piece = verify("You played 42.exd8=N [F1].", facts)
    assert not wrong_piece["ok"]
    assert ("move", "exd8=N") in {(u["type"], u["claim"]) for u in wrong_piece["unsupported"]}
    dropped = verify("You played 42.exd8 [F1].", facts)
    assert not dropped["ok"]


# ---------- coach agent loop (fake client, no API calls) ----------

def _block(**kw):
    return NS(**kw)


class FakeClient:
    """Turn 1: call run_sql. Turn 2: report with a made-up number.
    Turn 3 (after verifier feedback): corrected report."""

    def __init__(self):
        self.calls = []
        self.beta = NS(messages=NS(create=self.create))

    def create(self, **kw):
        self.calls.append(kw)
        usage = NS(input_tokens=10, output_tokens=5)
        n = len(self.calls)
        if n == 1:
            return NS(stop_reason="tool_use", usage=usage, content=[
                _block(type="tool_use", id="tu1", name="run_sql",
                       input={"query": "SELECT COUNT(*) AS n FROM games"})])
        if n == 2:
            last = kw["messages"][-1]["content"][0]
            assert last["type"] == "tool_result" and not last["is_error"]
            assert "[T1]" in last["content"]
            return NS(stop_reason="end_turn", usage=usage, content=[
                _block(type="text", text="You played 99 games [T1].")])
        return NS(stop_reason="end_turn", usage=usage, content=[
            _block(type="text", text="You played 42 games [T1].")])


def test_coach_tool_loop_and_repair():
    games = _games()
    facts = [{"id": "F1", "kind": "overall", "text": "Across 42 games you scored 40%."}]
    fake = FakeClient()
    res = coach.run_coach("someone", facts, games, None, client=fake)
    assert res.tool_calls[0]["name"] == "run_sql"
    assert not res.first_verification["ok"]       # 99 was invented
    assert res.repaired and res.verification["ok"]  # 42 is in T1 and F1
    assert fake.calls[0]["model"] == coach.MODEL
    # refusal fallbacks are only sent for models that support them
    assert ("fallbacks" in fake.calls[0]) == (coach.MODEL in coach.FALLBACK_MODELS)


def test_sql_tool_is_read_only():
    box = coach.ToolBox(_games(), None, [])
    try:
        out, err = box.run("run_sql", {"query": "DROP TABLE games"})
        assert err
        out, err = box.run("run_sql", {"query": "SELECT * FROM read_csv('/etc/passwd')"})
        assert err
    finally:
        box.close()


def test_run_coach_closes_sql_connection(monkeypatch):
    closed = []
    orig = coach.ReadOnlySQL.close

    def track_close(self):
        closed.append(True)
        return orig(self)

    monkeypatch.setattr(coach.ReadOnlySQL, "close", track_close)
    games = _games()
    facts = [{"id": "F1", "kind": "overall", "text": "Across 42 games you scored 40%."}]
    coach.run_coach("someone", facts, games, None, client=FakeClient())
    assert len(closed) == 1

    class FailingClient:
        def __init__(self):
            self.beta = NS(messages=NS(create=self.create))

        def create(self, **kw):
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        coach.run_coach("someone", facts, games, None, client=FailingClient())
    assert len(closed) == 2


def test_engine_eval_rejects_invalid_fen_without_starting_stockfish(monkeypatch):
    import chess.engine

    def fail_popen(*args, **kwargs):
        raise AssertionError("Stockfish should not be started for an invalid FEN")

    monkeypatch.setattr(chess.engine.SimpleEngine, "popen_uci", staticmethod(fail_popen))
    box = coach.ToolBox(_games(), None, [])
    try:
        out, err = box.run("engine_eval", {"fen": "8/8/8/8/8/8/8/8 w - - 0 1"})
        assert err and "invalid" in out.lower(), out
    finally:
        box.close()


# ---------- model ----------

def _synthetic_moves(n_games=60, per_game=60, seed=0):
    rng = np.random.default_rng(seed)
    rows = []
    for g in range(n_games):
        for p in range(per_game):
            clock_frac = max(0.0, 1 - p / per_game + rng.normal(0, 0.05))
            # blunders get much likelier with little time left
            prob = 0.01 + 0.25 * (clock_frac < 0.1)
            rows.append({
                "url": f"g{g}", "ply": p, "move_no": p // 2 + 1, "is_me": p % 2 == 0,
                "phase": "opening" if p < 24 else "middlegame",
                "cp_before": rng.normal(0, 150), "wp_loss": 30.0 if rng.random() < prob else 1.0,
                "clock": 180 * clock_frac, "clock_frac": clock_frac, "time_spent": rng.exponential(3),
                "legal_moves": rng.integers(10, 45), "in_check": 0,
                "captures_available": rng.integers(0, 5), "material_balance": 0,
                "non_pawn_material": 50,
            })
    return pd.DataFrame(rows)


def test_benchmark_learns_signal():
    b = model.benchmark(_synthetic_moves())
    t = b["table"].set_index("model")
    assert t.loc["gradient boosting", "auc"] > 0.75
    assert t.loc["MLP (PyTorch)", "auc"] > 0.75
    assert b["importance"].index[0] in ("clock_frac_f", "log_clock")


def test_player_risk_buckets():
    r = model.player_risk(_synthetic_moves())
    assert r and r["buckets"]
    assert 0.5 < r["ratio"] < 1.5


def test_player_risk_returns_none_with_no_player_moves():
    df = _synthetic_moves()
    df["is_me"] = False
    assert model.player_risk(df) is None


def test_verify_url_punctuation_on_both_sides():
    facts = [{"id": "T1", "text": "- https://www.chess.com/game/live/42: you lost"}]
    r = verify("Replay https://www.chess.com/game/live/42, then review it [T1].", facts)
    assert r["ok"], r


# ---------- game search ----------

def test_search_games_tool_ranks_and_registers_a_fact():
    summaries = [
        ("u1", "You lost on time as White in the Italian Game. Your worst mistake was 40.Kg2 in the endgame, in time trouble."),
        ("u2", "You won by checkmate as Black in the Sicilian Defense. You made no serious blunders."),
        ("u3", "You drew by repetition as White in the London System. The opening went about equal."),
    ]
    box = coach.ToolBox(_games(), None, [], summaries)
    out, err = box.run("search_games", {"query": "flagged because my clock ran out", "k": 1})
    assert not err and out.startswith("[T1]")
    assert "u1:" in out and "u2:" not in out


def test_pregame_ratings_come_from_the_previous_game():
    from chesscheck.fetch import Game, pregame_ratings

    def g(url, tc, my, opp):
        return Game(url=url, color="white", my_rating=my, opp_rating=opp, score=1, time_class=tc,
                    eco="", opening="", family="", end_time=0)
    # newest first; archive ratings are after each game (same example as web/test/recap.test.ts)
    out = pregame_ratings([g("4", "blitz", 1508, 1492), g("3", "rapid", 1700, 1650),
                           g("2", "blitz", 1500, 1510), g("1", "blitz", 1510, 1480)])
    assert [(x.my_rating, x.opp_rating) for x in out] == [(1500, 1500), (1700, 1650), (1510, 1500), (1510, 1480)]


def test_fetch_retries_429_and_5xx_with_backoff_and_retry_after(monkeypatch):
    import requests
    from chesscheck import fetch

    sleeps = []
    monkeypatch.setattr(fetch.time, "sleep", sleeps.append)

    class FakeResponse:
        def __init__(self, status, payload=None, headers=None):
            self.status_code = status
            self._payload = payload or {}
            self.headers = headers or {}

        def json(self):
            return self._payload

        def raise_for_status(self):
            if self.status_code >= 400:
                raise requests.HTTPError(f"HTTP {self.status_code}")

    raw_game = {
        "url": "game/1",
        "rules": "chess",
        "time_class": "blitz",
        "end_time": 100,
        "white": {"username": "someone", "rating": 1500, "result": "win"},
        "black": {"username": "other", "rating": 1500, "result": "resigned"},
        "pgn": '[Event "Live Chess"]\n\n1. e4 e5 1-0',
    }

    class FakeSession:
        def __init__(self, plan):
            self.plan = list(plan)
            self.calls = []

        def get(self, url, **kwargs):
            self.calls.append(url)
            return self.plan.pop(0)

    # Retries 429 (with Retry-After) and 503 (default 1s/2s backoff) across archives + month calls
    session = FakeSession([
        FakeResponse(429, headers={"Retry-After": "4"}),
        FakeResponse(503),
        FakeResponse(200, {"archives": ["archives/2026/10"]}),
        FakeResponse(502),
        FakeResponse(429),
        FakeResponse(200, {"games": [raw_game]}),
    ])
    games = fetch.fetch_games("someone", max_games=5, session=session)
    assert len(games) == 1
    assert sleeps == [4.0, 2.0, 1.0, 2.0]

    # Exhausting 3 attempts raises HTTPError
    sleeps.clear()
    failing = FakeSession([FakeResponse(503), FakeResponse(503), FakeResponse(503)])
    with pytest.raises(requests.HTTPError):
        fetch.fetch_games("someone", max_games=5, session=failing)
    assert len(failing.calls) == 3
    assert sleeps == [1.0, 2.0]

    # 404 is not retried
    sleeps.clear()
    missing = FakeSession([FakeResponse(404)])
    with pytest.raises(ValueError, match="No Chess.com player"):
        fetch.fetch_games("someone", max_games=5, session=missing)
    assert len(missing.calls) == 1
    assert sleeps == []

    # A long Retry-After is capped, and a dropped connection is retried
    sleeps.clear()
    flaky = FakeSession([FakeResponse(429, headers={"Retry-After": "3600"}),
                         FakeResponse(200, {"archives": []})])
    real_get = flaky.get
    dropped = []

    def get(url, **kwargs):
        if not dropped:
            dropped.append(url)
            raise requests.ConnectionError("reset")
        return real_get(url, **kwargs)

    flaky.get = get
    assert fetch.fetch_games("someone", max_games=5, session=flaky) == []
    assert sleeps == [1.0, fetch.MAX_RETRY_WAIT]

