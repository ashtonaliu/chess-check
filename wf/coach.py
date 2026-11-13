"""Agentic LLM coach, grounded in facts and checked by the verifier.

Context engineering: the model never sees raw PGN. It gets a short list of
pre-computed facts [F#] and three tools; every tool result is registered as a
new fact [T#], so everything the model may say is citable and checkable.

Loop: tool calls until the model finishes -> verify the report -> if any
number, move or link is unsupported, send the verifier's findings back for one
repair turn. A manual loop (not the SDK tool runner) because of that repair
turn after the model has finished.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

import pandas as pd

from .db import SCHEMA_DOC, ReadOnlySQL
from .facts import facts_text
from .verify import feedback, verify

# Haiku 5.5 won the model-choice eval (scripts/eval_models.py): fewest unsupported
# claims in first drafts, clean after repair on every player, about 30x cheaper than
# Opus 5.5. Override with WF_COACH_MODEL.
MODEL = os.environ.get("WF_COACH_MODEL", "claude-haiku-5-5")
# Server-side refusal fallbacks exist for these models only (not Haiku 5.5).
FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1",
                   "claude-opus-5"}
MAX_TOOL_TURNS = 8

SYSTEM = """\
You are a chess coach writing a short, specific report for one player, based on \
an analysis of their recent Chess.com games.

