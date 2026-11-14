"""Run the depth-10 engine odds study. Install python-chess, requests, numpy and scikit-learn.

Example: python scripts/eval_engine_features.py --source data/odds/v3
The input collection is read-only. Downloads, feature caches and results go in data/odds/engine.
"""
import argparse
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import io
import json
import math
from pathlib import Path
import random
import subprocess
import threading
import time
from urllib.parse import quote, urlsplit

import chess.pgn
import numpy as np
import requests

from eval_odds import _boot, expected, pregame_rating, score_of

from wf import engine, tactics
from wf.fetch import HEADERS

ROOT = Path(__file__).resolve().parents[1]
API = "https://api.chess.com/pub/player"
DEPTH = 10
SEED = 0
HISTORY = 50
PHASES = ("opening", "middlegame", "endgame")
local = threading.local()
rate_lock = threading.Lock()
retry_after = 0.0


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, separators=(",", ":"), allow_nan=False))
    temp.replace(path)


def get(url, cache):
    global retry_after
    path = cache / "downloads" / (hashlib.sha256(url.encode()).hexdigest() + ".json")
    if path.exists():
        return json.loads(path.read_text())
    if not hasattr(local, "session"):
        local.session = requests.Session()
    for attempt in range(6):
        with rate_lock:
            delay = retry_after - time.monotonic()
        while delay > 0:
            time.sleep(delay)
            with rate_lock:
                delay = retry_after - time.monotonic()
        try:
            response = local.session.get(url, headers=HEADERS, timeout=30)
        except requests.RequestException:
            if attempt == 5:
                raise
            time.sleep(2 ** attempt)
            continue
        if response.status_code == 429:
            from email.utils import parsedate_to_datetime

            header = response.headers.get("Retry-After", "")
            try:
                wait = float(header)
            except ValueError:
                try:
                    wait = parsedate_to_datetime(header).timestamp() - time.time()
                except (TypeError, ValueError, OverflowError):
                    wait = 0
            with rate_lock:
                retry_after = max(retry_after, time.monotonic() + max(wait, 2 ** attempt))
            continue
        if response.status_code >= 500 and attempt < 5:
            time.sleep(2 ** attempt)
            continue
        response.raise_for_status()
        data = response.json()
        write_json(path, data)
        return data
    raise RuntimeError(f"Rate limit persisted for {url}")


def game_id(url):
    value = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]
    if not value.isdecimal():
        raise ValueError(f"Invalid Chess.com game ID in {url}")
    return value


def sample_targets(targets, count):
    rng = random.Random(SEED)
    groups = defaultdict(list)
    for target in targets:
        groups[target["focal"].lower()].append(target)
    names = sorted(groups)
    rng.shuffle(names)
    for name in names:
        groups[name].sort(key=lambda target: (target["end"], target["url"]))
        rng.shuffle(groups[name])
    selected = []
    seen = set()
    queue = deque(iter(groups[name]) for name in names)
    while queue and len(selected) < count:
        games = queue.popleft()
        for target in games:
            gid = game_id(target["url"])
            if gid not in seen:
                selected.append(target)
                seen.add(gid)
                queue.append(games)
                break
    return selected


def game_start(raw):
    headers = chess.pgn.read_headers(io.StringIO(raw["pgn"]))
    if headers:
        for date, clock in (("UTCDate", "UTCTime"), ("Date", "StartTime")):
            try:
                start = int(datetime.strptime(f"{headers[date]} {headers[clock]}", "%Y.%m.%d %H:%M:%S")
                            .replace(tzinfo=timezone.utc).timestamp())
            except (KeyError, ValueError):
                continue
            if 0 < start <= raw["end_time"]:
                return start
    return None


