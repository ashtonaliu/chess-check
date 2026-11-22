"""Summarize repeated Phase B runs and select a checkpoint using Chess.com validation."""
import argparse
from dataclasses import asdict
import json
from pathlib import Path
from statistics import fmean
import sys

import numpy as np
import pandas as pd
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.eval_find_rate import move_design
from scripts.export_neural_find_rate import load_checkpoint
from scripts.train_neural_find_rate import Batches, VARIANTS, context_inputs, indices, logistic_loss, predict, write_json

MODELS = ("joint_boosting_move", "chesscom_board_context_move", "joint_board_context", "joint_board_context_move")


def validation_log_loss(model, checkpoint, rows, boards, hand, device, batch_size):
    variant = VARIANTS[model]
    train = indices(rows, "train", None if variant.joint else "chesscom")
    val = indices(rows, "validation", "chesscom")
    context, fitted = context_inputs(rows, train)
    network, scales = load_checkpoint(checkpoint)
    if fitted != {source: asdict(scale) for source, scale in scales.items()}:
        raise ValueError(f"Checkpoint rating scales do not match the training players: {checkpoint}")
    found = rows.found.to_numpy(dtype=np.float32)
    batches = Batches(boards, context, hand, found, variant, device, batch_size)
    network.to(device=device, memory_format=torch.channels_last)
    return logistic_loss(found[val], predict(network, batches, val))


def summarize(runs, prepared, device):
    reports = [json.loads((runs / f"seed-{seed}" / "results.json").read_text()) for seed in (24, 25, 26)]
    first = reports[0]
    metadata = lambda report: {key: value for key, value in report["config"].items() if key != "seed"}
    manifest = json.loads((prepared / "inputs.json").read_text())
    if any(metadata(report) != metadata(first) for report in reports) or manifest["sha256"] != first["config"]["inputs"]:
        raise ValueError("Seed reports and prepared inputs must refer to the same experiment")
    rows = pd.read_parquet(prepared / "rows.parquet")
    boards = np.load(prepared / "boards.npy", mmap_mode="r")
    hand = move_design(rows).to_numpy(dtype=np.float32)

    result = {}
    for name in MODELS:
        runs_by_seed = []
        for report in reports:
            seed = report["config"]["seed"]
            model = report["models"][name]
            record = {"seed": seed, **{metric: model["test"]["chesscom"][metric] for metric in ("log_loss", "brier", "auc")},
                      "bootstrap": [row for row in report["chesscom_log_loss_deltas"] if row["model"] == name]}
            if name in VARIANTS:
                checkpoint = runs / f"seed-{seed}" / f"{name}.pt"
                record["chesscom_validation_log_loss"] = validation_log_loss(
                    name, checkpoint, rows, boards, hand, device, report["config"]["batch_size"])
                record["checkpoint"] = str(checkpoint.relative_to(runs))
            runs_by_seed.append(record)
        values = [r["log_loss"] for r in runs_by_seed]
        result[name] = {"mean": fmean(values), "range": [min(values), max(values)], "runs": runs_by_seed}

    validation = "chesscom_validation_log_loss"
    contenders = {name: fmean(r[validation] for r in result[name]["runs"]) for name in MODELS if name in VARIANTS}
    chosen = min(contenders, key=contenders.__getitem__)
    selected = min(result[chosen]["runs"], key=lambda run: run[validation])
    write_json(runs / "summary.json", {
        "splits": first["splits"], "models": result, "mean_chesscom_validation_log_loss": contenders,
        "selected": {"model": chosen, "seed": selected["seed"], "checkpoint": selected["checkpoint"],
                     "chesscom_validation_log_loss": selected[validation]},
    })


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=Path, required=True)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default="cpu")
    args = parser.parse_args()
    torch.set_num_threads(8)
    torch.set_num_interop_threads(1)
    summarize(args.runs, args.prepared, args.device)
