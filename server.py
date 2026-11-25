"""FastAPI backend: serves the TypeScript UI and the analysis/coach API.

Run locally:  uvicorn server:app --reload
"""
from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import secrets
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from chesscheck.coach import CoachError
from chesscheck.coach_cli import available as claude_code_available, run_coach_auto
from chesscheck.env import load_env
from chesscheck.lichess import LichessRateLimitError
from chesscheck.pipeline import Analysis, analyze, to_payload

log = logging.getLogger(__name__)

load_env()

app = FastAPI(title="Chess Check")
WEB = Path(__file__).parent / "web"
USER_RE = re.compile(r"\A[A-Za-z0-9_-]{3,25}\Z")
LICHESS_USER_RE = re.compile(r"\A[A-Za-z0-9_-]{2,20}\Z")
CHESSCOM_TIME_CLASSES = {"bullet", "blitz", "rapid", "daily"}
LICHESS_TIME_CLASSES = {"ultraBullet", "bullet", "blitz", "rapid", "classical", "daily"}
CACHE_TTL = 3600
CACHE_MAX = int(os.environ.get("CHESS_CHECK_CACHE_MAX", 32))     # finished analyses kept in memory
MAX_JOBS = int(os.environ.get("CHESS_CHECK_MAX_JOBS", 2))        # analyses allowed to run at once
_cache: OrderedDict[tuple, tuple[float, Analysis]] = OrderedDict()
_inflight: dict[tuple, Future] = {}
_state = threading.Lock()
_jobs = threading.BoundedSemaphore(MAX_JOBS)
_coach_jobs = threading.BoundedSemaphore(max(1, int(os.environ.get("CHESS_CHECK_MAX_COACH_JOBS", 1))))
# Small hosts (e.g. Render's free tier) set these to keep requests fast.
MAX_GAMES = int(os.environ.get("CHESS_CHECK_MAX_GAMES", 400))
ENGINE_DEPTH = int(os.environ.get("CHESS_CHECK_ENGINE_DEPTH", 10))


class AnalyzeReq(BaseModel):
    username: str
    games: int = Field(150, ge=20, le=400)
    time_class: str | None = None
    site: Literal["chesscom", "lichess"] = "chesscom"

    @model_validator(mode="after")
    def _check_time_class(self) -> "AnalyzeReq":
        if self.time_class is None:
            return self
        allowed = LICHESS_TIME_CLASSES if self.site == "lichess" else CHESSCOM_TIME_CLASSES
        if self.time_class not in allowed:
            raise ValueError(f"Unsupported time_class {self.time_class!r} for {self.site}")
        return self


def _key(r: AnalyzeReq) -> tuple:
    return (r.username.lower(), min(r.games, MAX_GAMES), r.time_class, r.site)


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
    if r.site == "lichess":
        if not LICHESS_USER_RE.fullmatch(r.username):
            raise HTTPException(400, "That doesn't look like a Lichess username.")
    elif not USER_RE.fullmatch(r.username):
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
                kwargs = {"max_games": min(r.games, MAX_GAMES),
                          "time_class": r.time_class, "depth": ENGINE_DEPTH}
                if r.site != "chesscom":
                    kwargs["site"] = r.site
                a = analyze(r.username, **kwargs)
            except LichessRateLimitError as e:
                raise HTTPException(429, str(e), headers={"Retry-After": "60"}) from e
            except ValueError as e:
                raise HTTPException(404, str(e)) from e
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


def _coach_access(request: Request) -> str | None:
    if os.environ.get("CHESS_CHECK_COACH_TOKEN"):
        return "token"
    if os.environ.get("CHESS_CHECK_LOCAL_COACH") == "1" and request.client:
        try:
            if ipaddress.ip_address(request.client.host).is_loopback:
                return "local"
        except ValueError:
            pass
    return None


@app.get("/api/coach/status")
def coach_status(request: Request):
    access = _coach_access(request)
    backend = _backend() if access else None
    return {"backend": backend, "example": EXAMPLE.exists(), "token_required": bool(backend and access == "token")}


@app.post("/api/coach")
async def api_coach(r: AnalyzeReq, request: Request):
    access = _coach_access(request)
    if access is None:
        raise HTTPException(403, "Live coaching is disabled for this client.")
    if access == "token":
        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        expected = os.environ["CHESS_CHECK_COACH_TOKEN"]
        if scheme.lower() != "bearer" or not secrets.compare_digest(token.encode(), expected.encode()):
            raise HTTPException(401, "A valid coaching access token is required.",
                                headers={"WWW-Authenticate": "Bearer"})
    backend = _backend()
    if backend is None:
        raise HTTPException(503, "Live coaching needs a configured model provider.")
    if not _coach_jobs.acquire(blocking=False):
        raise HTTPException(429, "The coach is busy. Try again shortly.", headers={"Retry-After": "5"})
    try:
        a = await run_in_threadpool(_get, r)
        coach_kw = {"summaries": a.summaries}
        if getattr(a, "site", "chesscom") != "chesscom":
            coach_kw["site"] = a.site
        res = await run_in_threadpool(lambda: run_coach_auto(a.username, a.facts, a.games, a.moves,
                                                             **coach_kw))
    except HTTPException:
        raise
    except CoachError as e:
        raise HTTPException(502, str(e)) from e
    except Exception:
        # Provider errors can carry Claude Code output, local paths or request details, so they go
        # to the server log and the client gets a generic message.
        log.exception("Coaching failed for %s", r.username)
        raise HTTPException(502, "The coaching provider failed. Try again shortly.") from None
    finally:
        _coach_jobs.release()
    return {"report": res.report, "verification": res.verification,
            "first_verification": res.first_verification, "repaired": res.repaired,
            "tool_calls": res.tool_calls, "usage": res.usage, "backend": backend,
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
