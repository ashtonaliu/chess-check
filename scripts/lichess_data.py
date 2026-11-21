#!/usr/bin/env python3
"""Fetch and prepare the Lichess archives under the shared data budget."""
import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile

DATA = Path(__file__).resolve().parents[1] / "data"
LICHESS = DATA / "lichess"
LIMIT = 150_000_000_000
BASE = "https://database.lichess.org"
OCTOBER = "2026-10"
OCTOBER_GAMES = 95_395_628
BINARY = DATA.parent / "tools/lichess-ingest/target/release/lichess-ingest"


def data_bytes():
    return sum(
        (Path(directory) / name).lstat().st_size
        for directory, _, files in os.walk(DATA)
        for name in files
    )


def download(kind, month):
    archive = {
        "games": f"standard/lichess_db_standard_rated_{month}.pgn.zst",
        "evals": "lichess_db_eval.jsonl.zst",
        "puzzles": "lichess_db_puzzle.csv.zst",
    }[kind]
    url = f"{BASE}/{archive}"
    path = LICHESS / "downloads" / Path(archive).name
    path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path = path.parent / "runs.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    if path.exists():
        if manifest.get(path.name, {}).get("size") != path.stat().st_size:
            raise ValueError(f"{path} does not match the download manifest")
        print(json.dumps(manifest[path.name]), flush=True)
        return
    expected = None
    if kind == "games":
        checksums = subprocess.check_output(
            ["curl", "-fsSL", "--max-time", "60", f"{BASE}/standard/sha256sums.txt"], text=True
        )
        checksums = dict(line.split()[::-1] for line in checksums.splitlines())
        expected = checksums[path.name]

    partial = path.with_suffix(".zst.partial")
    headers = subprocess.check_output(["curl", "-fsSI", "--max-time", "60", url], text=True)
    size = int(next(line.split(":", 1)[1] for line in headers.splitlines()
                    if line.lower().startswith("content-length:")))
    if data_bytes() + size + 1_000_000 > LIMIT:
        raise ValueError(f"{path.name} would exceed the {LIMIT:,}-byte data budget")
    try:
        print(f"Downloading {path.name} ({size:,} bytes)", flush=True)
        subprocess.run([
            "curl", "-fsSL", "--connect-timeout", "30", "--speed-limit", "1024", "--speed-time", "60",
            "--max-filesize", str(size), "--output", str(partial), url,
        ], check=True)
        with partial.open("rb") as downloaded:
            digest = hashlib.file_digest(downloaded, "sha256").hexdigest()
        if partial.stat().st_size != size or (expected and digest != expected):
            raise ValueError(f"Size or checksum mismatch for {url}")
        record = {"url": url, "name": path.name, "size": size, "sha256": digest}
        manifest[path.name] = record
        staged_manifest = manifest_path.with_suffix(".json.tmp")
        staged_manifest.write_text(json.dumps(manifest, indent=2) + "\n")
        partial.rename(path)
        staged_manifest.replace(manifest_path)
        print(json.dumps(record), flush=True)
    finally:
        partial.unlink(missing_ok=True)


def ingest(args):
    expected = args.expected_games
    if expected is None and args.month == OCTOBER:
        expected = OCTOBER_GAMES
    if expected is None or expected <= 0 or args.position_mod < 2 or args.reserve_bytes < 0:
        raise ValueError("Provide a positive game count, position modulus of at least two, and nonnegative reserve")
    available = LIMIT - data_bytes() - args.reserve_bytes - 1_000_000
    if available <= 0:
        raise ValueError("No output space remains within the data budget and reserve")
    archive = LICHESS / "downloads" / f"lichess_db_standard_rated_{args.month}.pgn.zst"
    output = LICHESS / (f"{args.month}-1pct" if args.one_percent else args.month)
    if output.exists():
        raise FileExistsError(output)
    command = [str(BINARY), "--input", str(archive), "--byte-budget", str(available)]
    pilot = json.loads(subprocess.check_output(command + [
        "--output", str(output), "--position-mod", "1", "--measure-only",
        "--max-games", str(min(expected, 65_536)),
    ], text=True))
    if not pilot["games"] or not pilot["positions"]:
        raise ValueError("The calibration scan found no writable game positions")
    scale = 1.25 * expected / pilot["games"]
    game_bytes = math.ceil(pilot["game_bytes"] * scale)
    if game_bytes >= available:
        raise ValueError("The projected games table alone would exceed the output budget")
    modulus = max(args.position_mod, math.ceil(pilot["position_bytes"] * scale / (available - game_bytes)))
    if args.one_percent:
        modulus = 100
    position_bytes = math.ceil(pilot["position_bytes"] * scale / modulus)
    projection = {"position_mod": modulus, "bucket": 0, "games": expected,
                  "game_bytes": game_bytes, "position_bytes": position_bytes,
                  "total_bytes": game_bytes + position_bytes, "output_budget_bytes": available,
                  "calibration": pilot}
    print(json.dumps({"projection": projection}), flush=True)
    if projection["total_bytes"] > available:
        raise ValueError("The projection exceeds the output budget")
    with tempfile.TemporaryDirectory(prefix=".ingest-", dir=LICHESS) as staging:
        dataset = Path(staging) / "dataset"
        stats = json.loads(subprocess.check_output(command + [
            "--output", str(dataset), "--position-mod", str(modulus),
        ], text=True))
        if stats["games"] != expected:
            raise ValueError(f"Scanned {stats['games']:,} games, expected {expected:,}")
        stats["data_bytes"] = data_bytes()
        metadata = {"archive": archive.name, "projection": projection, "actual": stats}
        (dataset / "run.json").write_text(json.dumps(metadata, indent=2) + "\n")
        dataset.rename(output)
    print(json.dumps(metadata), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    fetch = actions.add_parser("fetch")
    fetch.add_argument("archives", nargs="+", choices=["games", "evals", "puzzles"])
    fetch.add_argument("--month", default=OCTOBER)
    games = actions.add_parser("ingest")
    games.add_argument("--month", default=OCTOBER)
    games.add_argument("--expected-games", type=int)
    games.add_argument("--position-mod", type=int, default=20, help="minimum denominator of the position sample")
    games.add_argument("--reserve-bytes", type=int, default=40_000_000_000, help="space reserved for later stages")
    games.add_argument("--one-percent", action="store_true")
    args = parser.parse_args()
    if len(args.month) != 7 or args.month[4] != "-" or not (args.month[:4] + args.month[5:]).isdigit():
        parser.error("month must use YYYY-MM")

    LICHESS.mkdir(parents=True, exist_ok=True)
    with (LICHESS / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == "fetch":
            for archive in args.archives:
                download(archive, args.month)
        else:
            ingest(args)


if __name__ == "__main__":
    main()
