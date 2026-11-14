"""Does account history predict a game's result better than ratings alone?

For each target game between a focal player and an opponent, pre-game
features come only from games that ENDED BEFORE the target game (players play
one game at a time, so those finished before it started). Features:

  rating     - logit of the Elo expected score from PRE-game ratings (the
               baseline uses only this; the archive's ratings are post-game)
  form       - each player's mean (score - expected) over their last 20 games
  color      - each player's mean residual with this game's color (last 50)
  opening    - each player's most-played opening family with their color, and
               both players' shrunk residuals in that family with their colors
  session    - last-3 results, games in the last hour, minutes since last game

Models (multinomial logistic regression over win/draw/loss): ratings only vs
ratings + history. Scored on held-out focal players (grouped 5-fold CV) by
log loss and Brier score of the expected score, with a bootstrap interval on
the improvement.

  python scripts/eval_odds.py collect --focal 30 --per 60   # cached in data/odds/
  python scripts/eval_odds.py evaluate
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from wf.fetch import DRAW_RESULTS, HEADERS, opening_names  # noqa: E402

DATA = ROOT / "data" / "odds"
API = "https://api.chess.com/pub/player/{u}/games/archives"
SESSION = requests.Session()


def expected(a: float, b: float) -> float:
    return 1 / (1 + 10 ** ((b - a) / 400))


def score_of(result: str) -> float:
    return 1.0 if result == "win" else 0.5 if result in DRAW_RESULTS else 0.0


def _get(url: str):
    for attempt in range(4):
        r = SESSION.get(url, headers=HEADERS, timeout=30)
        if r.status_code == 429:
            time.sleep(2 + 2 * attempt)
            continue
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()
    return None


_HIST: dict[str, list[dict]] = {}


def player_games(user: str, months: int = 2) -> list[dict]:
    """A player's blitz games with pre-game ratings (see with_pregame)."""
    key = user.lower()
    if key not in _HIST:
        _HIST[key] = with_pregame(_raw_games(user, months))
    return _HIST[key]


def with_pregame(games: list[dict]) -> list[dict]:
    """Chess.com's archive stores each player's rating AFTER the game, so the winner's rating
    already includes the points they won. A player's rating before a game is their rating after
    their previous game. The opponent's pre-game rating in a past game is estimated by assuming
    they moved by the same number of points the other way; for target games it is read exactly
    from the opponent's own history (pregame_rating)."""
    out, prev = [], None
    for g in games:
        if prev is not None:
            out.append({**g, "my_pre": prev, "opp_pre": g["opp"] + (g["my"] - prev)})
        prev = g["my"]
    return out


def pregame_rating(hist: list[dict], t: int) -> float | None:
    """A player's rating going into a game that ended at t: their rating after their last earlier game."""
    h = [g for g in hist if g["end"] < t]
    return h[-1]["my"] if h else None


def _raw_games(user: str, months: int = 2) -> list[dict]:
    """A player's blitz games from the last `months` archives, compact and cached."""
    path = DATA / "players" / f"{user.lower()}.json"
    if path.exists():
        return json.loads(path.read_text())
    arch = _get(API.format(u=user.lower())) or {}
    out = []
    for url in (arch.get("archives") or [])[-months:]:
        for g in (_get(url) or {}).get("games", []):
            if g.get("rules") != "chess" or g.get("time_class") != "blitz":
                continue
            u = user.lower()
            if g["white"]["username"].lower() == u:
                me, opp, color = g["white"], g["black"], "white"
            elif g["black"]["username"].lower() == u:
                me, opp, color = g["black"], g["white"], "black"
            else:
                continue
            out.append({"url": g["url"], "end": g.get("end_time", 0), "color": color, "my": me["rating"],
                        "opp": opp["rating"], "opp_name": opp["username"].lower(), "score": score_of(me["result"]),
                        "family": opening_names(g.get("eco", ""))[1]})
        time.sleep(0.05)
    out.sort(key=lambda x: x["end"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out))
    return out


