#!/usr/bin/env python3
"""Compare a retrained neural find-rate model against the shipped weights on all held-out test sets."""
import argparse
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd
from sklearn.metrics import brier_score_loss, log_loss
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from chesscheck.neural_find_rate import BOARD_PLANES, SPEEDS, NeuralFindRate
from scripts.calibrate_review_find_rate import (
    REVIEW_CLOCK_FRACTION,
    SITE_ORDER,
    load_shipped_model,
    load_test_split,
)
from scripts.eval_find_rate import move_design

BOOTSTRAP_RESAMPLES = 2000
SEED = 24
MAX_REGRESSION = 0.001


def load_checkpoint_model(checkpoint_path: Path) -> tuple[NeuralFindRate, dict]:
    ckpt = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    model = NeuralFindRate(extra_features=21)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    return model, {"ratings": ckpt["ratings"]}


def predict_model(model: NeuralFindRate, ratings: dict, rows: pd.DataFrame, boards: np.ndarray,
                  *, fixed_clock: float | None = None, batch_size: int = 2048) -> np.ndarray:
    scaled_rating = np.zeros(len(rows), dtype=np.float32)
    for source, scale in ratings.items():
        mask = rows["source"] == source
        scaled_rating[mask] = (rows.loc[mask, "pregame_rating"].to_numpy(dtype=np.float32) - scale["mean"]) / scale["std"]

    if fixed_clock is not None:
        clock_arr = np.full(len(rows), fixed_clock, dtype=np.float32)
        missing_arr = np.zeros(len(rows), dtype=np.float32)
    else:
        raw_clock = rows["clock_frac"].to_numpy(dtype=np.float64)
        missing = np.isnan(raw_clock)
        clock_arr = np.where(missing, 0.0, np.clip(raw_clock, 0.0, 1.5)).astype(np.float32)
        missing_arr = missing.astype(np.float32)

    is_lichess = (rows["source"] == "lichess").to_numpy(dtype=np.float32)
    speed_cols = [(rows["time_class"] == speed).to_numpy(dtype=np.float32) for speed in SPEEDS]
    context = np.column_stack((scaled_rating, *speed_cols, clock_arr, missing_arr, is_lichess)).astype(np.float32)
    hand = move_design(rows).to_numpy(dtype=np.float32)
    scalars = np.column_stack((context, hand)).astype(np.float32)

    preds = np.empty(len(rows), dtype=np.float32)
    with torch.inference_mode():
        for start in range(0, len(rows), batch_size):
            end = min(start + batch_size, len(rows))
            board_batch = np.unpackbits(boards[start:end], axis=1).reshape(-1, BOARD_PLANES, 8, 8)
            preds[start:end] = model(
                torch.from_numpy(board_batch).float(),
                torch.from_numpy(scalars[start:end]),
            ).numpy()
    return preds


def paired_log_loss_ci(y: np.ndarray, players: np.ndarray, p_new: np.ndarray, p_old: np.ndarray,
                       resamples: int = BOOTSTRAP_RESAMPLES, seed: int = SEED) -> tuple[float, list[float]]:
    eps = 1e-7
    q_new = np.clip(p_new.astype(np.float64), eps, 1.0 - eps)
    q_old = np.clip(p_old.astype(np.float64), eps, 1.0 - eps)
    loss_new = -np.where(y, np.log(q_new), np.log1p(-q_new))
    loss_old = -np.where(y, np.log(q_old), np.log1p(-q_old))
    _, group = np.unique(players, return_inverse=True)
    counts = np.bincount(group)
    diffs = np.bincount(group, weights=loss_new - loss_old)
    rng = np.random.default_rng(seed)
    draws = np.empty(resamples, dtype=np.float64)
    for i in range(resamples):
        idx = rng.integers(0, len(counts), size=len(counts))
        draws[i] = diffs[idx].sum() / counts[idx].sum()
    return float(diffs.sum() / counts.sum()), [float(x) for x in np.percentile(draws, [5, 95])]


