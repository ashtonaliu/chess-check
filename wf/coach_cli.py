"""Coach backend that runs through the Claude Code CLI (`claude -p`).

Same prompt, tools, verifier and repair turn as the API backend in coach.py,
but billed to the user's Claude subscription instead of an API key, so it
only works where Claude Code is installed and logged in (i.e. locally).

- tools are served by wf.mcp_server over MCP (stdio), restricted with
  --strict-mcp-config / --allowedTools; all built-in tools are disabled
- the repair turn resumes the same session with the verifier's findings
"""
from __future__ import annotations

import json
import os
import pickle
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pandas as pd

from .coach import MODEL, SYSTEM, CoachResult
from .facts import facts_text
from .verify import feedback, verify

ROOT = Path(__file__).resolve().parents[1]
TOOL_NAMES = ["mcp__wf__run_sql", "mcp__wf__example_games", "mcp__wf__search_games",
              "mcp__wf__engine_eval"]
TIMEOUT = 600


def available() -> bool:
    return shutil.which("claude") is not None


def _parse(stdout: str) -> dict:
    """The JSON result line. Newer models can be preceded by a CLI warning line
    (e.g. "[claude-code:unrecognized_model]" on CLI versions older than the model)."""
    for line in reversed(stdout.splitlines()):
        if line.startswith("{"):
            return json.loads(line)
    raise json.JSONDecodeError("no JSON result line", stdout, 0)


def _claude(prompt: str, state: Path, resume: str | None = None, model: str = MODEL) -> dict:
    cfg = {"mcpServers": {"wf": {
        "command": sys.executable, "args": ["-m", "wf.mcp_server", str(state)],
        # the tool server is a separate process: pass through engine and SQL-backend settings
        "env": {"PYTHONPATH": str(ROOT), **{k: v for k, v in os.environ.items()
                                            if k in ("STOCKFISH_PATH", "WF_SQL_BACKEND",
                                                     "WF_MYSQL_WRITER_URL", "WF_MYSQL_READER_URL")}},
    }}}
    (state / "mcp.json").write_text(json.dumps(cfg))
    cmd = ["claude", "-p", prompt, "--output-format", "json",
           "--model", model, "--effort", "medium",
           "--system-prompt", SYSTEM.replace("run_sql", "the run_sql tool"),
           "--tools", "",
           "--mcp-config", str(state / "mcp.json"), "--strict-mcp-config",
           "--allowedTools", *TOOL_NAMES,
           "--setting-sources", ""]
    if resume:
        cmd += ["--resume", resume]
    env = {k: v for k, v in os.environ.items()
           if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}  # use the subscription
    proc = subprocess.run(cmd, cwd=state, env=env, capture_output=True, text=True,
                          timeout=TIMEOUT)
    try:
        out = _parse(proc.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"Claude Code failed: {(proc.stderr or proc.stdout)[-500:]}")
    if out.get("is_error"):
        raise RuntimeError(f"Claude Code error: {out.get('result') or out}")
    return out


def complete(prompt: str, effort: str = "medium") -> str:
    """Plain one-shot completion through Claude Code: no tools, no MCP."""
    with tempfile.TemporaryDirectory(prefix="wf-plain-") as d:
        env = {k: v for k, v in os.environ.items()
               if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
        proc = subprocess.run(
            ["claude", "-p", prompt, "--output-format", "json", "--model", MODEL,
             "--effort", effort, "--tools", "", "--strict-mcp-config",
             "--setting-sources", ""],
            cwd=d, env=env, capture_output=True, text=True, timeout=TIMEOUT)
    out = _parse(proc.stdout)
    if out.get("is_error"):
        raise RuntimeError(f"Claude Code error: {out.get('result')}")
    return out.get("result") or ""


def _facts_now(state: Path, base: list[dict]) -> list[dict]:
    p = state / "tool_facts.jsonl"
    extra = [json.loads(line) for line in p.read_text().splitlines() if line] if p.exists() else []
    return base + extra


def _cost(out: dict) -> dict:
    """List-price cost, tokens and API time of one CLI call (as reported by Claude Code)."""
    mu = out.get("modelUsage") or {}
    return {"cost_usd": sum(v.get("costUSD", 0) for v in mu.values()),
            "input_tokens": sum(v.get("inputTokens", 0) + v.get("cacheReadInputTokens", 0)
                                + v.get("cacheCreationInputTokens", 0) for v in mu.values()),
            "output_tokens": sum(v.get("outputTokens", 0) for v in mu.values()),
            "api_ms": out.get("duration_api_ms", 0), "models": sorted(mu)}


def run_coach_cli(username: str, facts: list[dict], games: pd.DataFrame,
                  moves: pd.DataFrame | None, repair: bool = True,
                  keep_state: bool = False,
                  summaries: list[tuple[str, str]] | None = None,
                  model: str = MODEL) -> CoachResult:
    state = Path(tempfile.mkdtemp(prefix="wf-coach-"))
    try:
        (state / "games.pkl").write_bytes(pickle.dumps(games))
        if moves is not None:
            (state / "moves.pkl").write_bytes(pickle.dumps(moves))
        (state / "summaries.json").write_text(json.dumps(summaries or []))
        (state / "facts.json").write_text(json.dumps(
            [{k: v for k, v in f.items() if isinstance(v, (str, int, float))} for f in facts]))
        prompt = (f"Player: {username}\n\nFacts:\n{facts_text(facts)}\n\n"
                  "Write the report. Use the tools if a weakness needs more detail. "
                  "Reply with only the report in Markdown.")
        out = _claude(prompt, state, model=model)
        spend = _cost(out)
        report = first_report = (out.get("result") or "").strip()
        first = verify(report, _facts_now(state, facts))
        final, repaired, turns = first, False, out.get("num_turns", 0)
        if repair and not first["ok"]:
            fix = ("A checker found claims in your report that are not supported by any "
                   "fact or tool result:\n" + feedback(first) +
                   "\n\nRewrite the full report fixing only these. Remove a claim rather "
                   "than guess, or look it up with a tool and cite it. Reply with only the report.")
            out = _claude(fix, state, resume=out["session_id"], model=model)
            more = _cost(out)
            for k in ("cost_usd", "input_tokens", "output_tokens", "api_ms"):
                spend[k] += more[k]
            spend["models"] = sorted(set(spend["models"]) | set(more["models"]))
            report = (out.get("result") or "").strip()
            final, repaired = verify(report, _facts_now(state, facts)), True
            turns += out.get("num_turns", 0)
        all_facts = _facts_now(state, facts)
        calls_p = state / "tool_calls.jsonl"
        calls = [json.loads(line) for line in calls_p.read_text().splitlines() if line] \
            if calls_p.exists() else []
        return CoachResult(report=report, verification=final, first_verification=first,
                           facts=all_facts, tool_calls=calls, repaired=repaired,
                           usage={"backend": "claude-code", "turns": turns, "model": model, **spend},
                           first_report=first_report)
    finally:
        if not keep_state:
            shutil.rmtree(state, ignore_errors=True)


def run_coach_auto(username, facts, games, moves, **kw) -> CoachResult:
    """API key if configured, otherwise the local Claude Code CLI."""
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        from .coach import run_coach
        return run_coach(username, facts, games, moves, **kw)
    if available():
        return run_coach_cli(username, facts, games, moves, **kw)
    raise RuntimeError("No coach backend: set ANTHROPIC_API_KEY or install Claude Code.")
