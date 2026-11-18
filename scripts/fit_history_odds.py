"""Test two-sided blitz history on the session study's time split.

Uses the v3 snapshots for histories and outcomes and only game IDs and timestamps
from the stored Chess.com PGN metadata. No position or engine measurements are read.

  python scripts/fit_history_odds.py
"""
from __future__ import annotations

import argparse
import json
import math
from bisect import bisect_left
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit

from eval_odds import DATA, ROOT, expected
from chesscheck.stats import CALIBRATION, ELO_LOGIT_LIMIT

WINDOWS = (50, 150, 200)
DEPLOY_WINDOW = 200
MIN_HISTORY = 30
FEATURES = ("below_peak", "rating_vs_average", "loss_streak", "lost_last", "shrunk_tilt")
BOOTSTRAPS = 2000


def history_features(games: list[dict]) -> np.ndarray:
    """Features of one side's chronological pre-target window."""
    ratings = [game["my"] for game in games]
    latest = ratings[-1]
    loss_streak = 0
    for game in reversed(games[-6:]):
        if game["score"] != 0:
            break
        loss_streak += 1

    # Use the previous game's post-game rating and estimate the other player's
    # change as its negative, as in the one-sided session study.
    residual = {0.0: 0.0, 1.0: 0.0}
    count = {0.0: 20, 1.0: 20}
    for previous, game in zip(games, games[1:]):
        score = previous["score"]
        if score in count and game["end"] - previous["end"] < 1800:
            my_pre = previous["my"]
            opp_pre = game["opp"] + game["my"] - my_pre
            residual[score] += game["score"] - expected(my_pre, opp_pre)
            count[score] += 1

    return np.array([
        max(ratings) - latest, latest - sum(ratings) / len(ratings), loss_streak,
        float(loss_streak > 0), residual[0.0] / count[0.0] - residual[1.0] / count[1.0],
    ])


def assemble(source: Path, metadata: str, fit_before: int, test_from: int):
    with duckdb.connect() as con:
        candidates = con.execute("""
            SELECT game_id, lower(white), lower(black), start_ts, end_ts
            FROM read_parquet(?)
            WHERE time_class = 'blitz' AND start_ts > 0 AND start_ts <= end_ts
                AND (end_ts < ? OR end_ts >= ?)
            ORDER BY end_ts, game_id
        """, [metadata, fit_before, test_from]).fetchall()

    paths = {path.stem: path for path in (source / "players").glob("*.json")}
    wanted = defaultdict(set)
    for game_id, white, black, _, _ in candidates:
        if white in paths and black in paths and white != black:
            wanted[white].add(game_id)
            wanted[black].add(game_id)

    # Retain only the indexes of target games and the histories of their players.
    histories = {}
    for player, ids in sorted(wanted.items()):
        games = sorted(
            (g for g in json.loads(paths[player].read_text())["games"] if g["end"] > 0),
            key=lambda g: (g["end"], g["url"]),
        )
        ends = [g["end"] for g in games]
        targets = {g["url"].rsplit("/", 1)[-1]: g for g in games
                   if g["url"].rsplit("/", 1)[-1] in ids}
        histories[player] = games, ends, targets

    rows, players, sizes, differences = [], [], [], []
    seen = set()
    for game_id, white, black, start, end in candidates:
        if game_id in seen or white not in histories or black not in histories or white == black:
            continue
        wg, we, wt = histories[white]
        bg, be, bt = histories[black]
        w, b = wt.get(game_id), bt.get(game_id)
        if (w is None or b is None or w["color"] != "white" or b["color"] != "black"
                or w["opp_name"] != black or b["opp_name"] != white
                or w["end"] != end or b["end"] != end or w["score"] + b["score"] != 1):
            continue
        wi, bi = bisect_left(we, start), bisect_left(be, start)
        if min(wi, bi) < MIN_HISTORY:
            continue
        # Both players get their own prior rating, independent of the target result.
        rating_logit = (wg[wi - 1]["my"] - bg[bi - 1]["my"]) / 400 * math.log(10)
        rows.append((np.clip(rating_logit, -ELO_LOGIT_LIMIT, ELO_LOGIT_LIMIT),
                     w["score"], end >= test_from))
        players.append((white, black))
        sizes.append(min(wi, bi))
        differences.append([
            history_features(wg[max(wi - n, 0):wi]) - history_features(bg[max(bi - n, 0):bi])
            for n in WINDOWS
        ])
        seen.add(game_id)

    if not rows:
        raise ValueError("No matched games with sufficient histories and a verified start time.")
    return np.asarray(rows), np.asarray(players), np.asarray(sizes), np.asarray(differences)


