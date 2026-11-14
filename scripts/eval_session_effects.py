"""Session, volume, tilt and timing effects on a large time-split holdout.

Every game in the cached player histories (data/odds/v3) is seen from the view of the player whose
history it is in. Features describe that player's state using only their EARLIER games, never this
game's own times or moves (a feature measured from a game's end time once leaked its length).

The baseline is the Elo expected score recalibrated on the training period plus colour, which
already beats the raw Elo formula. Models are fitted on games before --fit-before and tested on
games from --test-from, with a gap between the two, and the test gain is bootstrapped over players.

Features:
  session stage   which game of the current run this would be if it continues it (1, 2-5, 6-15, 16+),
                  where a run is consecutive earlier games each ending within 30 min of the previous
  session curve   this player's own past residual (score - expected) at that stage, shrunk
  volume          games in the 24 hours before their previous game ended; games so far in the run
  break           days between the start of the current run and the game before it
  tilt            this player's own past residual after a loss minus after a win, shrunk, and
                  whether their previous game was a loss
  form            rating now minus their average rating over the window
  time of day     how far the hour of their previous game is from their usual playing hour
  colour split    this player's own past residual with this colour, shrunk

  python scripts/eval_session_effects.py
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from collections import deque
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parent))
import eval_odds as E  # noqa: E402

RUN_GAP = 1800          # a game ending within 30 min of the previous one continues the run
K = 20.0                # shrinkage toward zero for the player-specific residuals
# stage 0 (game 1) cannot be told from earlier games alone, so games 2-5 are the reference
STAGES = [(1, 1), (2, 5), (6, 15), (16, 10_000)]


def stage_of(n: int) -> int:
    return next(i for i, (lo, hi) in enumerate(STAGES) if lo <= n <= hi)


def player_rows(hist: list[dict], fit_before: int, test_from: int, owner: int) -> list[list[float]]:
    out = []
    ends = np.array([g["end"] for g in hist])
    rating_sum = np.concatenate([[0.0], np.cumsum([g["my"] for g in hist])])
    by_stage = [[0.0, 0] for _ in STAGES]          # this player's residual sums so far, per stage
    after = {"loss": [0.0, 0], "win": [0.0, 0]}
    colour = {"white": [0.0, 0], "black": [0.0, 0]}
    hours = np.zeros(24)
    run = 0                                        # length of the run ending at the previous game
    streak = 0                                     # losses in a row ending at the previous game
    peak = deque()                                 # indexes of a decreasing rating window (sliding max)
    for k, g in enumerate(hist):
        resid = g["score"] - E.expected(g["my_pre"], g["opp_pre"])
        if k >= 30 and not (fit_before <= g["end"] < test_from):
            last = hist[k - 1]
            start = k - run                          # first game of the current run
            brk = (ends[start] - ends[start - 1]) / 86400 if start >= 1 else 30.0
            day = k - int(np.searchsorted(ends, last["end"] - 86400, side="right"))
            st = stage_of(run + 1)                   # the stage this game is at if it continues the run
            s_sum, s_n = by_stage[st]
            lo = max(0, k - 200)
            mean_rating = (rating_sum[k] - rating_sum[lo]) / (k - lo)
            usual = int(np.argmax(hours))
            h = dt.datetime.fromtimestamp(int(last["end"]), dt.timezone.utc).hour
            off_hours = min(abs(h - usual), 24 - abs(h - usual))
            e = min(max(E.expected(g["my_pre"], g["opp_pre"]), 1e-4), 1 - 1e-4)
            c_sum, c_n = colour[g["color"]]
            while peak and peak[0] < k - 200:
                peak.popleft()
            below_peak = hist[peak[0]]["my"] - g["my_pre"] if peak else 0.0
            out.append([
                math.log(e / (1 - e)), 1.0 if g["color"] == "white" else -1.0,
                *[1.0 if st == i else 0.0 for i in range(1, len(STAGES))],
                s_sum / (s_n + K),
                math.log1p(day), math.log1p(run), math.log1p(brk), 1.0 if brk >= 3 and run == 1 else 0.0,
                (after["loss"][0] / (after["loss"][1] + K)) - (after["win"][0] / (after["win"][1] + K)),
                1.0 if last["score"] == 0 else 0.0,
                g["my_pre"] - mean_rating,
                off_hours,
                c_sum / (c_n + K),
                1.0 if last["score"] == 0 and E.expected(last["my_pre"], last["opp_pre"]) >= 0.7 else 0.0,
                # mid-session upset, from earlier games only (whether THIS game follows quickly would
                # need its start time; its end time includes its length and would leak the result)
                1.0 if last["score"] == 0 and E.expected(last["my_pre"], last["opp_pre"]) >= 0.7 and run >= 2 else 0.0,
                below_peak, min(streak, 6),
                {1.0: 2, 0.5: 1, 0.0: 0}[g["score"]], e, g["score"], 1.0 if g["end"] >= test_from else 0.0, owner,
            ])
        # update this player's running records with this game (used only for later games)
        run = run + 1 if k >= 1 and g["end"] - hist[k - 1]["end"] < RUN_GAP else 1
        by_stage[stage_of(run)][0] += resid; by_stage[stage_of(run)][1] += 1
        if k >= 1 and g["end"] - hist[k - 1]["end"] < RUN_GAP and hist[k - 1]["score"] != 0.5:
            bucket = after["loss" if hist[k - 1]["score"] == 0 else "win"]
            bucket[0] += resid; bucket[1] += 1
        colour[g["color"]][0] += resid; colour[g["color"]][1] += 1
        hours[dt.datetime.fromtimestamp(int(g["end"]), dt.timezone.utc).hour] += 1
        streak = streak + 1 if g["score"] == 0 else 0
        while peak and hist[peak[-1]]["my"] <= g["my"]:
            peak.pop()
        peak.append(k)
    return out


NAMES = ["rating_logit", "white", "stage_2_5", "stage_6_15", "stage_16_plus", "own_stage_resid",
         "log_games_24h", "log_run_so_far", "log_break_days", "first_after_3day_break",
         "own_tilt", "lost_last", "rating_vs_own_average", "hours_from_usual", "own_colour_resid",
         "upset_loss_last", "upset_loss_mid_session", "below_recent_peak", "losses_in_a_row"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fit-before", default="2026-11-01")
    ap.add_argument("--test-from", default="2026-11-07")
    args = ap.parse_args()
    ts = lambda d: int(dt.datetime.fromisoformat(d).replace(tzinfo=dt.timezone.utc).timestamp())
    fit_before, test_from = ts(args.fit_before), ts(args.test_from)
    rows = []
    for i, f in enumerate(sorted((E.DATA / "players").glob("*.json"))):
        rows += player_rows(E.with_pregame(json.loads(f.read_text())["games"]), fit_before, test_from, i)
    a = np.array(rows, dtype=float)
    n_feat = len(NAMES)
    y, score, test, owner = a[:, n_feat].astype(int), a[:, n_feat + 2], a[:, n_feat + 3] == 1, a[:, n_feat + 4]
    X = a[:, :n_feat]
    print(f"{(~test).sum():,} player-games to fit (before {args.fit_before}), {test.sum():,} to test (from {args.test_from})")
    s_te = score[test]
    rng = np.random.default_rng(0)

    def run(cols):
        sc = StandardScaler().fit(X[~test][:, cols])
        m = LogisticRegression(C=1.0, max_iter=3000).fit(sc.transform(X[~test][:, cols]), y[~test])
        p = m.predict_proba(sc.transform(X[test][:, cols]))
        return (p[:, 2] + 0.5 * p[:, 1] - s_te) ** 2, m.coef_[2] - m.coef_[0]

    raw = (a[test, n_feat + 1] - s_te) ** 2
    base, _ = run([0, 1])
    lo, hi = E._boot(raw - base, owner[test], rng, 300)
    print(f"Raw Elo {raw.mean():.5f}; calibrated ratings + colour {base.mean():.5f} (gain {(raw - base).mean():+.5f}, {lo:+.5f} to {hi:+.5f})")
    groups = {
        "session stage (everyone)": [2, 3, 4], "own session curve": [5], "games in last 24 h": [6],
        "games so far in the run": [7], "break before the run": [8, 9], "own tilt + lost last": [10, 11],
        "rating vs own average": [12], "hours from usual": [13], "own colour split": [14],
        "lost an upset last game": [15, 16], "below recent peak (200 games)": [17], "losses in a row": [18],
    }
    print("\n| Added to calibrated ratings + colour | Test Brier | Gain (90% interval) | Weights (win minus loss, standardized) |")
    print("|---|---:|---|---|")
    for label, extra in list(groups.items()) + [("all of the above", sum(groups.values(), []))]:
        b, coef = run([0, 1] + extra)
        d = base - b
        lo, hi = E._boot(d, owner[test], rng, 300)
        print(f"| {label} | {b.mean():.5f} | {d.mean():+.6f} ({lo:+.6f} to {hi:+.6f}) | "
              f"{', '.join(f'{NAMES[c]} {w:+.3f}' for c, w in zip(extra, coef[2:])) if label != 'all of the above' else ''} |")
    # direct looks: mean residual (score - Elo expected) in the test games
    resid = s_te - a[test, n_feat + 1]
    own = owner[test]
    Xt = X[test]

    def show(label, m):
        lo, hi = E._boot(resid[m], own[m], rng, 300)
        print(f"  {label:44s} {m.sum():9,d} games  {resid[m].mean():+.4f} ({lo:+.4f} to {hi:+.4f})")

    print("\nMean score minus Elo expected (test games). Session stage, if the game continues the run:")
    for label, col in (("games 2-5", 2), ("games 6-15", 3), ("game 16+", 4)):
        show(label, Xt[:, col] == 1)
    print("By rating against the player's average over their last 200 games:")
    q = np.quantile(Xt[:, 12], [0.1, 0.9])
    show(f"10% furthest below (<= {q[0]:+.0f} points)", Xt[:, 12] <= q[0])
    show("middle 80%", (Xt[:, 12] > q[0]) & (Xt[:, 12] < q[1]))
    show(f"10% furthest above (>= {q[1]:+.0f} points)", Xt[:, 12] >= q[1])
    print("By the previous game:")
    show("previous game lost", Xt[:, 11] == 1)
    show("previous game won or drawn", Xt[:, 11] == 0)
    show("previous game an upset loss (Elo gave them 70%+)", Xt[:, 15] == 1)
    show("  ...in the middle of a session", Xt[:, 16] == 1)


if __name__ == "__main__":
    main()
