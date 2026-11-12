"""Hallucination eval for the coach.

For each player, three conditions are scored by the same verifier:
  raw      - the model reads 30 raw PGNs and writes the report (no facts, no
             tools); its numbers and moves are checked against the computed facts
  grounded - facts + tools, first draft (before the repair turn)
  repaired - the final report after the verifier's feedback

Metric: unsupported claims / claims checked, and the share of reports with
zero unsupported claims. Calls the Claude API (about 3-6 requests per
player), so it costs money; start with 3-5 players.

  python scripts/eval_coach.py player1 player2 player3 --games 120
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wf import coach  # noqa: E402
from wf.pipeline import analyze  # noqa: E402
from wf.verify import verify  # noqa: E402

RAW_PROMPT = """You are a chess coach. Below are {n} recent games by the Chess.com \
player {user} (they are {colors}). Write a short report (under 350 words) on their \
biggest weaknesses with evidence and a training plan.

{pgns}"""


def strip_pgn(pgn: str) -> str:
    import re
    pgn = re.sub(r"\{[^}]*\}", "", pgn)          # clock comments
    pgn = re.sub(r"\d+\.\.\.", "", pgn)
    return re.sub(r"[ \t]+", " ", pgn)


def run_raw(client, user, a) -> str:
    g = a.games.head(30)
    pgns = "\n\n".join(strip_pgn(p) for p in _pgns(a, g.url))
    colors = ", ".join(f"{c} in game {i + 1}" for i, c in enumerate(g.color))
    resp = client.messages.create(
        model=coach.MODEL, max_tokens=16000, output_config={"effort": "medium"},
        messages=[{"role": "user", "content": RAW_PROMPT.format(
            n=len(g), user=user, colors=colors, pgns=pgns)}])
    return "".join(b.text for b in resp.content if b.type == "text")


def _pgns(a, urls):
    from wf.fetch import fetch_games
    want = set(urls)
    return [g.pgn for g in fetch_games(a.username, max_games=200) if g.url in want]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("users", nargs="+")
    ap.add_argument("--games", type=int, default=120)
    ap.add_argument("--time-class", default="blitz")
    ap.add_argument("--out", default="eval_results")
    args = ap.parse_args()

    import anthropic
    client = anthropic.Anthropic()
    out = Path(args.out)
    out.mkdir(exist_ok=True)
    rows = []
    for user in args.users:
        print(f"== {user}", flush=True)
        a = analyze(user, max_games=args.games, time_class=args.time_class)
        res = coach.run_coach(user, a.facts, a.games, a.moves, client=client)
        raw_text = run_raw(client, user, a)
        raw_v = verify(raw_text, res.facts)
        for cond, v, text in (("raw", raw_v, raw_text),
                              ("grounded", res.first_verification, None),
                              ("repaired", res.verification, res.report)):
            rows.append({"user": user, "condition": cond, "checked": v["checked"],
                         "unsupported": len(v["unsupported"]) + len(v["bad_citations"]),
                         "rate": v["unsupported_rate"], "ok": v["ok"], "report": text})
        print({r["condition"]: round(r["rate"], 3) for r in rows[-3:]}, flush=True)

    (out / "results.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    lines = ["| Condition | Claims checked | Unsupported | Unsupported rate | Reports fully verified |",
             "|---|---:|---:|---:|---:|"]
    for cond in ("raw", "grounded", "repaired"):
        rs = [r for r in rows if r["condition"] == cond]
        chk = sum(r["checked"] for r in rs)
        uns = sum(r["unsupported"] for r in rs)
        lines.append(f"| {cond} | {chk} | {uns} | {uns / chk:.1%} | "
                     f"{sum(r['ok'] for r in rs)}/{len(rs)} |" if chk else f"| {cond} | 0 | 0 | - | - |")
    summary = "\n".join(lines)
    (out / "summary.md").write_text(summary + "\n")
    print(summary)


if __name__ == "__main__":
    main()