def fit_adjustment(x: np.ndarray, score: np.ndarray, offset: np.ndarray) -> np.ndarray:
    """Fit a no-intercept logistic adjustment, treating draws as half a win."""
    scale = np.sqrt(np.mean(x ** 2, axis=0))
    scale[scale == 0] = 1
    scaled = x / scale

    def objective(w):
        logit = offset + scaled @ w
        return (np.mean(np.logaddexp(0, logit) - score * logit),
                scaled.T @ (expit(logit) - score) / len(score))

    result = minimize(objective, np.zeros(x.shape[1]), jac=True, method="BFGS",
                      options={"gtol": 1e-10})
    if not result.success:
        raise RuntimeError(f"Fit failed: {result.message}")
    return result.x / scale


def player_bootstrap(gains: np.ndarray, players: np.ndarray) -> np.ndarray:
    """Resample player IDs once per replicate, using both endpoints of each game."""
    ids, inverse = np.unique(players, return_inverse=True)
    white, black = inverse.reshape(players.shape).T
    rng = np.random.default_rng(0)
    means = []
    for _ in range(BOOTSTRAPS):
        counts = np.bincount(rng.integers(len(ids), size=len(ids)), minlength=len(ids))
        weights = counts[white] * counts[black]
        if weights.sum():
            means.append(weights @ gains / weights.sum())
    return np.percentile(means, [5, 95], axis=0).T


def calibration(p: np.ndarray, score: np.ndarray):
    """Expected versus actual score in ten equally populated prediction bins."""
    order = np.argsort(p, kind="stable")
    bins = [(len(i), p[i].mean(), score[i].mean()) for i in np.array_split(order, 10)]
    error = sum(n * abs(pred - actual) for n, pred, actual in bins) / len(score)
    return error, bins


def utc_date(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DATA)
    parser.add_argument("--metadata", default=str(ROOT / "data/engine/v1/games/part-*.parquet"))
    parser.add_argument("--fit-before", type=utc_date, default="2026-11-01")
    parser.add_argument("--test-from", type=utc_date, default="2026-11-07")
    args = parser.parse_args()
    if args.fit_before >= args.test_from:
        parser.error("--fit-before must precede --test-from")

    rows, players, sizes, diff = assemble(args.source, args.metadata, args.fit_before, args.test_from)
    rating, score, test = rows.T
    test = test.astype(bool)
    train = ~test
    if not train.any() or test.sum() < 10:
        raise ValueError("Need training games and at least ten test games.")
    print(f"{train.sum():,} fit games, {test.sum():,} test games "
          f"({np.unique(players[train]).size:,} fit players, {np.unique(players[test]).size:,} test players)")
    for n in WINDOWS:
        print(f"Both sides have at least {n} prior games: "
              f"{(sizes[train] >= n).sum():,} fit, {(sizes[test] >= n).sum():,} test")

    a, b = CALIBRATION["blitz"]
    base = a * rating + b  # Every unique target is oriented to White.
    models = {"Current formula": base[test]}
    for j, n in enumerate(WINDOWS):
        x = diff[:, j, :]
        w = fit_adjustment(x[train], score[train], base[train])
        models[f"{n}-game history"] = base[test] + x[test] @ w
        print(f"{n}-game coefficients: " + ", ".join(f"{name}={coef:.12g}" for name, coef in zip(FEATURES, w)))

    y = score[test]
    logits = np.column_stack(list(models.values()))
    p = expit(logits)
    brier = (p - y[:, None]) ** 2
    log_loss = np.mean(np.logaddexp(0, logits) - y[:, None] * logits, axis=0)
    gains = brier[:, :1] - brier[:, 1:]
    intervals = player_bootstrap(gains, players[test])
    cal = [calibration(pred, y) for pred in p.T]

    print("\n| Model | Brier | Brier gain (90% interval) | Log loss | Decile error |")
    print("|---|---:|---:|---:|---:|")
    for i, name in enumerate(models):
        gain = ""
        if i:
            lo, hi = intervals[i - 1]
            gain = f"{gains[:, i - 1].mean():+.7f} ({lo:+.7f} to {hi:+.7f})"
        print(f"| {name} | {brier[:, i].mean():.7f} | {gain} | {log_loss[i]:.7f} | {cal[i][0]:.7f} |")

    print("\n| Decile | " + " | ".join(models) + " |")
    print("|---:" * (len(models) + 1) + "|")
    for i in range(10):
        print(f"| {i + 1} | " + " | ".join(f"{bins[i][1]:.4f} / {bins[i][2]:.4f}" for _, bins in cal) + " |")

    j = WINDOWS.index(DEPLOY_WINDOW)
    improves = intervals[j, 0] > 0
    calibrated = cal[j + 1][0] <= cal[0][0]
    print(f"\n{DEPLOY_WINDOW}-game gate: {'PASS' if improves and calibrated else 'FAIL'} "
          f"(positive 90% interval: {improves}; decile error no worse: {calibrated})")


if __name__ == "__main__":
    main()
