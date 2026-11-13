"""Which Claude model should write the coaching report?

Runs the same coach (facts, tools, checker, one repair turn) with each model
on the same players, through Claude Code, and compares:

  accuracy  - unsupported claims in the first draft (strict checker), and
              whether the final report is clean after the repair turn
  coverage  - share of the key facts the report cites: every tactic or
              opening fact with a verdict, plus the overall blunder-model fact.
              A model can be perfectly accurate by saying nothing; this
              catches that.
  format    - under 350 words with the three required sections
  cost      - list-price USD per report (as reported by Claude Code), tokens,
              and API time

  python scripts/eval_models.py USER1 USER2 ... --games 120
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wf.coach_cli import run_coach_cli  # noqa: E402
from wf.pipeline import analyze  # noqa: E402

MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
SECTIONS = ["## Biggest weaknesses", "## What's working", "## Training plan"]
KEY = re.compile(r"Verdict: (a pattern|worth watching|weakness|possible weakness|strength|possible strength)")


TIER1 = re.compile(r"Verdict: (a pattern|weakness\.)")
TIER2 = re.compile(r"Verdict: (possible weakness|worth watching)")
RATIO = re.compile(r"\(([\d.]+) times your opponents' rate")


def weakness_tier(text: str) -> int | None:
    """1 = pattern/weakness, 2 = possible weakness/worth watching, None = not a weakness
    (no verdict, or a rate below the opponents', which is a strength)."""
    m = RATIO.search(text)
    if m and float(m.group(1)) < 1:
        return None
    if TIER1.search(text):
        return 1
    if TIER2.search(text):
        return 2
    return None


def leads_with_strongest(report: str, facts: list[dict]) -> bool | None:
    """Does the first fact cited under "## Biggest weaknesses" have the strongest
    weakness tier available? None when the analysis has no weakness facts."""
    tiers = {f["id"]: weakness_tier(f["text"]) for f in facts}
    best = min((t for t in tiers.values() if t), default=None)
    if best is None:
        return None
    section = report.split("## Biggest weaknesses", 1)[-1].split("##", 1)[0]
    for fid in re.findall(r"\[(F\d+)\]", section):
        if tiers.get(fid):
            return tiers[fid] == best
    return False


def key_facts(facts: list[dict]) -> set[str]:
    keys = {f["id"] for f in facts if f["kind"] in ("tactics", "opening") and KEY.search(f["text"])}
    model = [f["id"] for f in facts if f["kind"] == "model"]
    return keys | set(model[:1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("users", nargs="+")
    ap.add_argument("--games", type=int, default=120)
    ap.add_argument("--models", nargs="+", default=MODELS)
    ap.add_argument("--out", default="eval_results/models")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for i, user in enumerate(args.users, 1):
        a = analyze(user, max_games=args.games, time_class="blitz")
        keys = key_facts(a.facts)
        for model in args.models:
            t = time.time()
            r = run_coach_cli(user, a.facts, a.games, a.moves, summaries=a.summaries, model=model)
            cited = set(re.findall(r"\[(F\d+)\]", r.report))
            words = len(re.findall(r"\b[\w'.+-]+\b", r.report))
            f, v = r.first_verification, r.verification
            rows.append({
                "player": i, "model": model, "served_by": r.usage.get("models"),
                "first_checked": f["checked"], "first_unsupported": len(f["unsupported"]) + len(f["bad_citations"]),
                "final_clean": v["ok"], "repaired": r.repaired,
                "key_facts": len(keys), "key_cited": len(keys & cited),
                "words": words, "sections": all(s in r.report for s in SECTIONS),
                "leads_strongest": leads_with_strongest(r.report, a.facts),
                "tool_calls": len(r.tool_calls), "cost_usd": r.usage["cost_usd"],
                "tokens_in": r.usage["input_tokens"], "tokens_out": r.usage["output_tokens"],
                "api_s": r.usage["api_ms"] / 1000, "wall_s": time.time() - t, "report": r.report,
            })
            row = rows[-1]
            print(f"player {i} {model}: first {row['first_unsupported']}/{row['first_checked']} unsupported, "
                  f"clean={row['final_clean']}, key {row['key_cited']}/{row['key_facts']}, {row['words']} words, "
                  f"${row['cost_usd']:.3f}, {row['wall_s']:.0f}s, served by {row['served_by']}", flush=True)
            (out / "results.jsonl").write_text("\n".join(json.dumps(r) for r in rows))

    print("\n| Model | First-draft unsupported | Clean after repair | Key facts cited | Leads with strongest finding | "
          "Tool calls | Cost per report (CLI-reported) | Time per report |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|")
    for model in args.models:
        rs = [r for r in rows if r["model"] == model]
        if not rs:
            continue
        uns = sum(r["first_unsupported"] for r in rs)
        chk = sum(r["first_checked"] for r in rs)
        key = sum(r["key_cited"] for r in rs) / max(sum(r["key_facts"] for r in rs), 1)
        lead = [r["leads_strongest"] for r in rs if r["leads_strongest"] is not None]
        print(f"| {model} | {uns}/{chk} ({uns / chk:.1%}) | {sum(r['final_clean'] for r in rs)}/{len(rs)} | {key:.0%} | "
              f"{sum(lead)}/{len(lead)} | {sum(r['tool_calls'] for r in rs) / len(rs):.1f} | "
              f"${sum(r['cost_usd'] for r in rs) / len(rs):.3f} | {sum(r['wall_s'] for r in rs) / len(rs):.0f}s |")


if __name__ == "__main__":
    main()
