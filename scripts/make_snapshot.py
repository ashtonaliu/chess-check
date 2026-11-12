"""Generate the snapshot used by the static demo and the hosted fallback:

  web/snapshot/analysis.json  - the /api/analyze payload for one player
  web/example_report.json     - the coach's verified report, from the SAME run

  python scripts/make_snapshot.py USERNAME --games 300 --time-class blitz
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from wf.coach_cli import run_coach_auto  # noqa: E402
from wf.env import load_env  # noqa: E402
from wf.pipeline import analyze, to_payload  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("username")
    ap.add_argument("--games", type=int, default=300)
    ap.add_argument("--time-class", default="blitz")
    ap.add_argument("--no-coach", action="store_true", help="only refresh the analysis")
    args = ap.parse_args()
    load_env()
    a = analyze(args.username, max_games=args.games, time_class=args.time_class)
    payload = to_payload(a)
    payload["generated_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    payload["time_class"] = args.time_class
    out = ROOT / "web" / "snapshot"
    out.mkdir(exist_ok=True)
    (out / "analysis.json").write_text(json.dumps(payload, indent=1, default=float))
    print(f"analysis: {payload['overall']['games']} games")
    if args.no_coach:
        return
    r = run_coach_auto(a.username, a.facts, a.games, a.moves)
    report = {"username": a.username, "generated_at": payload["generated_at"],
              "report": r.report, "verification": r.verification,
              "first_verification": r.first_verification, "repaired": r.repaired,
              "tool_calls": r.tool_calls, "usage": r.usage,
              "facts": [{"id": f["id"], "text": f["text"]} for f in r.facts]}
    (ROOT / "web" / "example_report.json").write_text(json.dumps(report, indent=1))
    v = r.verification
    print(f"report: {v['checked']} claims checked, ok={v['ok']}, repaired={r.repaired}")


if __name__ == "__main__":
    main()