def collect(focal_n: int, per: int, seed_user: str):
    seed = player_games(seed_user)
    pool = [n for n, _ in Counter(g["opp_name"] for g in seed).most_common()]
    focal = []
    for name in pool:
        if len(focal) >= focal_n:
            break
        if len(player_games(name)) >= per + 50:      # enough history before the target games
            focal.append(name)
            print(f"focal {len(focal)}: {name}", flush=True)
    targets = []
    for f in focal:
        games = player_games(f)
        for g in games[-per:]:
            player_games(g["opp_name"])              # cache the opponent's history
            targets.append({"focal": f, **g})
        print(f"{f}: {per} target games, opponents cached", flush=True)
    (DATA / "targets.json").write_text(json.dumps(targets))
    print(f"{len(targets)} target games from {len(focal)} focal players")


# ---------- features ----------

def _before(games: list[dict], t: int) -> list[dict]:
    return [g for g in games if g["end"] < t]


def _resid(g):
    return g["score"] - expected(g["my_pre"], g["opp_pre"])


def _shrunk_mean(xs: list[float], k: float = 10.0) -> float:
    return sum(xs) / (len(xs) + k) if xs else 0.0


def side_features(hist: list[dict], color: str, t: int) -> dict:
    h = _before(hist, t)
    last20 = h[-20:]
    col = [g for g in h if g["color"] == color][-50:]
    fams = Counter(g["family"] for g in col)
    top = fams.most_common(1)[0][0] if fams else None
    last = h[-1] if h else None
    return {
        "n": len(h), "form": _shrunk_mean([_resid(g) for g in last20]),
        "color": _shrunk_mean([_resid(g) for g in col]), "top_family": top,
        "streak": sum(g["score"] for g in h[-3:]) / 3 if len(h) >= 3 else 0.5,
        "hour": sum(1 for g in h if t - g["end"] < 3600),
        "gap": min((t - last["end"]) / 60, 600) if last else 600,
    }


def family_resid(hist: list[dict], family: str | None, color: str, t: int) -> float:
    if not family:
        return 0.0
    return _shrunk_mean([_resid(g) for g in _before(hist, t) if g["family"] == family and g["color"] == color])


FEATURES = ["rating_logit", "form_me", "form_opp", "color_me", "color_opp",
            "open_me_in_mine", "open_opp_in_mine", "open_me_in_theirs", "open_opp_in_theirs",
            "streak_me", "streak_opp", "hour_me", "hour_opp", "loggap_me", "loggap_opp"]


def build_rows():
    targets = json.loads((DATA / "targets.json").read_text())
    rows = []
    for g in targets:
        me_hist = player_games(g["focal"])
        opp_hist = player_games(g["opp_name"])
        t = g["end"]
        opp_color = "black" if g["color"] == "white" else "white"
        a, b = side_features(me_hist, g["color"], t), side_features(opp_hist, opp_color, t)
        if a["n"] < 30 or b["n"] < 10:
            continue
        my_pre, opp_pre = pregame_rating(me_hist, t), pregame_rating(opp_hist, t)
        if my_pre is None or opp_pre is None:
            continue
        e = min(max(expected(my_pre, opp_pre), 1e-4), 1 - 1e-4)
        rows.append({
            "focal": g["focal"], "y": {1.0: 2, 0.5: 1, 0.0: 0}[g["score"]], "score": g["score"], "expected": e,
            "rating_logit": math.log(e / (1 - e)),
            "form_me": a["form"], "form_opp": b["form"], "color_me": a["color"], "color_opp": b["color"],
            # each side's most-played opening with its color, and both players' records in it
            "open_me_in_mine": family_resid(me_hist, a["top_family"], g["color"], t),
            "open_opp_in_mine": family_resid(opp_hist, a["top_family"], opp_color, t),
            "open_me_in_theirs": family_resid(me_hist, b["top_family"], g["color"], t),
            "open_opp_in_theirs": family_resid(opp_hist, b["top_family"], opp_color, t),
            "streak_me": a["streak"], "streak_opp": b["streak"], "hour_me": a["hour"], "hour_opp": b["hour"],
            "loggap_me": math.log1p(a["gap"]), "loggap_opp": math.log1p(b["gap"]),
        })
    return rows


