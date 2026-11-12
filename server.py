"""FastAPI backend: serves the TypeScript UI and the analysis/coach API.

Run locally:  uvicorn server:app --reload
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from wf.coach import run_coach
from wf.pipeline import Analysis, analyze, to_payload

app = FastAPI(title="Weakness Finder")
WEB = Path(__file__).parent / "web"
USER_RE = re.compile(r"^[A-Za-z0-9_-]{3,25}$")
_cache: dict[tuple, tuple[float, Analysis]] = {}
CACHE_TTL = 3600


class AnalyzeReq(BaseModel):
    username: str
    games: int = Field(150, ge=20, le=400)
    time_class: str | None = Field(None, pattern="^(bullet|blitz|rapid|daily)$")


def _key(r: AnalyzeReq) -> tuple:
    return (r.username.lower(), r.games, r.time_class)


def _get(r: AnalyzeReq) -> Analysis:
    if not USER_RE.match(r.username):
        raise HTTPException(400, "That doesn't look like a Chess.com username.")
    hit = _cache.get(_key(r))
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    try:
        a = analyze(r.username, max_games=r.games, time_class=r.time_class)
    except ValueError as e:
        raise HTTPException(404, str(e))
    _cache[_key(r)] = (time.time(), a)
    return a


@app.post("/api/analyze")
async def api_analyze(r: AnalyzeReq):
    a = await run_in_threadpool(_get, r)
    return to_payload(a)


@app.post("/api/coach")
async def api_coach(r: AnalyzeReq):
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise HTTPException(503, "The coach needs ANTHROPIC_API_KEY set on the server.")
    a = await run_in_threadpool(_get, r)
    res = await run_in_threadpool(run_coach, a.username, a.facts, a.games, a.moves)
    return {"report": res.report, "verification": res.verification,
            "first_verification": res.first_verification, "repaired": res.repaired,
            "tool_calls": res.tool_calls, "usage": res.usage,
            "facts": [{"id": f["id"], "text": f["text"]} for f in res.facts]}


@app.get("/api/health")
def health():
    return {"ok": True}


app.mount("/static", StaticFiles(directory=WEB), name="static")


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")
