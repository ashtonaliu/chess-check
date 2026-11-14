"""Does account history predict a game's result better than ratings alone?

For each target game between a focal player and an opponent, pre-game
features come only from games that ENDED BEFORE the target game (players play
one game at a time, so those finished before it started). Chess.com's archive
stores each player's rating AFTER the game, so every rating here is the
player's rating after their previous game (see with_pregame).

Features:
  rating     - logit of the Elo expected score (the baseline uses only this)
  form       - each player's mean residual (score - expected) over their last 20 games
  color      - each player's mean residual with this game's color (last 50)
  opening    - each side's most-played opening with its color, and both
               players' shrunk residuals in it
  matchup    - each player's results in the openings the OTHER player usually
               plays with this game's colors (my weakness meets your repertoire)
  clock      - how often each player loses on time, wins on time, and how much
               clock they usually have left
  session    - last-3 results, games in the last hour, minutes since last game

Models over win/draw/loss: logistic regression on ratings only, logistic
regression on everything, and gradient boosting on everything (which can
learn interactions such as a slow player against a fast one). Scored on
held-out focal players (grouped 5-fold CV) by log loss and Brier score of the
expected score, with bootstrap intervals over players. A targeted check then
looks only at games where a matchup weakness applies.

  python scripts/eval_odds.py collect --focal 200 --per 60   # cached in data/odds/v2/
  python scripts/eval_odds.py evaluate
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from wf.fetch import DRAW_RESULTS, HEADERS, opening_names  # noqa: E402

DATA = ROOT / "data" / "odds" / "v2"
V1_PLAYERS = ROOT / "data" / "odds" / "players"     # first, smaller run: used only to pick focal players
API = "https://api.chess.com/pub/player/{u}/games/archives"
_local = threading.local()
CLK = re.compile(r"\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]")


def expected(a: float, b: float) -> float:
    return 1 / (1 + 10 ** ((b - a) / 400))


def score_of(result: str) -> float:
    return 1.0 if result == "win" else 0.5 if result in DRAW_RESULTS else 0.0


def _get(url: str):
    s = getattr(_local, "s", None) or requests.Session()
    _local.s = s
    for attempt in range(6):
        try:
            r = s.get(url, headers=HEADERS, timeout=30)
        except requests.RequestException:
            time.sleep(2 + 2 * attempt)
            continue
        if r.status_code == 429:
            time.sleep(3 + 3 * attempt)
            continue
        if r.status_code in (404, 410):
            return None
        if r.status_code >= 500:
            time.sleep(2 + 2 * attempt)
            continue
        r.raise_for_status()
        return r.json()
    return None


def _clocks(pgn: str) -> tuple[list[float], list[float]]:
    secs = [int(h) * 3600 + int(m) * 60 + float(s) for h, m, s in CLK.findall(pgn or "")]
    return secs[0::2], secs[1::2]          # white's clocks, black's clocks


def _raw_games(user: str, months: int = 2) -> list[dict]:
    """A player's blitz games from the last `months` archives, compact and cached."""
    path = DATA / "players" / f"{user.lower()}.json"
    if path.exists():
        return json.loads(path.read_text())
    arch = _get(API.format(u=user.lower())) or {}
    out = []
    u = user.lower()
    for url in (arch.get("archives") or [])[-months:]:
        for g in (_get(url) or {}).get("games", []):
            if g.get("rules") != "chess" or g.get("time_class") != "blitz":
                continue
            if g["white"]["username"].lower() == u:
                me, opp, color = g["white"], g["black"], "white"
            elif g["black"]["username"].lower() == u:
                me, opp, color = g["black"], g["white"], "black"
            else:
                continue
            wc, bc = _clocks(g.get("pgn", ""))
            mine, theirs = (wc, bc) if color == "white" else (bc, wc)
            head = str(g.get("time_control", "180")).split("+")[0]
            base = float(head) if head.replace(".", "").isdigit() else 180.0
            out.append({"url": g["url"], "end": g.get("end_time", 0), "color": color, "my": me["rating"],
                        "opp": opp["rating"], "opp_name": opp["username"].lower(), "score": score_of(me["result"]),
                        "family": opening_names(g.get("eco", ""))[1], "my_res": me["result"], "opp_res": opp["result"],
                        "plies": len(wc) + len(bc), "my_clk": mine[-1] if mine else None,
                        "opp_clk": theirs[-1] if theirs else None, "base": base})
    out.sort(key=lambda x: x["end"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, separators=(",", ":")))
    return out


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


