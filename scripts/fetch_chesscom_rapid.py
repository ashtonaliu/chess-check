#!/usr/bin/env python3
"""Sample v1 test players and fetch finished Chess.com rapid and bullet games."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import threading
import time

import chess.pgn
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from chesscheck.dataset import EngineDataset
from scripts.eval_find_rate import TEST_MOD

API_HOST = "api.chess.com"
API_BASE = f"https://{API_HOST}/pub/player"
HEADERS = {"User-Agent": "chess-research-client/1.0"}
SPEEDS = ("rapid", "bullet")
MAX_CONCURRENCY = 2
MAX_RETRIES = 5
MAX_RETRY_WAIT = 60.0
SEED = 24
MIN_RATING = 600
MAX_RATING = 2400
STRATUM_WIDTH = 200
DATA_LIMIT_BYTES = 20 * 1024**3
CLK_RE = re.compile(r"\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]")


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path: Path, value: dict) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    tmp.replace(path)


def dir_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def check_disk_budget(out_dir: Path) -> None:
    if dir_bytes(out_dir) >= DATA_LIMIT_BYTES:
        raise ValueError(f"{out_dir} reached the 20 GB storage cap")


def load_manifest(out_dir: Path) -> dict:
    path = out_dir / "runs.json"
    if path.exists():
        return json.loads(path.read_text())
    return {
        "created_utc": utc_now(),
        "request_batches": [],
        "counts": {},
    }


def is_test_player(username: str) -> bool:
    h = pd.util.hash_pandas_object(pd.Series([username.casefold()]), index=False).to_numpy()[0]
    return int(h % TEST_MOD) == 0


def _retry_delay(response: requests.Response, attempt: int) -> float:
    header = response.headers.get("Retry-After")
    if header is not None:
        try:
            return max(0.0, float(header))
        except ValueError:
            try:
                dt = parsedate_to_datetime(header)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return max(0.0, (dt - datetime.now(timezone.utc)).total_seconds())
            except (TypeError, ValueError):
                pass
    return float(2**attempt)


class RateLimitedClient:
    """Thread-safe Chess.com API client capped at 2 concurrent requests with 429 backoff."""

    def __init__(self):
        self._sem = threading.Semaphore(MAX_CONCURRENCY)
        self._local = threading.local()
        self._lock = threading.Lock()
        self.requests_sent = 0
        self.status_429 = 0
        self.errors = 0

    def _session(self) -> requests.Session:
        sess = getattr(self._local, "session", None)
        if sess is None:
            sess = requests.Session()
            sess.headers.update(HEADERS)
            self._local.session = sess
        return sess

    def get_json(self, url: str, timeout: int = 25) -> dict | None:
        with self._sem:
            for attempt in range(1, MAX_RETRIES + 1):
                try:
                    with self._lock:
                        self.requests_sent += 1
                    resp = self._session().get(url, timeout=timeout)
                except (requests.ConnectionError, requests.Timeout):
                    if attempt == MAX_RETRIES:
                        with self._lock:
                            self.errors += 1
                        return None
                    time.sleep(min(float(2**attempt), MAX_RETRY_WAIT))
                    continue

                if resp.status_code == 200:
                    try:
                        return resp.json()
                    except ValueError:
                        with self._lock:
                            self.errors += 1
                        return None
                if resp.status_code in (404, 410):
                    return None
                if resp.status_code == 429 or resp.status_code >= 500:
                    if resp.status_code == 429:
                        with self._lock:
                            self.status_429 += 1
                    if attempt == MAX_RETRIES:
                        with self._lock:
                            self.errors += 1
                        return None
                    time.sleep(min(_retry_delay(resp, attempt), MAX_RETRY_WAIT))
                    continue
                with self._lock:
                    self.errors += 1
                return None
        return None


def v1_test_candidates(v1_root: Path, per_blitz_stratum: int, seed: int) -> list[str]:
    """Draw a rating-stratified pool of held-out test usernames from data/engine/v1."""
    with EngineDataset(v1_root, threads=4) as ds:
        df = ds.connection.execute("""
            SELECT player, max(rating_after) AS blitz_rating
            FROM _dataset_player_index
            WHERE rating_after IS NOT NULL
            GROUP BY player
        """).df()
    groups = pd.util.hash_pandas_object(df["player"].str.casefold(), index=False).to_numpy()
    df = df.loc[groups % TEST_MOD == 0].copy()
    df["stratum"] = (df["blitz_rating"].clip(400, 2600) // STRATUM_WIDTH) * STRATUM_WIDTH

    rng = np.random.default_rng(seed)
    chosen: list[str] = []
    # Interleave strata round-robin so every rating band gets probed early.
    by_stratum: dict[int, list[str]] = {}
    for stratum, grp in df.groupby("stratum", sort=True):
        names = grp["player"].tolist()
        rng.shuffle(names)
        by_stratum[int(stratum)] = names[:per_blitz_stratum]

    strata = sorted(by_stratum)
    max_len = max((len(v) for v in by_stratum.values()), default=0)
    for idx in range(max_len):
        for s in strata:
            if idx < len(by_stratum[s]):
                chosen.append(by_stratum[s][idx])
    return chosen


def parse_base_seconds(time_control: str) -> int | None:
    if not time_control or "/" in time_control:
        return None
    head = time_control.split("+", 1)[0]
    return int(head) if head.isdigit() and int(head) > 0 else None


def parse_clock_seconds(comment: str) -> float | None:
    match = CLK_RE.search(comment)
    if not match:
        return None
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def fetch_player_stats(client: RateLimitedClient, username: str) -> dict:
    data = client.get_json(f"{API_BASE}/{username.lower()}/stats")
    row = {"player": username.lower(), "rapid_rating": None, "rapid_games": 0,
           "bullet_rating": None, "bullet_games": 0, "ok": data is not None}
    if not data:
        return row
    for speed in SPEEDS:
        block = data.get(f"chess_{speed}")
        if not isinstance(block, dict):
            continue
        last = block.get("last") or {}
        rec = block.get("record") or {}
        rating = last.get("rating")
        games = int(rec.get("win", 0)) + int(rec.get("loss", 0)) + int(rec.get("draw", 0))
        if isinstance(rating, int) and rating > 0:
            row[f"{speed}_rating"] = rating
            row[f"{speed}_games"] = games
    return row


def run_stats(args: argparse.Namespace) -> None:
    args.output.mkdir(parents=True, exist_ok=True)
    check_disk_budget(args.output)
    stats_path = args.output / "player_stats.parquet"
    existing = pd.read_parquet(stats_path) if stats_path.exists() else pd.DataFrame(
        columns=["player", "rapid_rating", "rapid_games", "bullet_rating", "bullet_games", "ok"]
    )
    seen = set(existing["player"].tolist())

    candidates = [u for u in v1_test_candidates(args.v1_root, args.per_blitz_stratum, args.seed) if u not in seen]
    candidates = candidates[: args.max_stats]
    if not candidates:
        print("No new candidates to probe for stats.", flush=True)
        return

    client = RateLimitedClient()
    started = utc_now()
    t0 = time.monotonic()
    rows: list[dict] = []
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENCY) as pool:
        for i, row in enumerate(pool.map(lambda u: fetch_player_stats(client, u), candidates), start=1):
            rows.append(row)
            if i % 200 == 0 or i == len(candidates):
                print(f"Probed {i}/{len(candidates)} players ({time.monotonic() - t0:.1f}s, 429s={client.status_429})",
                      flush=True)

    merged = pd.concat([existing, pd.DataFrame(rows)], ignore_index=True).drop_duplicates(subset=["player"], keep="last")
    tmp = stats_path.with_suffix(".parquet.tmp")
    merged.to_parquet(tmp, index=False)
    tmp.replace(stats_path)

    manifest = load_manifest(args.output)
    manifest["v1_root"] = str(args.v1_root)
    manifest["test_mod"] = TEST_MOD
    manifest["seed"] = args.seed
    manifest["request_batches"].append({
        "kind": "stats",
        "started_utc": started,
        "finished_utc": utc_now(),
        "seconds": round(time.monotonic() - t0, 2),
        "players_probed": len(rows),
        "requests_sent": client.requests_sent,
        "status_429": client.status_429,
        "errors": client.errors,
    })
    manifest["counts"]["stats_players"] = int(len(merged))
    write_json(args.output / "runs.json", manifest)

    for speed in SPEEDS:
        col = f"{speed}_rating"
        gcol = f"{speed}_games"
        active = merged[(merged[col].notna()) & (merged[gcol] >= args.min_player_games)
                        & (merged[col] >= MIN_RATING) & (merged[col] < MAX_RATING)]
        bands = ((active[col].astype(int) // STRATUM_WIDTH) * STRATUM_WIDTH).value_counts().sort_index().to_dict()
        print(f"Active {speed} test players (600-2399, >={args.min_player_games} games): {len(active)} -> {bands}")


def select_stratified_players(stats: pd.DataFrame, per_stratum: int, min_games: int, seed: int) -> dict[str, set[str]]:
    """Return mapping player -> set of speeds they were selected for."""
    rng = np.random.default_rng(seed)
    selected: dict[str, set[str]] = {}
    for speed in SPEEDS:
        rcol, gcol = f"{speed}_rating", f"{speed}_games"
        active = stats[(stats[rcol].notna()) & (stats[gcol] >= min_games)
                       & (stats[rcol] >= MIN_RATING) & (stats[rcol] < MAX_RATING)].copy()
        active["stratum"] = (active[rcol].astype(int) // STRATUM_WIDTH) * STRATUM_WIDTH
        for _, grp in active.groupby("stratum", sort=True):
            names = grp["player"].tolist()
            rng.shuffle(names)
            for name in names[:per_stratum]:
                selected.setdefault(name, set()).add(speed)
    return selected


def extract_game_moves(raw: dict, player: str, pregame_rating: int) -> tuple[dict, list[dict]] | None:
    pgn_text = raw.get("pgn")
    if not pgn_text or "[%clk " not in pgn_text:
        return None
    time_class = raw.get("time_class")
    if time_class not in SPEEDS or raw.get("rules") != "chess" or not raw.get("rated"):
        return None
    base_seconds = parse_base_seconds(str(raw.get("time_control", "")))
    if base_seconds is None:
        return None

    white = (raw.get("white") or {}).get("username", "").lower()
    black = (raw.get("black") or {}).get("username", "").lower()
    if player == white:
        color = "white"
        rating_after = (raw.get("white") or {}).get("rating")
    elif player == black:
        color = "black"
        rating_after = (raw.get("black") or {}).get("rating")
    else:
        return None

    pg = chess.pgn.read_game(io.StringIO(pgn_text))
    if pg is None:
        return None
    if pg.headers.get("SetUp") == "1" or "FEN" in pg.headers:
        return None

    url = str(raw.get("url", ""))
    game_id = url.rstrip("/").rsplit("/", 1)[-1]
    if not game_id:
        return None

    board = pg.board()
    prev_clock = {"white": float(base_seconds), "black": float(base_seconds)}
    moves: list[dict] = []
    ply = 0
    for node in pg.mainline():
        move = node.move
        mover = "white" if board.turn == chess.WHITE else "black"
        clock_after = parse_clock_seconds(node.comment or "")
        clock_before = float(base_seconds) if ply < 2 else prev_clock[mover]
        if mover == color and ply >= 2:
            clock_frac = None if clock_before is None else float(clock_before) / float(base_seconds)
            moves.append({
                "game_id": game_id,
                "ply": ply,
                "mover": mover,
                "player": player,
                "source": "chesscom",
                "time_class": time_class,
                "time_control": str(raw.get("time_control", "")),
                "base_seconds": base_seconds,
                "pregame_rating": int(pregame_rating),
                "clock_before": clock_before,
                "clock_after": clock_after,
                "clock_frac": clock_frac,
                "fen": board.fen(),
                "move_uci": move.uci(),
                "move_san": board.san(move),
                "split": "test",
            })
        if clock_after is not None:
            prev_clock[mover] = clock_after
        board.push(move)
        ply += 1

    if not moves:
        return None
    game_row = {
        "game_id": game_id,
        "url": url,
        "player": player,
        "color": color,
        "time_class": time_class,
        "time_control": str(raw.get("time_control", "")),
        "base_seconds": base_seconds,
        "end_ts": int(raw.get("end_time", 0)),
        "pregame_rating": int(pregame_rating),
        "rating_after": int(rating_after) if isinstance(rating_after, int) else None,
        "plies": ply,
        "focal_moves": len(moves),
        "split": "test",
    }
    return game_row, moves


def fetch_player_games(client: RateLimitedClient, player: str, speeds: set[str],
                       max_months: int, max_games_per_speed: int) -> tuple[list[dict], list[dict]]:
    archives_resp = client.get_json(f"{API_BASE}/{player}/games/archives")
    if not archives_resp:
        return [], []
    months = archives_resp.get("archives") or []
    raw_by_speed: dict[str, list[dict]] = {s: [] for s in speeds}
    for month_url in reversed(months[-max_months:]):
        if all(len(v) >= max_games_per_speed + 1 for v in raw_by_speed.values()):
            break
        month_resp = client.get_json(month_url, timeout=30)
        if not month_resp:
            continue
        month_games = sorted(month_resp.get("games") or [], key=lambda g: g.get("end_time", 0), reverse=True)
        for raw in month_games:
            tc = raw.get("time_class")
            if tc not in raw_by_speed or len(raw_by_speed[tc]) >= max_games_per_speed + 1:
                continue
            if raw.get("rules") != "chess" or not raw.get("rated"):
                continue
            white = (raw.get("white") or {}).get("username", "").lower()
            black = (raw.get("black") or {}).get("username", "").lower()
            if player not in (white, black):
                continue
            raw_by_speed[tc].append(raw)

    games_out: list[dict] = []
    moves_out: list[dict] = []
    for raws in raw_by_speed.values():
        # Sort newest first; pre-game rating is the rating after the next-older rated game in this speed.
        raws.sort(key=lambda g: g.get("end_time", 0), reverse=True)
        for idx, raw in enumerate(raws[:max_games_per_speed]):
            if idx + 1 >= len(raws):
                continue  # No previous game for pre-game rating.
            prev = raws[idx + 1]
            prev_side = prev["white"] if (prev.get("white") or {}).get("username", "").lower() == player else prev["black"]
            pregame = prev_side.get("rating")
            if not isinstance(pregame, int) or pregame <= 0:
                continue
            parsed = extract_game_moves(raw, player, pregame)
            if parsed is None:
                continue
            game_row, game_moves = parsed
            games_out.append(game_row)
            moves_out.extend(game_moves)
    return games_out, moves_out


def run_games(args: argparse.Namespace) -> None:
    check_disk_budget(args.output)
    stats_path = args.output / "player_stats.parquet"
    if not stats_path.exists():
        raise SystemExit(f"{stats_path} not found. Run 'stats' first.")
    stats = pd.read_parquet(stats_path)
    selected = select_stratified_players(stats, args.players_per_stratum, args.min_player_games, args.seed)

    games_path = args.output / "games.parquet"
    moves_path = args.output / "moves.parquet"
    existing_games = pd.read_parquet(games_path) if games_path.exists() else pd.DataFrame()
    existing_moves = pd.read_parquet(moves_path) if moves_path.exists() else pd.DataFrame()
    done_players = set(existing_games["player"].unique().tolist()) if len(existing_games) else set()

    todo = [(p, speeds) for p, speeds in sorted(selected.items()) if p not in done_players]
    if not todo:
        print("All selected players already fetched.", flush=True)
        return

    client = RateLimitedClient()
    started = utc_now()
    t0 = time.monotonic()
    new_games: list[dict] = []
    new_moves: list[dict] = []
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENCY) as pool:
        futures = [
            (p, pool.submit(fetch_player_games, client, p, speeds, args.max_months, args.max_games_per_player))
            for p, speeds in todo
        ]
        for i, (_, fut) in enumerate(futures, start=1):
            g_rows, m_rows = fut.result()
            new_games.extend(g_rows)
            new_moves.extend(m_rows)
            if i % 50 == 0 or i == len(futures):
                print(f"Fetched {i}/{len(futures)} players -> {len(new_games)} games, {len(new_moves)} moves "
                      f"({time.monotonic() - t0:.1f}s, 429s={client.status_429})", flush=True)

    all_games = pd.concat([existing_games, pd.DataFrame(new_games)], ignore_index=True)
    all_games = all_games.drop_duplicates(subset=["game_id", "player"], keep="first")
    all_moves = pd.concat([existing_moves, pd.DataFrame(new_moves)], ignore_index=True)
    all_moves = all_moves.drop_duplicates(subset=["game_id", "ply", "player"], keep="first")

    for path, frame in ((games_path, all_games), (moves_path, all_moves)):
        tmp = path.with_suffix(".parquet.tmp")
        pq.write_table(pa.Table.from_pandas(frame, preserve_index=False), tmp, compression="zstd")
        tmp.replace(path)

    manifest = load_manifest(args.output)
    manifest["request_batches"].append({
        "kind": "archives",
        "started_utc": started,
        "finished_utc": utc_now(),
        "seconds": round(time.monotonic() - t0, 2),
        "players_fetched": len(todo),
        "new_games": len(new_games),
        "new_moves": len(new_moves),
        "requests_sent": client.requests_sent,
        "status_429": client.status_429,
        "errors": client.errors,
    })
    manifest["counts"]["games"] = int(len(all_games))
    manifest["counts"]["moves"] = int(len(all_moves))
    manifest["counts"]["games_by_speed"] = {k: int(v) for k, v in all_games["time_class"].value_counts().items()}
    manifest["counts"]["moves_by_speed"] = {k: int(v) for k, v in all_moves["time_class"].value_counts().items()}
    manifest["moves_sha256"] = hashlib.file_digest(moves_path.open("rb"), "sha256").hexdigest()
    manifest["data_bytes"] = dir_bytes(args.output)
    write_json(args.output / "runs.json", manifest)

    print(f"Saved {len(all_games):,} games and {len(all_moves):,} moves ({manifest['data_bytes'] / 1e6:.1f} MB)")
    for speed in SPEEDS:
        sub = all_moves[all_moves["time_class"] == speed]
        bands = ((sub["pregame_rating"] // 100) * 100).value_counts().sort_index().to_dict()
        print(f"  {speed} moves by 100-pt band: {bands}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--v1-root", type=Path, default=ROOT / "data" / "engine" / "v1")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "engine" / "chesscom-rapid-v1")
    parser.add_argument("--seed", type=int, default=SEED)
    sub = parser.add_subparsers(dest="action", required=True)

    p_stats = sub.add_parser("stats", help="Probe /stats for v1 held-out test players")
    p_stats.add_argument("--per-blitz-stratum", type=int, default=200)
    p_stats.add_argument("--max-stats", type=int, default=1400)
    p_stats.add_argument("--min-player-games", type=int, default=25)

    p_games = sub.add_parser("games", help="Fetch monthly archives for stratified players")
    p_games.add_argument("--players-per-stratum", type=int, default=35)
    p_games.add_argument("--min-player-games", type=int, default=25)
    p_games.add_argument("--max-months", type=int, default=4)
    p_games.add_argument("--max-games-per-player", type=int, default=30)

    args = parser.parse_args()
    if args.action == "stats":
        run_stats(args)
    else:
        run_games(args)


if __name__ == "__main__":
    main()
