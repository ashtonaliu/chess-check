"""Hallucination eval for the coach.

For each player, three conditions are scored by the same verifier:
  raw      - the model reads 30 raw PGNs and writes the report (no computed
             facts, no tools, no citations asked for)
  grounded - computed facts + tools, first draft (before the repair turn)
  repaired - the final report after the verifier's feedback

Two scores:
  lenient - a claim is supported if it matches the computed analysis OR the
            games the model was shown (fair to the raw baseline, which was
            never asked to cite). This is the apples-to-apples comparison.
  strict  - every number must match the specific fact the sentence cites
            (only meaningful for the grounded conditions).

"Unsupported" means not verifiable from the model's inputs or the analysis;
it is an upper bound on false claims, not a count of them.

Runs through ANTHROPIC_API_KEY if set, otherwise the local Claude Code CLI
(your Claude subscription). Usernames are written only to the gitignored
eval_results/ folder.

  python scripts/eval_coach.py USER1 USER2 USER3 --games 120
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wf import coach_cli  # noqa: E402
from wf.env import load_env  # noqa: E402
from wf.pipeline import analyze  # noqa: E402
from wf.verify import verify  # noqa: E402

RAW_PROMPT = """You are a chess coach. Below are {n} recent blitz games by the \
Chess.com player {user}. The player had {colors}. Write a short report (under \
350 words) on their biggest weaknesses, with evidence from the games and a \
training plan.

{pgns}"""


def strip_pgn(pgn: str) -> str:
    keep = [ln for ln in pgn.splitlines()
            if not ln.startswith("[") or ln.split()[0] in
            ("[White", "[Black", "[Result", "[WhiteElo", "[BlackElo", "[ECOUrl")]
    text = "\n".join(keep)
    text = re.sub(r"\{[^}]*\}", "", text)          # clock comments
    text = re.sub(r"\d+\.\.\.", "", text)
    return re.sub(r"[ \t]+", " ", text).strip()


def raw_report(user: str, a) -> tuple[str, str]:
    from wf.fetch import fetch_games
    want = list(a.games.head(30).url)
    by_url = {g.url: g for g in fetch_games(user, max_games=max(200, len(a.games)))}
    games = [by_url[u] for u in want if u in by_url]
    pgns = "\n\n".join(strip_pgn(g.pgn) for g in games)
    colors = ", ".join(f"{g.color} in game {i + 1}" for i, g in enumerate(games))
    prompt = RAW_PROMPT.format(n=len(games), user=user, colors=colors, pgns=pgns)
    if os.environ.get("ANTHROPIC_API_KEY"):
        import anthropic
        from wf.coach import MODEL
        resp = anthropic.Anthropic().messages.create(
            model=MODEL, max_tokens=16000, output_config={"effort": "medium"},
            messages=[{"role": "user", "content": prompt}])
        text = "".join(b.text for b in resp.content if b.type == "text")
    else:
        text = coach_cli.complete(prompt)
    return text, pgns


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("users", nargs="+")
    ap.add_argument("--games", type=int, default=120)
    ap.add_argument("--time-class", default="blitz")
    ap.add_argument("--out", default="eval_results")
    args = ap.parse_args()
    load_env()
    out = Path(args.out)
    out.mkdir(exist_ok=True)
    rows = []
    for i, user in enumerate(args.users, 1):
        t = time.time()
        a = analyze(user, max_games=args.games, time_class=args.time_class)
        res = coach_cli.run_coach_auto(user, a.facts, a.games, a.moves, repair=True)
        raw_text, pgns = raw_report(user, a)
        seen = res.facts + [{"id": "PGN", "text": pgns}]
        conds = {
            "raw": (raw_text, verify(raw_text, seen, require_citation=False), None),
            "grounded": (res.first_report, verify(res.first_report, res.facts, require_citation=False),
                         res.first_verification),
            "repaired": (res.report, verify(res.report, res.facts, require_citation=False),
                         res.verification),
        }
        for cond, (text, lenient, strict) in conds.items():
            rows.append({"player": i, "user": user, "condition": cond,
                         "lenient_checked": lenient["checked"] if lenient else None,
                         "lenient_unsupported": (len(lenient["unsupported"]) + len(lenient["bad_citations"]))
                         if lenient else None,
                         "strict_checked": strict["checked"] if strict else None,
                         "strict_unsupported": (len(strict["unsupported"]) + len(strict["bad_citations"]))
                         if strict else None,
                         "strict_ok": strict["ok"] if strict else None,
                         "unsupported_examples": [(u["type"], u["claim"]) for u in
                                                  ((lenient or strict)["unsupported"])][:8],
                         "report": text})
        print(f"player {i}: {round(time.time() - t)}s, repaired={res.repaired}, "
              f"tools={[c['name'] for c in res.tool_calls]}", flush=True)
        (out / "results.jsonl").write_text("\n".join(json.dumps(r, default=str) for r in rows))

    def agg(cond, kind):
        rs = [r for r in rows if r["condition"] == cond and r[f"{kind}_checked"] is not None]
        chk = sum(r[f"{kind}_checked"] for r in rs)
        uns = sum(r[f"{kind}_unsupported"] for r in rs)
        clean = sum(r[f"{kind}_unsupported"] == 0 for r in rs)
        return (f"{uns}/{chk} ({uns / chk:.1%})" if chk else "-"), (f"{clean}/{len(rs)}" if rs else "-")

    lines = ["| Condition | Unsupported, lenient | Clean reports, lenient | "
             "Unsupported, strict | Clean reports, strict |",
             "|---|---:|---:|---:|---:|"]
    names = {"raw": "Raw PGNs, no context engineering",
             "grounded": "Facts + tools, first draft",
             "repaired": "Facts + tools + verifier repair"}
    for cond in ("raw", "grounded", "repaired"):
        l1, l2 = agg(cond, "lenient")
        s1, s2 = agg(cond, "strict")
        lines.append(f"| {names[cond]} | {l1} | {l2} | {s1} | {s2} |")
    summary = f"{len(args.users)} players, {args.games} {args.time_class} games each\n\n" + "\n".join(lines)
    (out / "summary.md").write_text(summary + "\n")
    print(summary)


if __name__ == "__main__":
    main()
