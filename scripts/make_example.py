"""Generate the saved example report shown when a server has no coach backend.

  python scripts/make_example.py USERNAME --games 300 --time-class blitz
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from wf.coach_cli import run_coach_auto  # noqa: E402
from wf.env import load_env  # noqa: E402
from wf.pipeline import analyze  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("username")
    ap.add_argument("--games", type=int, default=300)
    ap.add_argument("--time-class", default="blitz")
    args = ap.parse_args()
    load_env()
    a = analyze(args.username, max_games=args.games, time_class=args.time_class)
    r = run_coach_auto(a.username, a.facts, a.games, a.moves)
    out = {"username": a.username, "report": r.report, "verification": r.verification,
           "first_verification": r.first_verification, "repaired": r.repaired,
           "tool_calls": r.tool_calls, "usage": r.usage,
           "facts": [{"id": f["id"], "text": f["text"]} for f in r.facts]}
    (ROOT / "web" / "example_report.json").write_text(json.dumps(out, indent=1))
    v = r.verification
    print(f"saved; {v['checked']} claims checked, ok={v['ok']}, repaired={r.repaired}")


if __name__ == "__main__":
    main()
