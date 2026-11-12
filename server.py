"""FastAPI backend: serves the TypeScript UI and the analysis/coach API.

Run locally:  uvicorn server:app --reload
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from wf.coach_cli import available as claude_code_available, run_coach_auto
from wf.env import load_env
from wf.pipeline import Analysis, analyze, to_payload

load_env()

app = FastAPI(title="Weakness Finder")
WEB = Path(__file__).parent / "web"
USER_RE = re.compile(r"^[A-Za-z0-9_-]{3,25}$")
_cache: dict[tuple, tuple[float, Analysis]] = {}
CACHE_TTL = 3600
# Small hosts (e.g. Render's free tier) set these to keep requests fast.
MAX_GAMES = int(os.environ.get("WF_MAX_GAMES", 400))
ENGINE_DEPTH = int(os.environ.get("WF_ENGINE_DEPTH", 10))


class AnalyzeReq(BaseModel):
    username: str
    games: int = Field(150, ge=20, le=400)
    time_class: str | None = Field(None, pattern="^(bullet|blitz|rapid|daily)$")


def _key(r: AnalyzeReq) -> tuple:
    return (r.username.lower(), min(r.games, MAX_GAMES), r.time_class)


def _get(r: AnalyzeReq) -> Analysis:
    if not USER_RE.match(r.username):
        raise HTTPException(400, "That doesn't look like a Chess.com username.")
    hit = _cache.get(_key(r))
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    try:
        a = analyze(r.username, max_games=min(r.games, MAX_GAMES),
                    time_class=r.time_class, depth=ENGINE_DEPTH)
    except ValueError as e:
        raise HTTPException(404, str(e))
    _cache[_key(r)] = (time.time(), a)
    return a


@app.post("/api/analyze")
async def api_analyze(r: AnalyzeReq):
    a = await run_in_threadpool(_get, r)
    return to_payload(a)


EXAMPLE = WEB / "example_report.json"


def _backend() -> str | None:
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return "api"
    if claude_code_available() and os.environ.get("WF_DISABLE_CLAUDE_CODE") != "1":
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
        res = await run_in_threadpool(run_coach_auto, a.username, a.facts, a.games, a.moves)
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