def month_at(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y/%m")


def download(task, cache):
    user, needs, cutoffs = task
    urls = get(f"{API}/{quote(user, safe='')}/games/archives", cache)["archives"]
    games = {}
    for url in sorted(urls, reverse=True):
        month = url.rstrip("/")[-7:]
        if month > month_at(max(end for end, _ in needs)):
            continue
        for raw in get(url, cache)["games"]:
            if raw.get("rules") == "chess" and raw.get("time_class") == "blitz" and raw.get("pgn"):
                games[game_id(raw["url"])] = raw
        # All target months must be loaded, even when there is already enough history.
        if month <= month_at(min(end for end, _ in needs)):
            ordered = sorted(games.values(), key=lambda game: (game["end_time"], game_id(game["url"])))
            if all(
                (start := cutoffs.get(gid) or (game_start(games[gid]) if gid in games else None)) is not None
                and sum(0 < game["end_time"] < start for game in ordered) >= HISTORY
                for _, gid in needs
            ):
                break
    return user, sorted(games.values(), key=lambda game: (game["end_time"], game_id(game["url"])))


def side(raw, user):
    return next(color for color in ("white", "black") if raw[color]["username"].lower() == user)


def previous_rating(games, user, start, snapshot):
    # Raw history extends the collection; the read-only snapshot supplies the
    # same previous-game rating when it has a more recent completed game.
    dates = {g["end"]: g["my"] for g in snapshot if 0 < g["end"] < start}
    for game in games:
        if 0 < game["end_time"] < start:
            dates[game["end_time"]] = game[side(game, user)]["rating"]
    return pregame_rating([{"end": t, "my": dates[t]} for t in sorted(dates)], start)


def plan(targets, source, cache):
    needs = defaultdict(list)
    for target in targets:
        uid = game_id(target["url"])
        needs[target["focal"].lower()].append((target["end"], uid))

    def fetch_histories(requests, cutoffs):
        histories = {}
        tasks = [(user, games, cutoffs) for user, games in sorted(requests.items())]
        with ThreadPoolExecutor(max_workers=2) as pool:
            for i, (user, games) in enumerate(pool.map(lambda task: download(task, cache), tasks), 1):
                histories[user] = games
                if i % 25 == 0 or i == len(tasks):
                    print(f"Archives: {i}/{len(tasks)} players in this batch", flush=True)
        return histories

    histories = fetch_histories(needs, {})
    target_games = {game_id(game["url"]): game for games in histories.values() for game in games}
    cutoffs = {}
    opponents = defaultdict(list)
    for target in targets:
        gid = game_id(target["url"])
        if gid in target_games and (start := game_start(target_games[gid])) is not None:
            cutoffs[gid] = start
            opponents[target["opp_name"].lower()].append((target["end"], gid))
    for user, games in fetch_histories(opponents, cutoffs).items():
        merged = {game_id(game["url"]): game for game in histories.get(user, []) + games}
        histories[user] = sorted(merged.values(), key=lambda game: (game["end_time"], game_id(game["url"])))

    snapshots = {}
    for user in histories:
        path = source / "players" / f"{user}.json"
        snapshot = json.loads(path.read_text()) if path.is_file() else {}
        snapshots[user] = snapshot.get("games", []) if isinstance(snapshot, dict) else snapshot

    rows, jobs = [], {}
    exclusions = defaultdict(int)
    for target in targets:
        focal, opponent = target["focal"].lower(), target["opp_name"].lower()
        gid = game_id(target["url"])
        raw, start = target_games.get(gid), cutoffs.get(gid)
        if raw is None or start is None:
            exclusions["target PGN/start unavailable"] += 1
            continue
        players = (focal, opponent)
        prior = [[game for game in histories[user] if 0 < game["end_time"] < start] for user in players]
        if any(len(games) < HISTORY for games in prior):
            exclusions["fewer than 50 pre-start blitz games"] += 1
            continue
        ratings = [previous_rating(games, user, start, snapshots[user]) for user, games in zip(players, prior)]
        past = []
        for user, games in zip(players, prior):
            entries = []
            for game in games[-HISTORY:]:
                key = game_id(game["url"])
                jobs[key] = game
                entries.append((key, side(game, user)))
            past.append(entries)
        jobs[gid] = raw
        rows.append((focal, raw, gid, ratings, past))
    return rows, jobs, dict(exclusions)


def analyse(raw, binary, cache):
    gid = game_id(raw["url"])
    path = cache / f"{gid}.json"
    if path.is_file():
        return json.loads(path.read_text()), False
    from wf.fetch import Game

    game = Game(url=raw["url"], color="white", my_rating=0, opp_rating=0,
                score=0, time_class="blitz", eco="", opening="", family="",
                end_time=raw["end_time"], time_control=raw["time_control"], pgn=raw["pgn"])
    started = time.perf_counter()
    analysis = engine._analyse(game, binary, DEPTH)
    elapsed = time.perf_counter() - started
    for move in analysis["moves"]:
        move["phase"] = ("opening" if move["ply"] < 20 else
                         "endgame" if move["non_pawn_material"] <= 26 else "middlegame")
        move["is_me"] = move["mover"] == "white"
    motifs = tactics.classify_game(game.pgn, analysis) if analysis["moves"] else []
    features = {}
    for color in ("white", "black"):
        moves = [move for move in analysis["moves"] if move["mover"] == color]
        sign = 1 if color == "white" else -1
        positions = [cp * sign * (1 if move["mover"] == "white" else -1)
                     for move in analysis["moves"] for cp in (move["cp_before"], move["cp_after"])]
        timed = [move for move in moves if move["clock_frac"] is not None]
        other = "black" if color == "white" else "white"
        features[color] = {
            "losses": [move["wp_loss"] for move in moves],
            "phase_losses": {phase: [move["wp_loss"] for move in moves if move["phase"] == phase]
                             for phase in PHASES},
            "changes": [move["cp_after"] - move["cp_before"] for move in moves],
            "low_clock": [int(move["wp_loss"] >= engine.BLUNDER_DROP) for move in timed
                          if move["clock_frac"] < 0.10],
            "normal_clock": [int(move["wp_loss"] >= engine.BLUNDER_DROP) for move in timed
                             if move["clock_frac"] >= 0.10],
            "reached_winning": any(cp >= 300 for cp in positions),
            "reached_losing": any(cp <= -300 for cp in positions),
            "score": score_of(raw[color]["result"]),
            "won_on_time": raw[color]["result"] == "win" and raw[other]["result"] == "timeout",
            "missed": sum(bool(record["missed"]) for record in motifs
                          if record["is_me"] == (color == "white")),
            "allowed": sum(bool(record["allowed"]) for record in motifs
                           if record["is_me"] == (color == "white")),
        }
    data = {"sides": features, "engine_seconds": elapsed}
    write_json(path, data)
    return data, True


def evaluate_games(jobs, binary, cache, workers):
    version = subprocess.check_output([binary, "--version"], text=True, timeout=15).splitlines()[0]
    with Path(binary).open("rb") as handle:
        identity = hashlib.file_digest(handle, "sha256").hexdigest()[:16]
    destination = cache / f"games-v1-d{DEPTH}-{identity}"
    results = {}
    elapsed = uncached = 0
    started = time.perf_counter()
    print(f"Engine: {version}, depth {DEPTH}, {len(jobs)} distinct games", flush=True)
    try:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for i, (gid, (data, fresh)) in enumerate(zip(jobs, pool.map(
                lambda raw: analyse(raw, binary, destination), jobs.values()
            )), 1):
                results[gid] = data
                elapsed += data["engine_seconds"] if fresh else 0
                uncached += fresh
                if i % 250 == 0 or i == len(jobs):
                    print(f"Engine: {i}/{len(jobs)} games", flush=True)
    finally:
        for process in engine._all_engines:
            process.quit()
        engine._all_engines.clear()
    timing = {"version": version, "binary_sha256_prefix": identity, "depth": DEPTH,
              "games": len(jobs), "uncached_games": uncached, "engine_seconds_this_run": elapsed,
              "engine_seconds_all_games": sum(data["engine_seconds"] for data in results.values()),
              "stage_wall_seconds": time.perf_counter() - started}
    print(json.dumps(timing), flush=True)
    return results, timing


def mean(values):
    return float(np.mean(values)) if len(values) else math.nan


def history_features(history):
    def joined(key):
        return [value for game in history for value in game[key]]

    losses = joined("losses")
    return {
        "loss": mean(losses),
        **{f"loss_{phase}": mean([loss for game in history for loss in game["phase_losses"][phase]])
           for phase in PHASES},
        "low_clock_blunders": mean(joined("low_clock")),
        "normal_clock_blunders": mean(joined("normal_clock")),
        "conversion": mean([game["score"] == 1 for game in history if game["reached_winning"]]),
        "resilience": mean([game["score"] > 0 for game in history if game["reached_losing"]]),
        "sharpness": float(np.std(joined("changes"))) if losses else math.nan,
        "won_on_time": mean([game["won_on_time"] for game in history]),
        "missed_tactics": sum(game["missed"] for game in history) / len(losses) if losses else math.nan,
        "allowed_tactics": sum(game["allowed"] for game in history) / len(losses) if losses else math.nan,
    }


def feature_rows(rows, results):
    out = []
    for focal, raw, gid, ratings, histories in rows:
        color = side(raw, focal)
        other = "black" if color == "white" else "white"
        result = results[gid]["sides"]
        a, b = [history_features([results[key]["sides"][color] for key, color in hist])
                for hist in histories]
        elo = min(max(expected(*ratings), 1e-4), 1 - 1e-4)
        score = score_of(raw[color]["result"])
        out.append({
            "focal": focal, "gid": gid, "score": score,
            "accuracy_gap": mean(result[color]["losses"]) - mean(result[other]["losses"]),
            "elo": elo, "rating_logit": math.log(elo / (1 - elo)),
            **{f"focal_{key}": value for key, value in a.items()},
            **{f"opponent_{key}": value for key, value in b.items()},
            "focal_time_matchup": a["won_on_time"] * b["low_clock_blunders"],
            "opponent_time_matchup": b["won_on_time"] * a["low_clock_blunders"],
        })
    return out


def evaluate(rows):
    from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import LogisticRegression, Ridge
    from sklearn.metrics import r2_score
    from sklearn.model_selection import GroupKFold
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from threadpoolctl import threadpool_limits

    groups = np.array([row["focal"] for row in rows])
    score = np.array([row["score"] for row in rows])
    y = (2 * score).astype(int)
    gaps = np.array([row["accuracy_gap"] for row in rows])
    columns = [key for key in rows[0] if key not in {"focal", "gid", "score", "accuracy_gap", "elo"}]
    ratings = np.array([[row["rating_logit"]] for row in rows])
    full = np.array([[row[key] for key in columns] for row in rows])
    rng = np.random.default_rng(SEED)
    boosting = dict(learning_rate=0.03, max_iter=300, max_leaf_nodes=15,
                    min_samples_leaf=80, l2_regularization=1.0, random_state=SEED,
                    early_stopping=False)

    def oof(factory, features, target, mask, classification):
        X, target, fold_groups = features[mask], target[mask], groups[mask]
        result = np.zeros((len(X), 3) if classification else len(X))
        with threadpool_limits(limits=1):
            for train, test in GroupKFold(5).split(X, target, fold_groups):
                model = factory().fit(X[train], target[train])
                if classification:
                    result[np.ix_(test, model.classes_)] = model.predict_proba(X[test])
                else:
                    result[test] = model.predict(X[test])
        return result

    def logistic():
        return make_pipeline(SimpleImputer(keep_empty_features=True), StandardScaler(),
                             LogisticRegression(C=1, max_iter=5000))

    def ridge():
        return make_pipeline(SimpleImputer(keep_empty_features=True), StandardScaler(), Ridge())

    mask = np.ones(len(rows), dtype=bool)
    classifiers = {
        "Ratings only (logistic)": (logistic, ratings),
        "Ratings + engine (logistic)": (logistic, full),
        "Ratings only (boosting)": (lambda: HistGradientBoostingClassifier(**boosting), ratings),
        "Ratings + engine (boosting)": (lambda: HistGradientBoostingClassifier(**boosting), full),
    }
    odds = {}
    losses = {}
    for name, (factory, features) in classifiers.items():
        p = oof(factory, features, y, mask, True)
        brier = (p[:, 2] + 0.5 * p[:, 1] - score) ** 2
        log_loss = -np.log(np.clip(p[np.arange(len(y)), y], 1e-12, 1))
        odds[name] = {"brier": float(brier.mean()), "log_loss": float(log_loss.mean())}
        losses[name] = brier, log_loss
    for family in ("logistic", "boosting"):
        name = f"Ratings + engine ({family})"
        for metric, i in (("brier", 0), ("log_loss", 1)):
            change = losses[f"Ratings only ({family})"][i] - losses[name][i]
            odds[name][f"{metric}_improvement"] = float(change.mean())
            odds[name][f"{metric}_interval_90"] = _boot(change, groups, rng).tolist()
    odds["Elo formula"] = {"brier": float(np.mean((np.array([row["elo"] for row in rows]) - score) ** 2))}
    intervals = [value["brier_interval_90"] for value in odds.values() if "brier_interval_90" in value]
    mde = max((high - low) / 2 for low, high in intervals)

    gap_mask = np.isfinite(gaps)
    accuracy = {"n": int(gap_mask.sum()), "focal_players": len(set(groups[gap_mask]))}
    if accuracy["focal_players"] >= 5 and np.var(gaps[gap_mask]) > 0:
        for name, factory in (("ridge", ridge), ("boosting", lambda: HistGradientBoostingRegressor(**boosting))):
            accuracy[name] = {
                label: float(r2_score(gaps[gap_mask], oof(factory, features, gaps, gap_mask, False)))
                for label, features in (("ratings_only", ratings), ("ratings_and_engine", full))
            }
    return {"games": len(rows), "focal_players": len(set(groups)),
            "outcomes": dict(zip(("loss", "draw", "win"), np.bincount(y, minlength=3).tolist())),
            "odds": odds, "accuracy_gap": accuracy, "mde_brier_half_width": mde,
            "mde_expected_score_approx": math.sqrt(mde)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "data/odds/v3")
    parser.add_argument("--count", type=int, default=1000)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    if args.count < 1 or args.workers < 1:
        parser.error("count and workers must be positive")
    source = args.source.resolve()
    cache = ROOT / "data/odds/engine"
    targets_path = source / "targets.json"
    if not targets_path.is_file() or not (source / "players").is_dir():
        parser.error(f"Expected targets.json and players/ under {source}")
    targets_bytes = targets_path.read_bytes()
    targets = sample_targets(json.loads(targets_bytes), args.count)
    focal_count = len({target["focal"].lower() for target in targets})
    if len(targets) < args.count or focal_count < 5:
        parser.error(f"Requested {args.count} distinct targets and five focal players, "
                     f"found {len(targets)} targets from {focal_count} focal players in {source}")
    binary = engine.find_stockfish()
    if not binary:
        parser.error("Stockfish binary not found. Set STOCKFISH_PATH.")
    rows, jobs, exclusions = plan(targets, source, cache)
    output = {"sampled": len(targets), "sampled_focal_players": focal_count, "seed": SEED,
              "targets_sha256": hashlib.sha256(targets_bytes).hexdigest(),
              "exclusions": exclusions, "eligible": len(rows),
              "eligible_focal_players": len({row[0] for row in rows})}
    print(json.dumps(output), flush=True)
    if output["eligible_focal_players"] < 5:
        parser.error("Fewer than five eligible focal players after checking history coverage")
    results, output["engine"] = evaluate_games(jobs, binary, cache, args.workers)
    output.update(evaluate(feature_rows(rows, results)))
    path = cache / f"results-{output['targets_sha256'][:12]}-{args.count}.json"
    write_json(path, output)
    print(json.dumps(output, indent=2))
    print(f"Saved {path}")


if __name__ == "__main__":
    main()
