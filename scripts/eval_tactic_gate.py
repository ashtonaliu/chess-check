"""Gate test for the tactics work: does a player's tactic profile predict their own next game?

For each tactics-study target whose game is itself in the motif cache (a focal player's target is
part of the history of their later targets), the player's motif profile from their previous 50
games is compared with their tactical mistakes in that game, out of sample (grouped 5-fold by
player), beyond their rating. No new engine work.

  python scripts/eval_tactic_gate.py --cache data/odds/engine
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
motif_dir = next(C.glob("motifs-v1-d10-*"))
def counts(gid):
    p = motif_dir / f"{gid}.json"
    return json.loads(p.read_text())["sides"] if p.exists() else None
# the focal player's colour in each of their games, from the histories of their later targets
colour = {}
for t in man["eligible_targets"]:
    for gid, side in t["histories"][0]:
        colour[(t["focal"], gid)] = side
def pooled(side_counts, kind):
    return sum(side_counts[kind].values())
rows = []
for t in man["eligible_targets"]:
    gid, focal = t["id"], t["focal"]
    c = counts(gid)
    if c is None or (focal, gid) not in colour:
        continue
    me = c[colour[(focal, gid)]]
    if me["moves"] < 10:
        continue
    hist = [counts(h)[s] for h, s in t["histories"][0]]
    moves = sum(h["moves"] for h in hist)
    opp = sum(pooled(h, "opportunities") for h in hist)
    x_missed = sum(pooled(h, "missed") for h in hist) / (opp + 10)
    x_allowed = sum(pooled(h, "allowed") for h in hist) / (moves + 100)
    y_missed = pooled(me, "missed") / max(pooled(me, "opportunities"), 1) if pooled(me, "opportunities") else np.nan
    y_allowed = pooled(me, "allowed") / me["moves"]
    y_both = (pooled(me, "missed") + pooled(me, "allowed")) / me["moves"]
    rows.append((focal, t["ratings"][0], x_missed, x_allowed, x_missed + x_allowed, y_missed, y_allowed, y_both))
a = np.array([r[1:] for r in rows], dtype=float); g = np.array([r[0] for r in rows])
print(f"{len(rows)} target games where the focal player's game is in the cache ({len(set(g))} players)")
rng = np.random.default_rng(0)
def cv_r2(X, y, groups):
    ok = np.isfinite(y); X, y, groups = X[ok], y[ok], groups[ok]
    pred = np.zeros(len(y))
    for tr, te in GroupKFold(5).split(X, y, groups):
        pred[te] = LinearRegression().fit(X[tr], y[tr]).predict(X[te])
    return 1 - ((y - pred) ** 2).sum() / ((y - y.mean()) ** 2).sum(), (y - pred) ** 2, ok
for label, xi, yi in (("missed tactics (share of opportunities)", 1, 4), ("allowed tactics (per move)", 2, 5), ("missed + allowed (per move)", 3, 6)):
    y = a[:, yi]
    r0, e0, ok = cv_r2(a[:, [0]], y, g)
    r1, e1, _ = cv_r2(a[:, [0, xi]], y, g)
    d = e0 - e1; lo, hi = E._boot(d, g[ok], rng, 2000)
    rho = np.corrcoef(a[ok, xi], y[ok])[0, 1]
    print(f"{label}: next-game R2 rating only {r0:+.4f}, rating + own profile {r1:+.4f}; "
          f"error reduction {d.mean():+.6f} (90%: {lo:+.6f} to {hi:+.6f}); corr(profile, next game) {rho:+.3f}")
