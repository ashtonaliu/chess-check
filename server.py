"""FastAPI backend: serves the TypeScript UI and the analysis/coach API.

Run locally:  uvicorn server:app --reload
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from chesscheck.coach_cli import available as claude_code_available, run_coach_auto
from chesscheck.env import load_env
from chesscheck.pipeline import Analysis, analyze, to_payload

load_env()

app = FastAPI(title="Chess Check")
WEB = Path(__file__).parent / "web"
USER_RE = re.compile(r"^[A-Za-z0-9_-]{3,25}$")
CACHE_TTL = 3600
CACHE_MAX = int(os.environ.get("CHESS_CHECK_CACHE_MAX", 32))     # finished analyses kept in memory
MAX_JOBS = int(os.environ.get("CHESS_CHECK_MAX_JOBS", 2))        # analyses allowed to run at once
_cache: OrderedDict[tuple, tuple[float, Analysis]] = OrderedDict()
_inflight: dict[tuple, Future] = {}
_state = threading.Lock()
_jobs = threading.BoundedSemaphore(MAX_JOBS)
# Small hosts (e.g. Render's free tier) set these to keep requests fast.
MAX_GAMES = int(os.environ.get("CHESS_CHECK_MAX_GAMES", 400))
ENGINE_DEPTH = int(os.environ.get("CHESS_CHECK_ENGINE_DEPTH", 10))


class AnalyzeReq(BaseModel):
    username: str
    games: int = Field(150, ge=20, le=400)
    time_class: str | None = Field(None, pattern="^(bullet|blitz|rapid|daily)$")


def _key(r: AnalyzeReq) -> tuple:
    return (r.username.lower(), min(r.games, MAX_GAMES), r.time_class)


def _cached(key: tuple) -> Analysis | None:
    """A fresh cached analysis, dropping expired entries on the way (call with _state held)."""
    now = time.time()
    for k in [k for k, (t, _) in _cache.items() if now - t >= CACHE_TTL]:
        del _cache[k]
    hit = _cache.get(key)
    if hit:
        _cache.move_to_end(key)
    return hit[1] if hit else None


def _get(r: AnalyzeReq) -> Analysis:
    """One analysis per request key: identical requests that arrive while it runs wait for the same
    result, at most MAX_JOBS analyses run at once, and the cache keeps at most CACHE_MAX results."""
    if not USER_RE.match(r.username):
        raise HTTPException(400, "That doesn't look like a Chess.com username.")
    key = _key(r)
    with _state:
        hit = _cached(key)
        if hit is not None:
            return hit
        job = _inflight.get(key)
        owner = job is None
        if owner:
            job = _inflight[key] = Future()
    if not owner:
        return job.result()          # the same result, or the same error, as the request running it
    try:
        with _jobs:
            try:
                a = analyze(r.username, max_games=min(r.games, MAX_GAMES),
                            time_class=r.time_class, depth=ENGINE_DEPTH)
            except ValueError as e:
                raise HTTPException(404, str(e))
        with _state:
            _cache[key] = (time.time(), a)
            _cache.move_to_end(key)
            while len(_cache) > CACHE_MAX:
                _cache.popitem(last=False)
        job.set_result(a)
        return a
    except BaseException as e:
        job.set_exception(e)
        raise
    finally:
        with _state:
            _inflight.pop(key, None)


@app.post("/api/analyze")
async def api_analyze(r: AnalyzeReq):
    a = await run_in_threadpool(_get, r)
    return to_payload(a)


EXAMPLE = WEB / "example_report.json"


def _backend() -> str | None:
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return "api"
    if claude_code_available() and os.environ.get("CHESS_CHECK_DISABLE_CLAUDE_CODE") != "1":
        return "claude-code"
    return None


@app.get("/api/coach/status")
def coach_status():
    return {"backend": _backend(), "example": EXAMPLE.exists()}


@app.post("/api/coach")
async def api_coach(r: AnalyzeReq):
    if _backend() is None:
        raise HTTPException(503, "Live coaching isn't enabled on this server. It runs "
                                 "locally with Claude Code or with an API key.")
    a = await run_in_threadpool(_get, r)
    try:
        res = await run_in_threadpool(lambda: run_coach_auto(a.username, a.facts, a.games, a.moves,
                                                             summaries=a.summaries))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"report": res.report, "verification": res.verification,
            "first_verification": res.first_verification, "repaired": res.repaired,
            "tool_calls": res.tool_calls, "usage": res.usage, "backend": _backend(),
            "facts": [{"id": f["id"], "text": f["text"]} for f in res.facts]}


@app.get("/api/coach/example")
def coach_example():
    if not EXAMPLE.exists():
        raise HTTPException(404, "No example report saved.")
    return json.loads(EXAMPLE.read_text())


@app.get("/api/health")
def health():
    return {"ok": True}


app.mount("/static", StaticFiles(directory=WEB), name="static")


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")
