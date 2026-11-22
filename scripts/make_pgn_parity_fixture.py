#!/usr/bin/env python3
"""Build web/test/fixtures/archive_pgns.json from saved Chess.com monthly archives.

Usage: python scripts/make_pgn_parity_fixture.py ARCHIVE.json [ARCHIVE.json ...]

Every game whose result is not one of the four common ones (win, timeout, resigned, checkmated)
is kept, so draws by agreement, repetition, stalemate, the 50-move rule and the insufficient
material results are all covered. The rest is filled with a hash-ordered sample spread across
time classes, so the fixture is the same for the same archives.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "test" / "fixtures" / "archive_pgns.json"
COMMON = {"win", "timeout", "resigned", "checkmated"}
SIDE = ("username", "rating", "result")
FIELDS = ("url", "pgn", "rules", "time_class", "time_control", "end_time", "eco")


def slim(game: dict) -> dict:
    out = {key: game[key] for key in FIELDS if key in game}
    for color in ("white", "black"):
        out[color] = {key: game[color][key] for key in SIDE if key in game[color]}
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archives", nargs="+", type=Path)
    parser.add_argument("--count", type=int, default=400)
    args = parser.parse_args()

    games = {}
    for path in args.archives:
        for game in json.loads(path.read_text())["games"]:
            if game.get("rules") == "chess" and game.get("pgn"):
                games[game["url"]] = game
    order = sorted(games.values(), key=lambda g: hashlib.sha256(g["url"].encode()).hexdigest())
    rare = [g for g in order if {g["white"]["result"], g["black"]["result"]} - COMMON]
    chosen = {g["url"] for g in rare}
    classes = sorted({g["time_class"] for g in order})
    queues = {tc: [g for g in order if g["time_class"] == tc and g["url"] not in chosen] for tc in classes}
    # Take from each time class in turn until the fixture is full.
    while len(chosen) < args.count and any(queues.values()):
        for tc in classes:
            if queues[tc] and len(chosen) < args.count:
                chosen.add(queues[tc].pop(0)["url"])
    picked = [slim(g) for g in order if g["url"] in chosen]
    OUT.write_text(json.dumps({"games": picked}, separators=(",", ":")) + "\n")
    print(f"Wrote {len(picked)} games ({len(rare)} with uncommon results) to {OUT.relative_to(ROOT)}, "
          f"{OUT.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
