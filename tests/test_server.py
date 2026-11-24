"""Concurrency on the hosted analysis endpoint, with a stub in place of the real analysis."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

fastapi = pytest.importorskip("fastapi")
import server  # noqa: E402
from chesscheck import engine  # noqa: E402


@pytest.fixture
def stub(monkeypatch):
    """Replace the analysis with a slow stub that records how many run at once."""
    state = {"calls": 0, "running": 0, "peak": 0, "fail": False}
    lock = threading.Lock()

    def analyze(username, max_games, time_class, depth):
        with lock:
            state["calls"] += 1
            state["running"] += 1
            state["peak"] = max(state["peak"], state["running"])
        try:
            time.sleep(0.2)
            if state["fail"]:
                raise ValueError(f"No Chess.com player named {username!r}")
            return object()
        finally:
            with lock:
                state["running"] -= 1

    monkeypatch.setattr(server, "analyze", analyze)
    monkeypatch.setattr(server, "_cache", server.OrderedDict())
    monkeypatch.setattr(server, "_inflight", {})
    return state


def req(name="someone", games=150):
    return server.AnalyzeReq(username=name, games=games, time_class="blitz")


def test_identical_requests_share_one_analysis(stub):
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda _: server._get(req()), range(4)))
    assert stub["calls"] == 1
    assert all(r is results[0] for r in results)
    assert server._get(req()) is results[0]          # and later ones come from the cache
    assert stub["calls"] == 1


def test_a_failure_reaches_every_waiting_request_once(stub):
    stub["fail"] = True
    with ThreadPoolExecutor(3) as pool:
        futures = [pool.submit(server._get, req()) for _ in range(3)]
    for f in futures:
        with pytest.raises(server.HTTPException) as e:
            f.result()
        assert e.value.status_code == 404
    assert stub["calls"] == 1
    assert not server._inflight


def test_different_requests_run_at_most_max_jobs_at_once(stub, monkeypatch):
    monkeypatch.setattr(server, "_jobs", threading.BoundedSemaphore(2))
    with ThreadPoolExecutor(5) as pool:
        list(pool.map(lambda i: server._get(req(f"player{i}")), range(5)))
    assert stub["calls"] == 5
    assert stub["peak"] == 2


def test_the_cache_is_bounded(stub, monkeypatch):
    monkeypatch.setattr(server, "CACHE_MAX", 3)
    for i in range(6):
        server._get(req(f"player{i}"))
    assert len(server._cache) == 3
    assert list(server._cache)[-1][0] == "player5"   # the newest are kept


class FakeEngine:
    def __init__(self):
        self.closed = False

    def configure(self, _):
        pass

    def quit(self):
        self.closed = True


def test_one_jobs_engines_are_never_closed_by_another(monkeypatch):
    monkeypatch.setattr(engine.chess.engine.SimpleEngine, "popen_uci", staticmethod(lambda path: FakeEngine()))
    with engine.EnginePool() as a:
        with engine.EnginePool() as b:
            ea, eb = a.get("stockfish"), b.get("stockfish")
            assert a.get("stockfish") is ea                  # one per thread, reused
        assert eb.closed and not ea.closed                   # b finishing leaves a's engine alone
    assert ea.closed


def test_cache_files_are_written_whole(tmp_path):
    target = tmp_path / "game.json"
    engine._write_atomic(target, '{"ok": true}')
    assert target.read_text() == '{"ok": true}'
    assert [p.name for p in tmp_path.iterdir()] == ["game.json"]   # no temporary file left behind


def test_hosted_coach_requires_token_and_limits_work(monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from starlette.requests import Request

    monkeypatch.setenv("CHESS_CHECK_COACH_TOKEN", "test-coaching-token")
    monkeypatch.setattr(server, "_backend", lambda: "api")
    monkeypatch.setattr(server, "_coach_jobs", threading.BoundedSemaphore(1))
    calls = []
    started = threading.Event()
    release = threading.Event()

    def fake_analysis(request):
        calls.append(request.username)
        return SimpleNamespace(username=request.username, facts=[], games=[], moves=[], summaries=[])

    def fake_coach(*args, **kwargs):
        started.set()
        assert release.wait(5)
        return SimpleNamespace(report="report", verification={}, first_verification={}, repaired=False,
                               tool_calls=[], usage={}, facts=[])

    monkeypatch.setattr(server, "_get", fake_analysis)
    monkeypatch.setattr(server, "run_coach_auto", fake_coach)

    def request(token=None):
        headers = [] if token is None else [(b"authorization", f"Bearer {token}".encode())]
        return Request({"type": "http", "client": ("192.0.2.1", 10000), "headers": headers})

    async def exercise():
        data = req()
        for token in (None, "wrong"):
            with pytest.raises(server.HTTPException) as rejected:
                await server.api_coach(data, request(token))
            assert rejected.value.status_code == 401
        assert not calls
        accepted = asyncio.create_task(server.api_coach(data, request("test-coaching-token")))
        try:
            assert await asyncio.to_thread(started.wait, 5)
            with pytest.raises(server.HTTPException) as busy:
                await server.api_coach(data, request("test-coaching-token"))
            assert busy.value.status_code == 429
            assert calls == ["someone"]
        finally:
            release.set()
        assert (await accepted)["report"] == "report"

    asyncio.run(exercise())


def test_local_coach_is_explicit_and_loopback_only(monkeypatch):
    from starlette.requests import Request

    monkeypatch.delenv("CHESS_CHECK_COACH_TOKEN", raising=False)
    monkeypatch.delenv("CHESS_CHECK_LOCAL_COACH", raising=False)
    local = Request({"type": "http", "client": ("127.0.0.1", 10000)})
    remote = Request({"type": "http", "client": ("192.0.2.1", 10000)})
    assert server._coach_access(local) is None
    monkeypatch.setenv("CHESS_CHECK_LOCAL_COACH", "1")
    assert server._coach_access(local) == "local"
    assert server._coach_access(remote) is None


def test_username_with_trailing_newline_is_rejected(stub):
    with pytest.raises(server.HTTPException) as rejected:
        server._get(req("hikaru\n"))
    assert rejected.value.status_code == 400
    assert stub["calls"] == 0


def test_coach_errors_return_502_without_leaking_internals(monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from starlette.requests import Request

    monkeypatch.setenv("CHESS_CHECK_COACH_TOKEN", "test-coaching-token")
    monkeypatch.setattr(server, "_backend", lambda: "api")
    monkeypatch.setattr(server, "_coach_jobs", threading.BoundedSemaphore(1))
    monkeypatch.setattr(server, "_get", lambda r: SimpleNamespace(
        username=r.username, facts=[], games=[], moves=[], summaries=[]))

    request = Request({
        "type": "http",
        "client": ("192.0.2.1", 10000),
        "headers": [(b"authorization", b"Bearer test-coaching-token")],
    })

    class UpstreamAPIError(Exception):
        pass

    for exc in (RuntimeError("Claude Code failed: /Users/local/secret.py"), UpstreamAPIError("api key sk-secret")):
        monkeypatch.setattr(server, "run_coach_auto", lambda *a, _exc=exc, **kw: (_ for _ in ()).throw(_exc))
        with pytest.raises(server.HTTPException) as err:
            asyncio.run(server.api_coach(req(), request))
        assert err.value.status_code == 502
        assert "/Users/local/secret.py" not in err.value.detail
        assert "sk-secret" not in err.value.detail
