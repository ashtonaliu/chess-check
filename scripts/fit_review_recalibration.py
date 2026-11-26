"""Fit per-site, per-speed rating recalibration on validation rows at the fixed review clock."""
import argparse
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.calibrate_review_find_rate import (
    SITE_ORDER,
    apply_recalibration,
    load_shipped_model,
    predict_review_clock,
    standardize_ratings,
)
from scripts.prepare_neural_find_rate import PACKED_WIDTH


def load_validation_split(prepared: Path) -> tuple[pd.DataFrame, np.ndarray]:
    manifest = json.loads((prepared / "inputs.json").read_text())
    rows = pd.read_parquet(prepared / "rows.parquet")
    boards = np.load(prepared / "boards.npy", mmap_mode="r")
    if boards.shape != (manifest["rows"], PACKED_WIDTH) or len(rows) != manifest["rows"]:
        raise ValueError("Prepared tensors and rows disagree")
    val_idx = np.flatnonzero(rows["split"] == "validation")
    return rows.iloc[val_idx].reset_index(drop=True), np.asarray(boards[val_idx])


def fit_pair(y: np.ndarray, p: np.ndarray, z: np.ndarray) -> dict[str, float]:
    clipped = np.clip(p.astype(np.float64), 1e-6, 1.0 - 1e-6)
    logit_p = np.log(clipped / (1.0 - clipped))
    X = np.column_stack((logit_p, z.astype(np.float64)))
    clf = LogisticRegression(C=np.inf, solver="newton-cholesky", tol=1e-10, max_iter=1000)
    clf.fit(X, y.astype(np.int64))
    return {
        "a": round(float(clf.intercept_[0]), 6),
        "b": round(float(clf.coef_[0, 0]), 6),
        "c": round(float(clf.coef_[0, 1]), 6),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--prepared",
        type=Path,
        default=ROOT / "eval_results" / "neural-find-rate" / "prepared-v2",
        help="Prepared inputs directory containing rows.parquet, boards.npy, and inputs.json",
    )
    parser.add_argument(
        "--weights",
        type=Path,
        default=ROOT / "web" / "src" / "extension" / "neuralFindRateWeights.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "eval_results" / "review-recalibration" / "reviewRecalibration.json",
    )
    args = parser.parse_args()

    model, artifact = load_shipped_model(args.weights)
    rows, boards = load_validation_split(args.prepared)
    preds = predict_review_clock(model, artifact, rows, boards)
    z = standardize_ratings(rows, artifact)
    y = rows["found"].to_numpy(dtype=np.float64)

    recalibration: dict[str, dict[str, dict[str, float]]] = {}
    for source, speed in SITE_ORDER:
        mask = (rows["source"] == source) & (rows["time_class"] == speed)
        if not mask.any():
            raise ValueError(f"No validation rows for {source} {speed}")
        params = fit_pair(y[mask], preds[mask], z[mask])
        recalibration.setdefault(source, {})[speed] = params

    recal_preds = apply_recalibration(preds, rows, artifact, recalibration)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(recalibration, indent=2) + "\n")

    print(
        f"{'Site':10} {'Speed':12} {'Val n':8} {'a':>10} {'b':>10} {'c':>10} "
        f"{'LL before':>10} {'LL after':>10} {'Brier bef':>10} {'Brier aft':>10}"
    )
    for source, speed in SITE_ORDER:
        mask = (rows["source"] == source) & (rows["time_class"] == speed)
        p_bef = np.clip(preds[mask].astype(np.float64), 1e-6, 1.0 - 1e-6)
        p_aft = np.clip(recal_preds[mask].astype(np.float64), 1e-6, 1.0 - 1e-6)
        y_sub = y[mask]
        params = recalibration[source][speed]
        print(
            f"{source:10} {speed:12} {int(mask.sum()):8d} "
            f"{params['a']:+10.6f} {params['b']:+10.6f} {params['c']:+10.6f} "
            f"{log_loss(y_sub, p_bef):10.5f} {log_loss(y_sub, p_aft):10.5f} "
            f"{brier_score_loss(y_sub, p_bef):10.5f} {brier_score_loss(y_sub, p_aft):10.5f}"
        )


if __name__ == "__main__":
    main()