# ---------- collection ----------

def _parallel(names: list[str], threads: int, label: str):
    todo = [n for n in names if not (DATA / "players" / f"{n.lower()}.json").exists()]
    print(f"{label}: {len(names)} players, {len(todo)} to fetch", flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(threads) as ex:
        futs = [ex.submit(_raw_games, n) for n in todo]
        for i, f in enumerate(as_completed(futs), 1):
            try:
                f.result()
            except Exception as e:      # one bad player should not stop the run
                print(f"  failed: {e}", flush=True)
            if i % 250 == 0 or i == len(todo):
                rate = i / (time.time() - t0)
                print(f"  {i}/{len(todo)} ({rate:.1f} players/s, ~{(len(todo) - i) / rate / 60:.0f} min left)", flush=True)


def collect(focal_n: int, per: int, threads: int):
    """Focal players: a fixed pseudo-random sample of players from the first run who had enough
    blitz games. Targets: each focal player's last `per` games. Every target opponent is cached."""
    cands = sorted((p.stem for p in V1_PLAYERS.glob("*.json") if len(json.loads(p.read_text())) >= per + 70),
                   key=lambda n: hashlib.sha1(n.encode()).hexdigest())[: int(focal_n * 1.3)]
    _parallel(cands, threads, "focal candidates")
    focal = [n for n in cands if len(player_games(n)) >= per + 50][:focal_n]
    targets = []
    for f in focal:
        targets += [{"focal": f, **g} for g in player_games(f)[-per:]]
    _parallel(sorted({g["opp_name"] for g in targets}), threads, "opponents")
    (DATA / "targets.json").write_text(json.dumps(targets, separators=(",", ":")))
    print(f"{len(targets)} target games from {len(focal)} focal players")


# ---------- features ----------

def _before(games: list[dict], t: int) -> list[dict]:
    return [g for g in games if g["end"] < t]


def _resid(g):
    return g["score"] - expected(g["my_pre"], g["opp_pre"])


def _shrunk_mean(xs: list[float], k: float = 10.0) -> float:
    return sum(xs) / (len(xs) + k) if xs else 0.0


def _rate(hits: int, n: int, prior: float, k: float = 10.0) -> float:
    return (hits + prior * k) / (n + k)


def side_features(hist: list[dict], color: str, t: int) -> dict:
    h = _before(hist, t)
    last20, last50 = h[-20:], h[-50:]
    col = [g for g in h if g["color"] == color][-50:]
    fams = Counter(g["family"] for g in col)
    top = fams.most_common(1)[0][0] if fams else None
    last = h[-1] if h else None
    losses = [g for g in last50 if g["score"] == 0]
    wins = [g for g in last50 if g["score"] == 1]
    clk = [g["my_clk"] / g["base"] for g in last50 if g.get("my_clk") is not None and g.get("base")]
    return {
        "n": len(h), "form": _shrunk_mean([_resid(g) for g in last20]),
        "color": _shrunk_mean([_resid(g) for g in col]), "top_family": top,
        "repertoire": {f: c / len(col) for f, c in fams.items()} if col else {},
        "streak": sum(g["score"] for g in h[-3:]) / 3 if len(h) >= 3 else 0.5,
        # Session features are measured from the end of the player's previous game, not from the
        # target game's end: that end time includes how long the target game lasted, which gives
        # away how it ended (a first version leaked the result this way; see evaluate's notes).
        "hour": sum(1 for g in h if last and last["end"] - g["end"] < 3600),
        "gap": min((last["end"] - h[-2]["end"]) / 60, 600) if len(h) >= 2 else 600,
        # share of losses that were on time, and share of wins where the opponent ran out of time
        "lose_time": _rate(sum(g["my_res"] == "timeout" for g in losses), len(losses), 0.3),
        "win_time": _rate(sum(g["opp_res"] == "timeout" for g in wins), len(wins), 0.3),
        "clock_left": (sum(clk) + 0.2 * 10) / (len(clk) + 10),
    }


def family_resid(hist: list[dict], family: str | None, color: str, t: int) -> float:
    if not family:
        return 0.0
    return _shrunk_mean([_resid(g) for g in _before(hist, t) if g["family"] == family and g["color"] == color])


def vs_repertoire(hist: list[dict], repertoire: dict[str, float], color: str, t: int) -> float:
    """A player's shrunk residual in the openings the other side usually plays, weighted by how often."""
    if not repertoire:
        return 0.0
    by_fam: dict[str, list[float]] = {}
    for g in _before(hist, t):
        if g["color"] == color:
            by_fam.setdefault(g["family"], []).append(_resid(g))
    return sum(p * _shrunk_mean(by_fam.get(f, [])) for f, p in repertoire.items())


BASE = ["rating_logit"]
V1 = BASE + ["form_me", "form_opp", "color_me", "color_opp",
             "open_me_in_mine", "open_opp_in_mine", "open_me_in_theirs", "open_opp_in_theirs",
             "streak_me", "streak_opp", "hour_me", "hour_opp", "loggap_me", "loggap_opp"]
MATCHUP = ["me_vs_opp_rep", "opp_vs_me_rep", "lose_time_me", "lose_time_opp", "win_time_me", "win_time_opp",
           "clock_me", "clock_opp", "time_matchup_me", "time_matchup_opp"]
FEATURES = V1 + MATCHUP


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
            "family": g["family"], "a": a, "b": b,
            "rating_logit": math.log(e / (1 - e)),
            "form_me": a["form"], "form_opp": b["form"], "color_me": a["color"], "color_opp": b["color"],
            "open_me_in_mine": family_resid(me_hist, a["top_family"], g["color"], t),
            "open_opp_in_mine": family_resid(opp_hist, a["top_family"], opp_color, t),
            "open_me_in_theirs": family_resid(me_hist, b["top_family"], g["color"], t),
            "open_opp_in_theirs": family_resid(opp_hist, b["top_family"], opp_color, t),
            "streak_me": a["streak"], "streak_opp": b["streak"], "hour_me": a["hour"], "hour_opp": b["hour"],
            "loggap_me": math.log1p(a["gap"]), "loggap_opp": math.log1p(b["gap"]),
            "me_vs_opp_rep": vs_repertoire(me_hist, b["repertoire"], g["color"], t),
            "opp_vs_me_rep": vs_repertoire(opp_hist, a["repertoire"], opp_color, t),
            "lose_time_me": a["lose_time"], "lose_time_opp": b["lose_time"],
            "win_time_me": a["win_time"], "win_time_opp": b["win_time"],
            "clock_me": a["clock_left"], "clock_opp": b["clock_left"],
            # someone who often wins on time against someone who often loses on time
            "time_matchup_me": a["win_time"] * b["lose_time"], "time_matchup_opp": b["win_time"] * a["lose_time"],
        })
    return rows


