"""Turn the analysis into a numbered list of facts.

The LLM coach may only state things that appear in these facts, and must cite
them as [F3]. Every fact is a plain sentence, so the verifier can check the
coach's numbers and moves against them.
"""
from __future__ import annotations

import pandas as pd

from . import engine as eng
from .stats import format_moves, opening_table, overall, pct, verdict, worst_branch

PHASE_THEMES = {
    "opening": ("opening", "https://lichess.org/training/opening"),
    "middlegame": ("middlegame", "https://lichess.org/training/middlegame"),
    "endgame": ("endgame", "https://lichess.org/training/endgame"),
    "blunders": ("hanging piece", "https://lichess.org/training/hangingPiece"),
}


def _pts(x: float) -> str:
    """Score residual as signed percentage points."""
    v = round(100 * x)
    return f"+{v}" if v > 0 else str(v)


def _pawns(cp: float) -> str:
    v = cp / 100
    return f"{v:+.1f}"


def _side(color: str) -> str:
    return "as White" if color == "white" else "as Black"


def move_label(m: dict) -> str:
    return f"{m['move_no']}.{m['san']}" if m["ply"] % 2 == 0 \
        else f"{m['move_no']}...{m['san']}"


def build_facts(df: pd.DataFrame, analyses: list[dict] | None = None,
                risk: dict | None = None) -> tuple[list[dict], dict]:
    facts: list[dict] = []
    extras: dict = {}

    def add(kind: str, text: str, **data):
        fid = f"F{len(facts) + 1}"
        facts.append({"id": fid, "kind": kind, "text": text, **data})
        return fid

    o = overall(df)
    add("overall",
        f"Across {o['games']} games (average rating {o['avg_rating']}), you "
        f"scored {pct(o['score'])} versus {pct(o['expected'])} expected from "
        f"ratings ({_pts(o['resid'])} points).")

    if risk:
        add("model",
            f"A blunder-risk model trained on every move in these games (yours "
            f"and your opponents') expected {risk['expected']:.1f} blunders in "
            f"your {risk['moves']} moves given how hard the positions were; you "
            f"made {risk['actual']}, {risk['ratio']:.2f} times the expected count.")
        for b in risk["buckets"]:
            add("model",
                f"With {b['label']}, you made {b['actual']} blunders in "
                f"{b['moves']} moves versus {b['expected']:.1f} expected "
                f"({b['ratio']:.2f} times expected).")

    table = opening_table(df)
    extras["table"] = table
    if not table.empty:
        table = table.assign(verdict=[verdict(r) for r in table.itertuples()])
        extras["table"] = table
        weak = table[table.verdict.isin(["weakness", "possible weakness"])].head(3)
        strong = table[table.verdict.isin(["strength", "possible strength"])] \
            .sort_values("shrunk", ascending=False).head(2)
        for r in pd.concat([weak, strong]).itertuples():
            add("opening",
                f"{r.family} {_side(r.color)}: {r.n} games, scored "
                f"{pct(r.score)} versus {pct(r.expected)} expected. "
                f"Rating-adjusted gap after shrinkage: {_pts(r.shrunk)} points "
                f"(90% interval {_pts(r.ci_low)} to {_pts(r.ci_high)}). "
                f"Verdict: {r.verdict}.",
                color=r.color, family=r.family)
            b = worst_branch(df, r.color, r.family)
            if b and r.verdict.endswith("weakness"):
                add("branch",
                    f"In the {r.family} {_side(r.color)}, after "
                    f"{format_moves(b['moves'])} you scored {pct(b['score'])} "
                    f"in {b['n']} games versus {pct(b['expected'])} expected.",
                    color=r.color, family=r.family)
        if weak.empty:
            add("opening",
                "No opening family shows a weakness that is clear after "
                "adjusting for opponent rating and sample size.")

    if analyses:
        ps = eng.phase_summary(analyses)
        for p, s in ps.items():
            if s["moves"]:
                add("phase",
                    f"In the {p} you lose an average of {s['avg_loss']:.1f} "
                    f"win% per move, with a blunder (a drop of "
                    f"{int(eng.BLUNDER_DROP)} win% or more) on "
                    f"{100 * s['blunder_rate']:.1f}% of moves "
                    f"({s['moves']} moves analysed).", phase=p)
        worst_phase = max((p for p in ps if ps[p]["moves"]),
                          key=lambda p: ps[p]["avg_loss"], default=None)
        extras["worst_phase"] = worst_phase

        all_urls = {a["url"] for a in analyses}
        base = eng.opening_exit(analyses, all_urls)
        for f in [f for f in facts if f["kind"] == "opening" and "family" in f]:
            urls = set(df[(df.color == f["color"]) &
                          (df.family == f["family"])].url) & all_urls
            ex = eng.opening_exit(analyses, urls)
            if ex and base and ex["games"] >= 3:
                add("exit",
                    f"In your {f['family']} games {_side(f['color'])}, the "
                    f"engine eval after move 12 averaged "
                    f"{_pawns(ex['avg_eval_after_12'])} pawns for you; in moves "
                    f"13-25 you lost {ex['avg_loss_13_25']:.1f} win% per move, "
                    f"versus {base['avg_loss_13_25']:.1f} across all your games.",
                    color=f["color"], family=f["family"])

        for m in eng.worst_blunders(analyses, 3):
            if m["wp_loss"] < eng.BLUNDER_DROP:
                break
            best = f"; the engine preferred {m['best']}" if m.get("best") else ""
            add("blunder",
                f"Your move {move_label(m)} ({m['phase']}) lost {m['wp_loss']:.0f} "
                f"win%{best}. Game: {m['url']}", fen=m["fen"])

        themes = []
        if worst_phase:
            themes.append(worst_phase)
        if any(m["wp_loss"] >= eng.BLUNDER_DROP for a in analyses for m in a["moves"]):
            themes.append("blunders")
        for t in themes:
            name, url = PHASE_THEMES[t]
            add("puzzles", f"Lichess puzzle theme '{name}': {url}")

    return facts, extras


def facts_text(facts: list[dict]) -> str:
    return "\n".join(f"[{f['id']}] {f['text']}" for f in facts)
