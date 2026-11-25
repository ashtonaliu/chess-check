#!/usr/bin/env python3
"""Time the Lichess history download behind the opponent note, before and after the color filter.

For players of finished games in the parity fixture, this alternates two requests one at a time:
the old one (their last 100 games in the game's speed) and the new one (their last 50 games in
that speed with the color they had in the fixture game). It reports the median download time of
each and how many of the old request's games had that color, which is all the note reads.
"""
import argparse
import json
from pathlib import Path
import statistics
import time

import requests

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "web" / "test" / "fixtures" / "lichess_parity.json"
# Lichess answers 404 to some default client user agents, so send a plain generic one.
HEADERS = {"Accept": "application/x-ndjson", "User-Agent": "chess-check-timing"}
PAUSE_S = 2.0


def history(user: str, speed: str, max_games: int, color: str | None) -> tuple[float, list[dict]]:
    query = {"max": max_games, "clocks": "true", "opening": "true", "ongoing": "false",
             "finished": "true", "perfType": speed}
    if color:
        query["color"] = color
    start = time.perf_counter()
    response = requests.get(f"https://lichess.org/api/games/user/{user}", params=query, headers=HEADERS, timeout=60)
    response.raise_for_status()
    elapsed = time.perf_counter() - start
    return elapsed, [json.loads(line) for line in response.text.splitlines() if line.strip()]


def played_as(game: dict, user: str) -> str:
    white = game["players"]["white"].get("user", {}).get("id")
    return "white" if white == user.lower() else "black"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--players", type=int, default=6)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()

    exports = json.loads(FIXTURE.read_text())["exports"]
    players = []
    for game in exports.values():
        for color in ("white", "black"):
            user = game["players"][color].get("user", {}).get("name")
            if user and all(p["user"] != user for p in players):
                players.append({"user": user, "color": color, "speed": game["speed"], "game": game["id"]})

    rows = []
    for player in players:
        if len(rows) >= args.players:
            break
        user, color, speed = player["user"], player["color"], player["speed"]
        try:
            history(user, speed, 1, None)
        except requests.HTTPError as error:
            if error.response.status_code == 429:
                raise SystemExit("Lichess asked for a pause; wait a minute and run again.") from error
            print(f"skip {user}: HTTP {error.response.status_code}")
            time.sleep(PAUSE_S)
            continue
        old_s, new_s, in_color, new_n = [], [], [], []
        for _ in range(args.repeats):
            time.sleep(PAUSE_S)
            elapsed, games = history(user, speed, 100, None)
            old_s.append(elapsed)
            in_color.append(sum(played_as(g, user) == color for g in games))
            time.sleep(PAUSE_S)
            elapsed, games = history(user, speed, 50, color)
            new_s.append(elapsed)
            new_n.append(len(games))
            assert all(played_as(g, user) == color for g in games), "the color filter returned the other color"
        row = {**player, "old_seconds": old_s, "new_seconds": new_s,
               "old_games_in_color": in_color, "new_games": new_n}
        rows.append(row)
        print(f"{user} ({speed}, {color}): 100 games {statistics.median(old_s):.2f} s with "
              f"{statistics.median(in_color):.0f} as {color}; 50 as {color} {statistics.median(new_s):.2f} s")

    old_all = [s for r in rows for s in r["old_seconds"]]
    new_all = [s for r in rows for s in r["new_seconds"]]
    summary = {
        "players": len(rows), "repeats": args.repeats,
        "old_median_seconds": statistics.median(old_all), "new_median_seconds": statistics.median(new_all),
        "old_games_in_color_median": statistics.median(n for r in rows for n in r["old_games_in_color"]),
        "new_games_median": statistics.median(n for r in rows for n in r["new_games"]),
    }
    print(json.dumps(summary, indent=2))
    args.output.write_text(json.dumps({"summary": summary, "rows": rows}, indent=2) + "\n")


if __name__ == "__main__":
    main()
