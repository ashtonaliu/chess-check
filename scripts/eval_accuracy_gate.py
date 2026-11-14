"""Accuracy gate: does a player's 50-game accuracy profile predict their next game?

Same design as eval_tactic_gate.py, on the engine study's cached per-game results (no new engine
work): for each target game that is itself in the cache, compare the focal player's accuracy (mean
win-% lost per move) and blunder rate in that game, and the accuracy gap between the two players
(who outplayed whom), with their 50-game profiles, out of sample by grouped 5-fold over players.

  python scripts/eval_accuracy_gate.py --cache data/odds/engine
"""
import argparse
import json
import sys
from pathlib import Path
import numpy as np
from sklearn.linear_model import LinearRegression
from sklearn.model_selection import GroupKFold
sys.path.insert(0, str(Path(__file__).resolve().parent))
import eval_odds as E  # noqa: E402
ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("--cache", type=Path, default=E.ROOT / "data/odds/engine")
C = ap.parse_args().cache
man = json.loads((C / "sample-84e6d97cc5da-1000.json").read_text())
G = next(C.glob("games-v2-d10-*"))
def side(gid, s):
    p = G / f"{gid}.json"
    return json.loads(p.read_text())["sides"][s] if p.exists() else None
colour = {}
for t in man["eligible_targets"]:
    for gid, s in t["histories"][0]: colour[(t["focal"], gid)] = s
def prof(hist):
    games = [side(g, s) for g, s in hist]; losses = [x for g in games for x in g["losses"]]
    return np.mean(losses), np.mean([x >= 20 for x in losses])
rows = []
for t in man["eligible_targets"]:
    gid, focal = t["id"], t["focal"]
    if (focal, gid) not in colour or not (G / f"{gid}.json").exists(): continue
    me_s = colour[(focal, gid)]; opp_s = "black" if me_s == "white" else "white"
    me, op = side(gid, me_s), side(gid, opp_s)
    if len(me["losses"]) < 10 or len(op["losses"]) < 10: continue
    fa, fb = prof(t["histories"][0]); oa, ob = prof(t["histories"][1])
    gap_rating = t["ratings"][0] - t["ratings"][1]
    rows.append((focal, t["ratings"][0], gap_rating, fa, fb, oa, ob, np.mean(me["losses"]), np.mean([x >= 20 for x in me["losses"]]),
                 np.mean(me["losses"]) - np.mean(op["losses"])))
a = np.array([r[1:] for r in rows], float); g = np.array([r[0] for r in rows]); rng = np.random.default_rng(0)
print(f"{len(rows)} games ({len(set(g))} players)")
def test(label, Xbase, Xfull, y):
    def cv(X):
        p = np.zeros(len(y))
        for tr, te in GroupKFold(5).split(X, y, g): p[te] = LinearRegression().fit(X[tr], y[tr]).predict(X[te])
        return 1 - ((y - p) ** 2).sum() / ((y - y.mean()) ** 2).sum(), (y - p) ** 2
    r0, e0 = cv(Xbase); r1, e1 = cv(Xfull); lo, hi = E._boot(e0 - e1, g, rng, 2000)
    print(f"{label}: out-of-sample R2 rating only {r0:+.4f} -> with profile {r1:+.4f} (error reduction 90% interval {lo:+.4f} to {hi:+.4f})")
test("Own accuracy in the next game (win-% lost per move)", a[:, [0]], a[:, [0, 2]], a[:, 6])
test("Own blunder rate in the next game", a[:, [0]], a[:, [0, 3]], a[:, 7])
test("Accuracy gap vs the opponent in that game (who outplayed whom)", a[:, [1]], np.column_stack([a[:, 1], a[:, 2] - a[:, 4], a[:, 3] - a[:, 5]]), a[:, 8])
print("corr(own 50-game accuracy, next-game accuracy):", round(np.corrcoef(a[:, 2], a[:, 6])[0, 1], 3))
print("corr(accuracy-profile gap, accuracy gap in the game):", round(np.corrcoef(a[:, 2] - a[:, 4], a[:, 8])[0, 1], 3))