# ---------- evaluation ----------

def _boot(d: np.ndarray, groups: np.ndarray, rng, n: int = 2000) -> np.ndarray:
    """90% interval of the mean of d, resampling focal players (games within a player are correlated)."""
    ids = np.unique(groups)
    idx = {f: np.where(groups == f)[0] for f in ids}
    stats = []
    for _ in range(n):
        sel = np.concatenate([idx[f] for f in rng.choice(ids, len(ids))])
        stats.append(d[sel].mean())
    return np.percentile(stats, [5, 95])


def evaluate():
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import GroupKFold
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    rows = build_rows()
    y = np.array([r["y"] for r in rows])
    score = np.array([r["score"] for r in rows])
    expect = np.array([r["expected"] for r in rows])
    groups = np.array([r["focal"] for r in rows])
    rng = np.random.default_rng(0)
    print(f"{len(rows)} games, {len(set(groups))} focal players; wins {np.mean(y == 2):.1%}, "
          f"draws {np.mean(y == 1):.1%}, losses {np.mean(y == 0):.1%}")

    def X(cols):
        return np.array([[r[c] for c in cols] for r in rows])

    def lr():
        return make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=5000))

    def gbm():
        return HistGradientBoostingClassifier(learning_rate=0.03, max_iter=300, max_leaf_nodes=15,
                                              min_samples_leaf=80, l2_regularization=1.0, random_state=0)

    def oof(make, Xm):
        p = np.zeros((len(y), 3))
        for tr, te in GroupKFold(5).split(Xm, y, groups):
            p[te] = make().fit(Xm[tr], y[tr]).predict_proba(Xm[te])
        return p

    def ll(p):
        return -np.log(np.clip(p[np.arange(len(y)), y], 1e-12, 1))

    def brier(p):
        return (p[:, 2] + 0.5 * p[:, 1] - score) ** 2

    models = {
        "Ratings only (logistic)": oof(lr, X(BASE)),
        "Ratings + first-run history (logistic)": oof(lr, X(V1)),
        "Ratings + all history and matchups (logistic)": oof(lr, X(FEATURES)),
        "Ratings + all history and matchups (gradient boosting)": oof(gbm, X(FEATURES)),
    }
    base = models["Ratings only (logistic)"]
    print("\n| Model | Log loss | Brier | Brier change vs ratings only, positive = better (90% interval) |")
    print("|---|---:|---:|---|")
    print(f"| Elo formula | n/a | {((expect - score) ** 2).mean():.4f} | |")
    widths = []
    for name, p in models.items():
        if p is base:
            print(f"| {name} | {ll(p).mean():.4f} | {brier(p).mean():.4f} | |")
            continue
        d = brier(base) - brier(p)
        lo, hi = _boot(d, groups, rng)
        widths.append(hi - lo)
        print(f"| {name} | {ll(p).mean():.4f} | {brier(p).mean():.4f} | {d.mean():+.4f} ({lo:+.4f} to {hi:+.4f}) |")
    w = max(widths)
    print(f"\nPower: the widest 90% interval is {w:.4f}. A history effect that shifts a typical game's expected "
          f"score by s improves the Brier score by about s^2, so this sample can detect shifts of about "
          f"{math.sqrt(w / 2):.3f} or more.")

    m = lr().fit(X(FEATURES), y)
    coef = m[-1].coef_[2] - m[-1].coef_[0]
    print("\nWin-vs-loss weight per standardized feature (logistic, full data):")
    for f, c in sorted(zip(FEATURES, coef), key=lambda x: -abs(x[1]))[:12]:
        print(f"  {f:20s} {c:+.3f}")

    targeted(rows, score, expect, groups, rng)