def evaluate_pair_table(rows: pd.DataFrame, p_new: np.ndarray, p_old: np.ndarray,
                        resamples: int, seed: int) -> tuple[list[dict], bool]:
    results = []
    ship_ok = True
    for source, speed in SITE_ORDER:
        mask = (rows["source"] == source) & (rows["time_class"] == speed)
        idx = np.flatnonzero(mask)
        if not len(idx):
            continue
        y = rows["found"].iloc[idx].to_numpy(dtype=np.float64)
        players = rows["player"].iloc[idx].str.casefold().to_numpy()
        pn, po = p_new[idx], p_old[idx]
        ll_new = float(log_loss(y, pn, labels=[0, 1]))
        ll_old = float(log_loss(y, po, labels=[0, 1]))
        br_new = float(brier_score_loss(y, pn))
        br_old = float(brier_score_loss(y, po))
        delta, ci90 = paired_log_loss_ci(y, players, pn, po, resamples=resamples, seed=seed)

        if source == "chesscom" and speed in ("rapid", "bullet"):
            passed = ci90[1] < 0.0
        else:
            passed = ci90[1] <= MAX_REGRESSION
        if not passed:
            ship_ok = False

        results.append({
            "source": source,
            "speed": speed,
            "n": int(len(idx)),
            "players": int(len(np.unique(players))),
            "actual": float(y.mean()),
            "pred_shipped": float(po.mean()),
            "pred_new": float(pn.mean()),
            "log_loss_shipped": ll_old,
            "log_loss_new": ll_new,
            "log_loss_delta": delta,
            "log_loss_ci90": ci90,
            "brier_shipped": br_old,
            "brier_new": br_new,
            "brier_delta": br_new - br_old,
            "rule_pass": passed,
        })
    return results, ship_ok


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=ROOT / "data" / "engine")
    parser.add_argument("--prepared", type=Path, default=None)
    parser.add_argument("--chesscom-extra", type=Path, required=True,
                        help="Held-out Chess.com rapid/bullet training.parquet from #137")
    parser.add_argument("--shipped-weights", type=Path,
                        default=ROOT / "web" / "src" / "extension" / "neuralFindRateWeights.json")
    parser.add_argument("--candidate", type=Path, required=True,
                        help="Candidate .pt checkpoint or exported float16 weights.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--resamples", type=int, default=BOOTSTRAP_RESAMPLES)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()

    shipped_model, shipped_art = load_shipped_model(args.shipped_weights)
    if args.candidate.suffix == ".json":
        cand_model, cand_art = load_shipped_model(args.candidate)
    else:
        cand_model, cand_art = load_checkpoint_model(args.candidate)

    rows, boards = load_test_split(args.data_root, args.prepared, args.workers, args.chesscom_extra)

    report = {"n_total": int(len(rows)), "resamples": args.resamples, "seed": args.seed, "modes": {}}
    for mode, fixed_clock in (("recorded_clock", None), ("review_clock_06561", REVIEW_CLOCK_FRACTION)):
        p_old = predict_model(shipped_model, shipped_art["ratings"], rows, boards, fixed_clock=fixed_clock)
        p_new = predict_model(cand_model, cand_art["ratings"], rows, boards, fixed_clock=fixed_clock)
        table, ship_ok = evaluate_pair_table(rows, p_new, p_old, args.resamples, args.seed)
        report["modes"][mode] = {"ship_rule_pass": ship_ok, "groups": table}
        print(f"\n=== {mode} (ship_rule_pass={ship_ok}) ===")
        print(f"{'Site':10} {'Speed':12} {'n':7} {'Ship LL':8} {'New LL':8} {'Delta (90% CI)':28} {'Ship Br':8} {'New Br':8} {'PredS':6} {'PredN':6} {'Act':6} {'Pass'}")
        for r in table:
            ci = f"{r['log_loss_delta']:+.5f} [{r['log_loss_ci90'][0]:+.5f}, {r['log_loss_ci90'][1]:+.5f}]"
            print(f"{r['source']:10} {r['speed']:12} {r['n']:7d} {r['log_loss_shipped']:8.5f} {r['log_loss_new']:8.5f} "
                  f"{ci:28} {r['brier_shipped']:8.5f} {r['brier_new']:8.5f} "
                  f"{r['pred_shipped']:6.4f} {r['pred_new']:6.4f} {r['actual']:6.4f} {r['rule_pass']}")

    args.output.mkdir(parents=True, exist_ok=True)
    tmp = (args.output / "eval_comparison.json").with_suffix(".json.tmp")
    tmp.write_text(json.dumps(report, indent=2) + "\n")
    tmp.replace(args.output / "eval_comparison.json")


if __name__ == "__main__":
    main()
