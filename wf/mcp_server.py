"""MCP server exposing the coach's tools to Claude Code.

    python -m wf.mcp_server STATE_DIR

STATE_DIR holds the analysis written by coach_cli (games.pkl, moves.pkl,
facts.json). Every tool result is registered as a citable fact [T#] and
appended to STATE_DIR/tool_facts.jsonl, so the verifier sees exactly what
the model saw. Numbering continues across restarts (each `--resume` starts a
fresh server process).
"""
from __future__ import annotations

import json
import pickle
import sys
from pathlib import Path

from mcp.server.mcpserver import MCPServer

from .coach import ToolBox, tools_for

STATE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
TOOL_FACTS = STATE / "tool_facts.jsonl"


def _load_box() -> ToolBox:
    games = pickle.loads((STATE / "games.pkl").read_bytes())
    moves_path = STATE / "moves.pkl"
    moves = pickle.loads(moves_path.read_bytes()) if moves_path.exists() else None
    facts = json.loads((STATE / "facts.json").read_text())
    if TOOL_FACTS.exists():
        facts += [json.loads(line) for line in TOOL_FACTS.read_text().splitlines() if line]
    summ_path = STATE / "summaries.json"
    summaries = [tuple(x) for x in json.loads(summ_path.read_text())] if summ_path.exists() else []
    return ToolBox(games, moves, facts, summaries)


box = _load_box()
server = MCPServer(name="weakness-finder",
                   instructions="Tools over one chess player's analysed games.")
DESC = {t["name"]: t["description"] for t in tools_for(box.sql.dialect)}


def _call(name: str, args: dict) -> str:
    before = len(box.facts)
    out, is_err = box.run(name, args)
    new = box.facts[before:]
    if new:
        with TOOL_FACTS.open("a") as f:
            for fact in new:
                f.write(json.dumps(fact) + "\n")
    with (STATE / "tool_calls.jsonl").open("a") as f:
        f.write(json.dumps({"name": name, "input": args, "error": is_err}) + "\n")
    return out


@server.tool(name="run_sql", description=DESC["run_sql"])
def run_sql(query: str) -> str:
    return _call("run_sql", {"query": query})


@server.tool(name="example_games", description=DESC["example_games"])
def example_games(family: str, color: str, k: int = 3) -> str:
    return _call("example_games", {"family": family, "color": color, "k": k})


@server.tool(name="search_games", description=DESC["search_games"])
def search_games(query: str, k: int = 5) -> str:
    return _call("search_games", {"query": query, "k": k})


@server.tool(name="engine_eval", description=DESC["engine_eval"])
def engine_eval(fen: str) -> str:
    return _call("engine_eval", {"fen": fen})


if __name__ == "__main__":
    server.run("stdio")