def targeted(rows, score, expect, groups, rng):
    """Only games where a matchup applies. Under ratings alone the mean residual (score - expected)
    should be zero; a matchup effect shows up as a residual in the predicted direction."""
    resid = score - expect
    print(f"\nTargeted checks (mean of score - Elo expected; all games: {resid.mean():+.4f})")
    print("| Situation | Games | Mean residual (90% interval) |")
    print("|---|---:|---|")

    def show(label, mask):
        if mask.sum() < 50:
            print(f"| {label} | {mask.sum()} | too few |")
            return
        lo, hi = _boot(resid[mask], groups[mask], rng)
        print(f"| {label} | {mask.sum()} | {resid[mask].mean():+.4f} ({lo:+.4f} to {hi:+.4f}) |")

    edge = np.array([r["me_vs_opp_rep"] - r["opp_vs_me_rep"] for r in rows])
    q = np.quantile(edge, [0.1, 0.9])
    show("Opening matchup favors the focal player (top 10%)", edge >= q[1])
    show("Opening matchup favors the opponent (bottom 10%)", edge <= q[0])
    # the opponent's main opening is one the focal player does badly in
    bad = np.array([(r["b"]["top_family"] is not None and r["b"]["repertoire"].get(r["b"]["top_family"], 0) >= 0.3
                     and r["open_me_in_theirs"] <= -0.05) for r in rows])
    played = np.array([r["family"] == r["b"]["top_family"] for r in rows])
    show("Opponent's main opening is one the focal player scores badly in", bad)
    show("  ...and that opening was actually played", bad & played)
    tm = np.array([r["time_matchup_me"] - r["time_matchup_opp"] for r in rows])
    q = np.quantile(tm, [0.1, 0.9])
    show("Time matchup favors the focal player (top 10%)", tm >= q[1])
    show("Time matchup favors the opponent (bottom 10%)", tm <= q[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["collect", "evaluate"])
    ap.add_argument("--focal", type=int, default=200)
    ap.add_argument("--per", type=int, default=60)
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args()
    if args.cmd == "collect":
        collect(args.focal, args.per, args.threads)
    else:
        evaluate()


if __name__ == "__main__":
    main()