def evaluate():
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import GroupKFold
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    rows = build_rows()
    y = np.array([r["y"] for r in rows])
    score = np.array([r["score"] for r in rows])
    groups = np.array([r["focal"] for r in rows])
    X_full = np.array([[r[f] for f in FEATURES] for r in rows])
    X_base = X_full[:, :1]
    print(f"{len(rows)} games, {len(set(groups))} focal players; wins {np.mean(y == 2):.1%}, "
          f"draws {np.mean(y == 1):.1%}, losses {np.mean(y == 0):.1%}")

    def oof(X):
        p = np.zeros((len(y), 3))
        for tr, te in GroupKFold(5).split(X, y, groups):
            m = make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=5000)).fit(X[tr], y[tr])
            p[te] = m.predict_proba(X[te])
        return p

    p_base, p_full = oof(X_base), oof(X_full)

    def ll(p):     # per-game 3-class log loss
        return -np.log(np.clip(p[np.arange(len(y)), y], 1e-12, 1))

    def brier(p):  # squared error of the expected score
        return (p[:, 2] + 0.5 * p[:, 1] - score) ** 2

    # raw Elo (no fitting) for reference: Brier of the expected score
    elo_brier = (np.array([r["expected"] for r in rows]) - score) ** 2
    d_ll, d_br = ll(p_base) - ll(p_full), brier(p_base) - brier(p_full)   # > 0 means history helps
    rng = np.random.default_rng(0)
    focal_ids = np.unique(groups)

    def boot(d):   # resample focal players (games within a player are correlated)
        idx = {f: np.where(groups == f)[0] for f in focal_ids}
        stats = []
        for _ in range(2000):
            pick = rng.choice(focal_ids, len(focal_ids))
            sel = np.concatenate([idx[f] for f in pick])
            stats.append(d[sel].mean())
        return np.percentile(stats, [5, 95])

    lo_ll, hi_ll = boot(d_ll)
    lo_br, hi_br = boot(d_br)
    print("\n| Model | Log loss (W/D/L) | Brier (expected score) |")
    print("|---|---:|---:|")
    print(f"| Raw Elo formula | n/a | {elo_brier.mean():.4f} |")
    print(f"| Ratings only (fitted) | {ll(p_base).mean():.4f} | {brier(p_base).mean():.4f} |")
    print(f"| Ratings + history | {ll(p_full).mean():.4f} | {brier(p_full).mean():.4f} |")
    print(f"\nImprovement from history (positive = better), 90% bootstrap interval over players:")
    print(f"  log loss {d_ll.mean():+.4f} ({lo_ll:+.4f} to {hi_ll:+.4f}); "
          f"relative {100 * d_ll.mean() / ll(p_base).mean():+.2f}%")
    print(f"  Brier    {d_br.mean():+.4f} ({lo_br:+.4f} to {hi_br:+.4f}); "
          f"relative {100 * d_br.mean() / brier(p_base).mean():+.2f}%")
    m = make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=5000)).fit(X_full, y)
    coef = m[-1].coef_[2] - m[-1].coef_[0]          # win minus loss, per standardized feature
    print("\nWin-vs-loss weight per standardized feature (full data):")
    for f, c in sorted(zip(FEATURES, coef), key=lambda x: -abs(x[1])):
        print(f"  {f:20s} {c:+.3f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["collect", "evaluate"])
    ap.add_argument("--focal", type=int, default=30)
    ap.add_argument("--per", type=int, default=60)
    ap.add_argument("--seed-user", default="ashton-iwnl")
    args = ap.parse_args()
    if args.cmd == "collect":
        collect(args.focal, args.per, args.seed_user)
    else:
        evaluate()


if __name__ == "__main__":
    main()
