"""End-to-end analysis for one player: fetch -> SQL -> stats -> engine -> model -> facts."""
from __future__ import annotations

import math
from dataclasses import dataclass

import pandas as pd

from . import db, engine, model
from .facts import build_facts
from .fetch import fetch_games
from .stats import format_moves, games_frame, worst_branch


@dataclass
class Analysis:
    username: str
    games: pd.DataFrame
    moves: pd.DataFrame | None
    analyses: list[dict] | None
    table: pd.DataFrame
    risk: dict | None
    facts: list[dict]
    extras: dict
    summaries: list[tuple[str, str]]   # (url, plain-English summary) for search_games


def analyze(username: str, max_games: int = 150, time_class: str | None = None,
            depth: int = 10, use_engine: bool = True, progress=None) -> Analysis:
    tcs = {time_class} if time_class else None
    games = fetch_games(username, max_games=max_games, time_classes=tcs)
    if len(games) < 5:
        raise ValueError(f"Only {len(games)} standard games found for {username!r}.")
    df = games_frame(games)
    analyses = moves = risk = None
    if use_engine and engine.find_stockfish():
        analyses = engine.analyse_games(games, depth=depth, progress=progress)
        moves = db.moves_frame(analyses)
        try:
            risk = model.player_risk(moves)
        except ValueError:
            risk = None
    facts, extras = build_facts(df, analyses, risk)
    from .search import summarize
    by_url = {a["url"]: a for a in analyses or []}
    summaries = [(g.url, summarize(g, by_url.get(g.url))) for g in games]
    return Analysis(username, df, moves, analyses, extras.get("table", pd.DataFrame()),
                    risk, facts, extras, summaries)


def _clean(x):
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    return x


def to_payload(a: Analysis) -> dict:
    """JSON-safe summary for the web UI."""
    from .stats import overall
    t = a.table
    openings = []
    if not t.empty:
        for r in t.itertuples():
            b = worst_branch(a.games, r.color, r.family) \
                if (r.verdict.endswith("weakness") or r.verdict == "worth watching") else None
            openings.append({
                "color": r.color, "family": r.family, "n": int(r.n),
                "score": r.score, "expected": r.expected,
                "raw": r.mean_resid, "shrunk": r.shrunk,
                "ci_low": r.ci_low, "ci_high": r.ci_high,
                "p_below": r.p_below, "verdict": r.verdict,
                "branch": None if not b else {
                    "moves": format_moves(b["moves"]), "n": b["n"],
                    "score": b["score"], "expected": b["expected"]},
            })
    phases, blunders = None, []
    if a.analyses:
        phases = engine.phase_summary(a.analyses)
        from .facts import move_label
        for m in engine.worst_blunders(a.analyses, 5):
            if m["wp_loss"] >= engine.BLUNDER_DROP:
                blunders.append({"move": move_label(m), "best": m["best"],
                                 "loss": m["wp_loss"], "phase": m["phase"],
                                 "url": m["url"], "fen": m["fen"]})
    o = overall(a.games)
    payload = {
        "username": a.username,
        "overall": {k: _clean(v) for k, v in o.items()},
        "openings": [{k: _clean(v) for k, v in row.items()} for row in openings],
        "phases": phases, "blunders": blunders, "risk": a.risk,
        "facts": [{"id": f["id"], "text": f["text"]} for f in a.facts],
        "engine": a.analyses is not None,
    }
    return payload