Rules (a program checks your report against them):
- Every number, chess move and link you write must come from a fact [F#] or a \
tool result [T#], and the sentence must cite it, e.g. "... 38% [F3]." Do not \
round differently, convert units or compute new numbers in your head; if you \
need a new number, get it with run_sql and cite the result.
- Write moves exactly as they appear in the facts.
- Only call something a weakness if a fact's verdict says "weakness" or \
"possible weakness", or a model fact shows more blunders than expected. If the \
evidence is thin, say so plainly.
- Order the weaknesses by strength of evidence: a verdict of "pattern" or "weakness" first, \
then "possible weakness" and "worth watching". Within the same strength, put the larger effect first.
- Recommendations should be concrete (what to study, which puzzle theme link) \
but must not invent statistics.

Format (Markdown, under 350 words): a one-sentence summary, then "## Biggest \
weaknesses" with up to 3 items (evidence, then what to do), then \
"## What's working" (1-2 items), then "## Training plan" (3-5 bullet points)."""

def tools_for(dialect: str = "DuckDB") -> list[dict]:
    """The tool list, with run_sql describing the SQL dialect the backend speaks."""
    tools = [dict(t) for t in TOOLS]
    tools[0]["description"] = tools[0]["description"].replace("DuckDB SQL", f"{dialect} SQL", 1)
    return tools


TOOLS = [
    {
        "name": "run_sql",
        "description": (
            "Run a read-only DuckDB SQL query (SELECT/WITH only) over the player's "
            "games and engine-analysed moves. Use it to drill into a weakness, e.g. "
            "results by time class, or blunders by phase in one opening. Write SQL for "
            "this dialect only. Returns CSV, at most 50 rows. Tables:\n" + SCHEMA_DOC),
        "input_schema": {"type": "object", "additionalProperties": False,
                         "properties": {"query": {"type": "string",
                                                  "description": "The SQL query."}},
                         "required": ["query"]},
        "strict": True,
    },
    {
        "name": "example_games",
        "description": (
            "Retrieve the player's worst-scoring games (relative to rating "
            "expectation) in one opening family and color, with links and first "
            "moves, to use as concrete examples."),
        "input_schema": {"type": "object", "additionalProperties": False,
                         "properties": {
                             "family": {"type": "string",
                                        "description": "Opening family exactly as in the facts."},
                             "color": {"type": "string", "enum": ["white", "black"]},
                             "k": {"type": "integer", "description": "How many games (1-5)."}},
                         "required": ["family", "color", "k"]},
        "strict": True,
    },
    {
        "name": "search_games",
        "description": (
            "Search the player's games by meaning: each game has a plain-English summary "
            "(result and how it ended, opening, rating gap, eval after the opening, the "
            "worst mistake with phase and clock, blunder count), ranked by a hybrid of "
            "sentence embeddings and keyword matching. Use it for descriptive questions "
            "such as 'games where I collapsed in time trouble' to find concrete examples. "
            "For exact filters (a specific result, opening or rating) prefer run_sql. "
            "Returns the top k summaries with links."),
        "input_schema": {"type": "object", "additionalProperties": False,
                         "properties": {"query": {"type": "string",
                                                  "description": "What to look for, in plain English."},
                                        "k": {"type": "integer", "description": "How many games (1-8)."}},
                         "required": ["query", "k"]},
        "strict": True,
    },
    {
        "name": "engine_eval",
        "description": "Stockfish evaluation and best move for a FEN position.",
        "input_schema": {"type": "object", "additionalProperties": False,
                         "properties": {"fen": {"type": "string"}},
                         "required": ["fen"]},
        "strict": True,
    },
]


@dataclass
class CoachResult:
    report: str
    verification: dict
    first_verification: dict
    facts: list[dict]
    tool_calls: list[dict] = field(default_factory=list)
    repaired: bool = False
    usage: dict = field(default_factory=dict)
    first_report: str = ""


class ToolBox:
    def __init__(self, games: pd.DataFrame, moves: pd.DataFrame | None,
                 facts: list[dict], summaries: list[tuple[str, str]] | None = None):
        self.games = games
        self.summaries = summaries or []
        self._index = None
        from . import mysql_store
        if mysql_store.enabled():
            self.sql = mysql_store.MySQLReadOnlySQL(mysql_store.load(games, moves))
        else:
            self.sql = ReadOnlySQL(games, moves)
        self.facts = facts
        self.calls: list[dict] = []

    def _register(self, text: str) -> str:
        tid = f"T{sum(f['id'].startswith('T') for f in self.facts) + 1}"
        self.facts.append({"id": tid, "kind": "tool", "text": text})
        return f"[{tid}]\n{text}"

    def run(self, name: str, args: dict) -> tuple[str, bool]:
        self.calls.append({"name": name, "input": args})
        try:
            if name == "run_sql":
                out = self.sql.run(args["query"])
                if out.startswith(("Error", "SQL error")):
                    return out, True
                return self._register(f"Query: {args['query']}\nResult:\n{out}"), False
            if name == "example_games":
                return self._register(self._examples(**args)), False
            if name == "search_games":
                return self._register(self._search(args["query"], int(args.get("k", 5)))), False
            if name == "engine_eval":
                return self._register(_engine_eval(args["fen"])), False
            return f"Unknown tool {name}", True
        except Exception as e:
            return f"Tool error: {e}", True

    def _search(self, query: str, k: int) -> str:
        if not self.summaries:
            return "No game summaries are available (engine analysis was skipped)."
        if self._index is None:
            from .search import GameIndex
            self._index = GameIndex.from_texts([u for u, _ in self.summaries],
                                               [t for _, t in self.summaries])
        hits = self._index.search(query, max(1, min(k, 8)), "hybrid")
        lines = [f"Games best matching '{query}' (hybrid search over game summaries):"]
        for i, _ in hits:
            lines.append(f"- {self._index.urls[i]}: {self._index.texts[i]}")
        return "\n".join(lines)

    def _examples(self, family: str, color: str, k: int) -> str:
        from .stats import format_moves
        sub = self.games[(self.games.family == family) & (self.games.color == color)]
        if sub.empty:
            return f"No games found for {family} as {color}."
        rows = sub.sort_values("residual").head(max(1, min(int(k), 5)))
        lines = [f"Worst {family} games as {color}:"]
        for r in rows.itertuples():
            res = {1.0: "won", 0.5: "drew", 0.0: "lost"}[r.score]
            lines.append(f"- {r.url}: you {res} ({r.my_rating} vs {r.opp_rating}), "
                         f"{r.opening}; {format_moves(' '.join(r.moves.split()[:12]))}")
        return "\n".join(lines)


def _engine_eval(fen: str) -> str:
    import chess
    import chess.engine

    from .engine import find_stockfish

    board = chess.Board(fen)
    with chess.engine.SimpleEngine.popen_uci(find_stockfish()) as eng:
        info = eng.analyse(board, chess.engine.Limit(depth=16))
    cp = info["score"].pov(board.turn).score(mate_score=3000)
    best = board.san(info["pv"][0]) if info.get("pv") else "none"
    side = "White" if board.turn else "Black"
    return f"Position {fen}: {side} to move, eval {cp / 100:+.1f} pawns for {side}, best move {best}."


def _client():
    import anthropic
    return anthropic.Anthropic()


def _call(client, messages, tools=None):
    extra = ({"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
             if MODEL in FALLBACK_MODELS else {})
    return client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM,
        tools=tools or TOOLS,
        messages=messages,
        output_config={"effort": "medium"},
        **extra,
    )


def _text(resp) -> str:
    return "".join(b.text for b in resp.content if b.type == "text").strip()


def _agent_turns(client, messages, box: ToolBox, usage: dict):
    """Run until the model stops calling tools; returns the final response."""
    for _ in range(MAX_TOOL_TURNS + 1):
        resp = _call(client, messages, tools_for(box.sql.dialect))
        for k in ("input_tokens", "output_tokens"):
            usage[k] = usage.get(k, 0) + getattr(resp.usage, k, 0)
        if resp.stop_reason == "refusal":
            raise RuntimeError("The model declined to write this report.")
        messages.append({"role": "assistant", "content": resp.content})
        if resp.stop_reason == "pause_turn":
            continue
        uses = [b for b in resp.content if b.type == "tool_use"]
        if resp.stop_reason != "tool_use" or not uses:
            return resp
        results = []
        for u in uses:
            out, is_err = box.run(u.name, dict(u.input))
            results.append({"type": "tool_result", "tool_use_id": u.id,
                            "content": out, "is_error": is_err})
        messages.append({"role": "user", "content": results})
    raise RuntimeError("Coach used too many tool calls.")


def run_coach(username: str, facts: list[dict], games: pd.DataFrame,
              moves: pd.DataFrame | None, client=None, repair: bool = True,
              summaries: list[tuple[str, str]] | None = None) -> CoachResult:
    client = client or _client()
    facts = [dict(f) for f in facts]  # tool results get appended
    box = ToolBox(games, moves, facts, summaries)
    usage: dict = {}
    messages = [{"role": "user", "content":
                 f"Player: {username}\n\nFacts:\n{facts_text(facts)}\n\n"
                 "Write the report. Use the tools if a weakness needs more detail."}]
    resp = _agent_turns(client, messages, box, usage)
    report = first_report = _text(resp)
    first = verify(report, box.facts)
    final, repaired = first, False
    if repair and not first["ok"]:
        messages.append({"role": "user", "content":
                         "A checker found claims in your report that are not supported "
                         "by any fact or tool result:\n" + feedback(first) +
                         "\n\nRewrite the full report fixing only these. Remove a claim "
                         "rather than guess, or look it up with a tool and cite it."})
        resp = _agent_turns(client, messages, box, usage)
        report = _text(resp)
        final, repaired = verify(report, box.facts), True
    return CoachResult(report=report, verification=final, first_verification=first,
                       facts=box.facts, tool_calls=box.calls, repaired=repaired,
                       usage=usage, first_report=first_report)


def to_json(r: CoachResult) -> str:
    return json.dumps({"report": r.report, "verification": r.verification,
                       "first_verification": r.first_verification,
                       "repaired": r.repaired, "tool_calls": r.tool_calls,
                       "usage": r.usage}, default=str)
