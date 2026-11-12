"""Blunder-risk model: P(this move loses >= 20 win%) from position + clock.

Training data is every move in the fetched games, both players, so the
opponents (players of similar rating) act as the reference population.

Two uses:
- benchmark(): logistic regression vs gradient boosting (scikit-learn) vs an
  MLP (PyTorch), on a split grouped by game so moves of one game never leak
  between train and test.
- player_risk(): out-of-fold predictions give an *expected* number of
  blunders for the user's moves given how hard their positions were. Actual /
  expected > 1 means they blunder more than the population would in the same
  spots, and slicing by clock shows whether time pressure is the cause.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.model_selection import GroupKFold, GroupShuffleSplit
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .engine import BLUNDER_DROP

FEATURES = [
    "move_no", "legal_moves", "in_check", "captures_available",
    "material_balance", "non_pawn_material", "cp_before_clip", "abs_cp",
    "clock_frac_f", "clock_missing", "log_clock", "log_spent",
    "phase_opening", "phase_middlegame", "phase_endgame",
]
# Logistic regression is linear in its inputs, but blunder risk jumps as the
# clock runs out and changes shape in lopsided positions. Band indicators fix
# that: a logistic model matches observed and predicted totals within each
# indicator's band on its training data, so the per-clock-band ratios the
# page reports stay calibrated. Tree models don't need them.
FEATURES_LINEAR = FEATURES + ["clock_lt10", "clock_10_30", "abs_cp_gt300", "abs_cp_gt700"]


def features(moves: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray, np.ndarray]:
    m = moves.copy()
    m["cp_before_clip"] = m.cp_before.clip(-1000, 1000)
    m["abs_cp"] = m.cp_before_clip.abs()
    clock = pd.to_numeric(m.get("clock"), errors="coerce")
    frac = pd.to_numeric(m.get("clock_frac"), errors="coerce")
    spent = pd.to_numeric(m.get("time_spent"), errors="coerce")
    m["clock_missing"] = clock.isna().astype(int)
    m["clock_frac_f"] = frac.fillna(1.0).clip(0, 2)
    m["log_clock"] = np.log1p(clock.fillna(clock.median() if clock.notna().any() else 0).clip(lower=0))
    m["log_spent"] = np.log1p(spent.fillna(0).clip(lower=0))
    for p in ("opening", "middlegame", "endgame"):
        m[f"phase_{p}"] = (m.phase == p).astype(int)
    m["clock_lt10"] = ((frac <= 0.1) & frac.notna()).astype(int)
    m["clock_10_30"] = ((frac > 0.1) & (frac <= 0.3)).astype(int)
    m["abs_cp_gt300"] = (m.abs_cp > 300).astype(int)
    m["abs_cp_gt700"] = (m.abs_cp > 700).astype(int)
    y = (m.wp_loss >= BLUNDER_DROP).astype(int).to_numpy()
    groups = m.url.to_numpy()
    return m[FEATURES_LINEAR].astype(float), y, groups


class _Cols:
    """Restrict a model to a subset of feature columns."""

    def __init__(self, cols, model):
        self.cols, self.model = cols, model

    def fit(self, X, y):
        self.model.fit(X[self.cols], y)
        return self

    def predict_proba(self, X):
        return self.model.predict_proba(X[self.cols])


def _hgb():
    return _Cols(FEATURES, _hgb_raw())


def _logreg():
    return _Cols(FEATURES_LINEAR, _logreg_raw())


def _hgb_raw():
    # heavily regularized: blunders are rare (~2-5% of moves), data is small
    return HistGradientBoostingClassifier(max_iter=150, learning_rate=0.05,
                                          max_leaf_nodes=8, min_samples_leaf=50,
                                          l2_regularization=1.0, random_state=0)


def _logreg_raw():
    # tol=1e-8: lbfgs' default (1e-4) stops up to 0.7% short in probability;
    # the in-browser Newton solver converges fully, and parity is tested
    return make_pipeline(StandardScaler(), LogisticRegression(max_iter=10000, tol=1e-8))


class TorchMLP:
    """Small MLP with a scikit-learn-like interface."""

    def __init__(self, hidden: int = 32, epochs: int = 40, lr: float = 1e-3, seed: int = 0):
        self.hidden, self.epochs, self.lr, self.seed = hidden, epochs, lr, seed

    def fit(self, X, y):
        import torch
        from torch import nn

        torch.manual_seed(self.seed)
        torch.set_num_threads(2)
        self.scaler = StandardScaler().fit(X)
        Xt = torch.tensor(self.scaler.transform(X), dtype=torch.float32)
        yt = torch.tensor(y, dtype=torch.float32).unsqueeze(1)
        self.net = nn.Sequential(nn.Linear(Xt.shape[1], self.hidden), nn.ReLU(),
                                 nn.Linear(self.hidden, self.hidden), nn.ReLU(),
                                 nn.Linear(self.hidden, 1))
        pos = max(float(yt.mean()), 1e-3)
        # start the output bias at the base rate so early epochs are calibrated
        with torch.no_grad():
            self.net[-1].bias.fill_(float(np.log(pos / (1 - pos))))
        opt = torch.optim.Adam(self.net.parameters(), lr=self.lr, weight_decay=1e-4)
        loss_fn = nn.BCEWithLogitsLoss()
        n = len(Xt)
        for _ in range(self.epochs):
            perm = torch.randperm(n)
            for i in range(0, n, 256):
                idx = perm[i:i + 256]
                opt.zero_grad()
                loss = loss_fn(self.net(Xt[idx]), yt[idx])
                loss.backward()
                opt.step()
        return self

    def predict_proba(self, X):
        import torch

        with torch.no_grad():
            Xt = torch.tensor(self.scaler.transform(X), dtype=torch.float32)
            p = torch.sigmoid(self.net(Xt)).squeeze(1).numpy()
        return np.column_stack([1 - p, p])


def benchmark(moves: pd.DataFrame, include_torch: bool = True) -> dict:
    X, y, groups = features(moves)
    if y.sum() < 10 or len(np.unique(groups)) < 8:
        raise ValueError("Not enough games/blunders to train a model")
    tr, te = next(GroupShuffleSplit(1, test_size=0.25, random_state=0).split(X, y, groups))
    models = {"logistic regression": _logreg(), "gradient boosting": _hgb()}
    if include_torch:
        models["MLP (PyTorch)"] = _Cols(FEATURES, TorchMLP())
    rows = []
    base = np.full(len(te), y[tr].mean())
    rows.append({"model": "base rate", "auc": 0.5,
                 "log_loss": log_loss(y[te], base, labels=[0, 1]),
                 "brier": brier_score_loss(y[te], base)})
    fitted = {}
    for name, mdl in models.items():
        mdl.fit(X.iloc[tr], y[tr])
        p = mdl.predict_proba(X.iloc[te])[:, 1]
        fitted[name] = mdl
        rows.append({"model": name, "auc": roc_auc_score(y[te], p),
                     "log_loss": log_loss(y[te], p, labels=[0, 1]),
                     "brier": brier_score_loss(y[te], p)})
    imp = permutation_importance(fitted["gradient boosting"].model, X.iloc[te][FEATURES], y[te],
                                 scoring="roc_auc", n_repeats=5, random_state=0)
    importance = (pd.Series(imp.importances_mean, index=FEATURES)
                  .sort_values(ascending=False))
    return {"table": pd.DataFrame(rows), "importance": importance,
            "n_moves": len(X), "n_games": len(np.unique(groups)),
            "blunder_rate": float(y.mean()), "test_moves": len(te)}


CLOCK_BUCKETS = [(-0.01, 0.1, "under 10% of the clock left"),
                 (0.1, 0.3, "10-30% of the clock left"),
                 (0.3, 10.0, "over 30% of the clock left")]


def poisson_ratio_interval(actual: int, expected: float, z: float = 1.645) -> tuple[float, float]:
    """90% interval for actual/expected, treating the actual count as Poisson
    (Byar's approximation to the exact interval). Uncertainty in the model's
    expected count is not included, so this is a lower bound on the width."""
    a = actual
    lo = 0.0 if a == 0 else a * (1 - 1 / (9 * a) - z / (3 * np.sqrt(a))) ** 3
    hi = (a + 1) * (1 - 1 / (9 * (a + 1)) + z / (3 * np.sqrt(a + 1))) ** 3
    return float(lo / expected), float(hi / expected)


MODEL_NAMES = {"hgb": "gradient boosting", "logreg": "logistic regression"}


def group_folds(groups: np.ndarray, n_splits: int = 5) -> np.ndarray:
    """Fold index per row from GroupKFold (all moves of a game share a fold)."""
    fold = np.zeros(len(groups), dtype=int)
    for k, (_, te) in enumerate(GroupKFold(n_splits).split(groups, groups, groups)):
        fold[te] = k
    return fold


def player_risk(moves: pd.DataFrame, n_splits: int = 5, model: str = "hgb") -> dict | None:
    """Actual vs model-expected blunders for the user's moves.

    The model learns only from the opponents' moves (similar-rated players),
    then predicts the user's moves in held-out games. Training on the user's
    own moves would pull the ratio toward 1 by construction.

    model: "hgb" (gradient boosting, the server default) or "logreg"
    (logistic regression, which the in-browser version reimplements).
    """
    X, y, groups = features(moves)
    me = moves.is_me.to_numpy().astype(bool)
    n_groups = len(np.unique(groups))
    if y[~me].sum() < 10 or n_groups < n_splits:
        return None
    make = {"hgb": _hgb, "logreg": _logreg}[model]
    fold = group_folds(groups, n_splits)
    oof = np.zeros(len(X))
    for k in range(n_splits):
        tr_opp = np.where((fold != k) & ~me)[0]
        te = np.where(fold == k)[0]
        mdl = make().fit(X.iloc[tr_opp], y[tr_opp])
        oof[te] = mdl.predict_proba(X.iloc[te])[:, 1]
    out = {"model": MODEL_NAMES[model], "moves": int(me.sum()), "actual": int(y[me].sum()),
           "expected": float(oof[me].sum()), "buckets": []}
    out["ratio"] = out["actual"] / out["expected"] if out["expected"] else float("nan")
    out["ci_low"], out["ci_high"] = poisson_ratio_interval(out["actual"], out["expected"])
    frac = pd.to_numeric(moves.get("clock_frac"), errors="coerce").to_numpy()
    for lo, hi, label in CLOCK_BUCKETS:
        sel = me & (frac > lo) & (frac <= hi)
        if sel.sum() >= 30 and oof[sel].sum() > 0:
            a, e = int(y[sel].sum()), float(oof[sel].sum())
            c_lo, c_hi = poisson_ratio_interval(a, e)
            out["buckets"].append({"label": label, "moves": int(sel.sum()), "actual": a,
                                   "expected": e, "ratio": a / e, "ci_low": c_lo, "ci_high": c_hi})
    return out
