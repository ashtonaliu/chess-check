"""Nested regularization check for the engine odds study (scripts/eval_engine_features.py).

The study's logistic models used C = 1. Here C is chosen inside each training fold by an inner
grouped 4-fold split on Brier score, then evaluated on the same five held-out focal-player folds,
so the test folds never influence the choice. It also compares engine features alone (no ratings)
with ratings alone and with always predicting 50%, and checks how the engine features track rating. It needs the study's caches (sample manifest,
downloads and per-game engine results) and runs no Stockfish.

  python scripts/eval_engine_regularization.py --source data/odds/v3
"""
import argparse
import json
from pathlib import Path

import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from threadpoolctl import threadpool_limits

import eval_engine_features as study

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=study.ROOT / 'data/odds/v3')
parser.add_argument('--cache', type=Path, default=study.ROOT / 'data/odds/engine', help='the engine study cache')
args = parser.parse_args()
source, cache = args.source.resolve(), args.cache.resolve()
manifest = json.loads((cache / 'sample-84e6d97cc5da-1000.json').read_text())

def offline_get(url, root):
    path = root / 'downloads' / (study.hashlib.sha256(url.encode()).hexdigest() + '.json')
    return json.loads(path.read_text()) if path.is_file() else {}

study.get = offline_get
sample = study.sample_targets(json.loads((source / 'targets.json').read_text()), 1000)
assert [study.game_id(target['url']) for target in sample] == manifest['sample_ids']
rows, jobs, exclusions = study.plan(sample, source, cache)
assert len(rows) == 995 and len(jobs) == 70467 and exclusions == manifest['exclusions']
folder = cache / 'games-v2-d10-4f75fb47deaa8a29'
results = {key: json.loads((folder / f'{key}.json').read_text()) for key in jobs}
plan_rows = rows
rows = study.feature_rows(rows, results)
base = np.array([[r['rating_logit']] for r in rows])
columns = [key for key in rows[0] if key not in {'focal', 'gid', 'score', 'accuracy_gap', 'elo', 'rating_logit'}]
full = np.column_stack([base, [[r[key] for key in columns] for r in rows]])
y = np.array([int(2 * r['score']) for r in rows]); groups = np.array([r['focal'] for r in rows]); n = len(y)

def predict(X, train, test, c):
    model = make_pipeline(SimpleImputer(keep_empty_features=True), StandardScaler(), LogisticRegression(C=c, max_iter=5000))
    model.fit(X[train], y[train]); assert list(model.classes_) == [0, 1, 2]
    return model.predict_proba(X[test])

def brier(y_true, p):
    return (p[:, 2] + 0.5 * p[:, 1] - y_true / 2) ** 2

def log_loss(y_true, p):
    return -np.log(np.clip(p[np.arange(len(y_true)), y_true], 1e-12, 1))

cs = [0.0001, 0.001, 0.01, 0.03, 0.1, 0.3, 1.0, 3.0, 10.0]
outer = list(GroupKFold(5).split(base, y, groups))
predictions = {}
with threadpool_limits(limits=1):
    for label, X in [('ratings', base), ('ratings_engine', full)]:
        outputs = {key: np.zeros((n, 3)) for key in ['nested', 'original']}
        chosen = []
        for train, test in outer:
            inner = [(train[a], train[b]) for a, b in GroupKFold(4).split(X[train], y[train], groups[train])]
            c = min(cs, key=lambda c: np.concatenate([brier(y[b], predict(X, a, b, c)) for a,b in inner]).mean())
            chosen.append(c)
            for key, setting in [('nested', c), ('original', 1.0)]:
                outputs[key][test] = predict(X, train, test, setting)
        predictions[label] = outputs
        print(label, 'nested C', chosen, flush=True)
rng = np.random.default_rng(0)
for method in ('original','nested'):
    for metric in (brier, log_loss):
        a, b = [metric(y,predictions[label][method]) for label in ('ratings', 'ratings_engine')]
        print(method, metric.__name__, 'ratings', a.mean(), 'engine', b.mean(), 'delta', (a-b).mean(), '90% CI', study._boot(a-b, groups, rng).tolist(), flush=True)


# ---------- engine features alone, and whether they track strength ----------

import math

engine = np.array([[r[key] for key in columns] for r in rows], dtype=float)
pairs = [k[len("focal_"):] for k in columns if k.startswith("focal_") and ("opponent_" + k[len("focal_"):]) in columns]
diff = np.array([[float(r["focal_" + k]) - float(r["opponent_" + k]) for k in pairs] for r in rows])
alone = {"ratings only": predictions["ratings"]["nested"], "ratings plus engine": predictions["ratings_engine"]["nested"]}
with threadpool_limits(limits=1):
    for label, X in [("engine only, both players' features", engine), ("engine only, focal minus opponent", diff)]:
        out = np.zeros((n, 3)); chosen = []
        for train, test in outer:
            inner = [(train[a], train[b]) for a, b in GroupKFold(4).split(X[train], y[train], groups[train])]
            c = min(cs, key=lambda c: np.concatenate([brier(y[b], predict(X, a, b, c)) for a, b in inner]).mean())
            chosen.append(c); out[test] = predict(X, train, test, c)
        alone[label] = out
        print(label, 'nested C', chosen, flush=True)
coin = (0.5 - y / 2) ** 2
print(f"\nAlways 50%: Brier {coin.mean():.4f}")
for label, p in alone.items():
    b = brier(y, p); lo, hi = study._boot(coin - b, groups, rng)
    print(f"{label}: Brier {b.mean():.4f}, gain over always 50% {(coin - b).mean():+.4f} ({lo:+.4f} to {hi:+.4f})")
gap = np.array([r["rating_logit"] for r in rows]) * 400 / math.log(10)
elo = np.array([r["elo"] for r in rows])
print(f"\nRating gap: median |gap| {np.median(np.abs(gap)):.0f} points, 90% within {np.quantile(np.abs(gap), 0.9):.0f}; "
      f"middle 90% of Elo expected scores {np.quantile(elo, 0.05):.2f} to {np.quantile(elo, 0.95):.2f}")
per = []
for (focal, raw, gid, ratings, past), r in zip(plan_rows, rows):
    for who, rating in (("focal", ratings[0]), ("opponent", ratings[1])):
        per.append((rating, r[f"{who}_loss"], r[f"{who}_missed_tactics"], r[f"{who}_low_clock_blunders"], r[f"{who}_conversion"]))
per = np.array(per, dtype=float); per = per[np.all(np.isfinite(per), axis=1)]
print(f"Across {len(per)} player histories (ratings {per[:, 0].min():.0f} to {per[:, 0].max():.0f}), correlation with rating:")
for i, name in enumerate(["mean win-% lost per move", "missed tactics per move", "blunder rate under 10% clock",
                          "conversion of winning positions"], 1):
    print(f"  {name}: {np.corrcoef(per[:, 0], per[:, i])[0, 1]:+.2f}")
slope = np.polyfit(per[:, 1], per[:, 0], 1)[0]
print(f"  each +1 win-% lost per move goes with {slope:+.0f} rating points")
