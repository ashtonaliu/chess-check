"""Fit the recap's expected-score formula for each time class.

The Elo formula is overconfident in matched games and ignores colour. This fits, for bullet,
blitz and rapid separately,

    expected = sigmoid(a * logit(Elo expected) + b * colour)       colour = +1 White, -1 Black

on games that ended before --fit-before and checks it on games from --test-from, against the
Elo formula. Each game is used from both players' sides, so the formula is symmetric (no
intercept): flipping colour and ratings gives exactly 1 - expected. Ratings are pre-game: each
player's rating after their previous game in that time class (the archive stores post-game
ratings), and the opponent's is estimated by assuming they moved by the same amount.

  python scripts/fit_expected_score.py collect --players 1500   # data/odds/calib/
  python scripts/fit_expected_score.py fit
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import eval_odds as E  # noqa: E402

OUT = E.ROOT / "data" / "odds" / "calib"
CLASSES = ("bullet", "blitz", "rapid")


def fetch(user: str) -> None:
    path = OUT / f"{user}.json"
    if path.exists():
        return
    arch = E._get(E.API.format(u=user)) or {}
    games = []
    for url in (arch.get("archives") or [])[-2:]:
        for g in (E._get(url) or {}).get("games", []):
            if g.get("rules") != "chess" or g.get("time_class") not in CLASSES:
                continue
            me = "white" if g["white"]["username"].lower() == user else "black" if g["black"]["username"].lower() == user else None
            if not me:
                continue
            opp = "black" if me == "white" else "white"
            games.append([g.get("end_time", 0), g["time_class"], me == "white", g[me]["rating"], g[opp]["rating"],
                          E.score_of(g[me]["result"])])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sorted(games)))


def collect(n: int, threads: int) -> None:
    names = sorted((p.stem for p in (E.DATA / "players").glob("*.json")), key=lambda s: hashlib.sha1(s.encode()).hexdigest())[:n]
    with ThreadPoolExecutor(threads) as ex:
        for i, _ in enumerate(ex.map(fetch, names), 1):
            if i % 250 == 0:
                print(f"{i}/{len(names)}", flush=True)


def rows_for(tc: str, fit_before: int, test_from: int):
    out = []
    for f in OUT.glob("*.json"):
        prev = None
        for end, cls, white, my, opp, score in json.loads(f.read_text()):
            if cls != tc:
                continue
            if prev is not None and not (fit_before <= end < test_from):
                my_pre, opp_pre = prev, opp + (my - prev)
                e = min(max(E.expected(my_pre, opp_pre), 1e-4), 1 - 1e-4)
                out.append((math.log(e / (1 - e)), 1.0 if white else -1.0, score, e, end >= test_from, f.stem))
            prev = my
    return out


def fit_symmetric(x: np.ndarray, s: np.ndarray) -> np.ndarray:
    """Logistic fit of the expected score with soft labels, using each game from both sides, no intercept."""
    X = np.vstack([x, -x]); y = np.concatenate([s, 1 - s])
    w = np.zeros(X.shape[1])
    for _ in range(50):                                    # Newton's method
        p = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (y - p); H = (X * (p * (1 - p))[:, None]).T @ X
        w += np.linalg.solve(H + 1e-9 * np.eye(len(w)), g)
    return w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["collect", "fit"])
    ap.add_argument("--players", type=int, default=1500)
    ap.add_argument("--threads", type=int, default=6)
    ap.add_argument("--fit-before", default="2026-11-01")
    ap.add_argument("--test-from", default="2026-11-07")
    a = ap.parse_args()
    if a.cmd == "collect":
        collect(a.players, a.threads); return
    ts = lambda d: int(dt.datetime.fromisoformat(d).replace(tzinfo=dt.timezone.utc).timestamp())
    rng = np.random.default_rng(0)
    print("| Time class | Fit games | Test games | a (rating) | b (colour) | Elo Brier | Formula Brier | Gain (90% interval) |")
    print("|---|---:|---:|---:|---:|---:|---:|---|")
    for tc in CLASSES:
        r = rows_for(tc, ts(a.fit_before), ts(a.test_from))
        if not r:
            continue
        arr = np.array([x[:4] for x in r]); test = np.array([x[4] for x in r]); who = np.array([x[5] for x in r])
        w = fit_symmetric(arr[~test, :2], arr[~test, 2])
        p = 1 / (1 + np.exp(-arr[test, :2] @ w)); s = arr[test, 2]
        elo, new = (arr[test, 3] - s) ** 2, (p - s) ** 2
        lo, hi = E._boot(elo - new, who[test], rng, 300)
        print(f"| {tc} | {(~test).sum():,} | {test.sum():,} | {w[0]:.4f} | {w[1]:.4f} | {elo.mean():.5f} | {new.mean():.5f} | "
              f"{(elo - new).mean():+.5f} ({lo:+.5f} to {hi:+.5f}) |")


if __name__ == "__main__":
    main()
