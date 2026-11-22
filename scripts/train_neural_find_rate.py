"""Train Phase B models and compare them on fixed, player-grouped holdouts."""
import argparse
import copy
from dataclasses import asdict, dataclass
import json
from pathlib import Path
import platform
import sys
import time

import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar
from scipy.special import expit
import sklearn
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.calibration import calibration_curve
from threadpoolctl import threadpool_limits
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chesscheck.neural_find_rate import BOARD_PLANES, HIDDEN, SPEEDS, NeuralFindRate, RatingScale
from scripts.eval_find_rate import design, move_design
from scripts.prepare_neural_find_rate import PACKED_WIDTH

SEED = 24
BOOTSTRAP_RESAMPLES = 2000
LEARNING_RATE = 0.001
WEIGHT_DECAY = 0.01
PATIENCE = 4


@dataclass(frozen=True)
class Variant:
    joint: bool = True
    board: bool = True
    context: bool = True
    move_features: bool = False


VARIANTS = {
    "chesscom_board_context": Variant(joint=False),
    "joint_board_context": Variant(),
    "joint_board_only": Variant(context=False),
    "joint_context_move": Variant(board=False, move_features=True),
    "joint_board_context_move": Variant(move_features=True),
    "chesscom_board_context_move": Variant(joint=False, move_features=True),
}
BASELINES = ("logistic_move", "boosting_move", "joint_boosting_move")


def indices(rows, split, source=None):
    mask = rows.split == split
    if source is not None:
        mask &= rows.source == source
    return np.flatnonzero(mask)


def context_inputs(rows, train):
    """Standardize ratings using only this variant's training players."""
    clock = rows.clock_frac.to_numpy()
    missing = np.isnan(clock)
    scaled_rating = np.zeros(len(rows), dtype=np.float32)
    ratings = {}
    for source, group in rows.iloc[train].groupby("source"):
        scale = RatingScale(float(group.pregame_rating.mean()), float(group.pregame_rating.std(ddof=0)))
        ratings[source] = asdict(scale)
        same_source = rows.source == source
        scaled_rating[same_source] = (rows.loc[same_source, "pregame_rating"] - scale.mean) / scale.std
    scalars = np.column_stack((scaled_rating, *(rows.time_class == speed for speed in SPEEDS),
                               np.where(missing, 0, np.clip(clock, 0, 1.5)), missing,
                               rows.source == "lichess")).astype(np.float32)
    return scalars, ratings


class Batches:
    def __init__(self, boards, context, hand, found, variant, device, size):
        self.boards = boards
        context = context if variant.context else np.zeros_like(context)
        self.inputs = np.column_stack((context, hand)) if variant.move_features else context
        self.found = found
        self.variant = variant
        self.device = device
        self.size = size

    def __call__(self, idx):
        for start in range(0, len(idx), self.size):
            sample = idx[start:start + self.size]
            x = torch.from_numpy(self.inputs[sample]).to(self.device)
            y = torch.from_numpy(self.found[sample]).to(self.device)
            board = None
            if self.variant.board:
                values = np.unpackbits(self.boards[sample], axis=1).reshape(-1, BOARD_PLANES, 8, 8)
                board = torch.from_numpy(values).to(device=self.device, dtype=torch.float32,
                                                    memory_format=torch.channels_last)
            yield board, x, y


def logits(model, board, context):
    if board is None:
        return model(context).squeeze(-1)
    return model.logits(board, context)


@torch.inference_mode()
def predict(model, batches, idx):
    model.eval()
    return np.concatenate([logits(model, board, x).cpu().numpy() for board, x, _ in batches(idx)])


def logistic_loss(y, unscaled):
    return float(np.mean(np.logaddexp(0, unscaled) - y * unscaled, dtype=np.float64))


def train_neural(name, variant, rows, boards, hand, args):
    started = time.monotonic()
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    source = None if variant.joint else "chesscom"
    train, validation, test = (indices(rows, split, source) for split in ("train", "validation", "test"))
    scalars, ratings = context_inputs(rows, train)
    found = rows.found.to_numpy(dtype=np.float32)
    batches = Batches(boards, scalars, hand, found, variant, args.device, args.batch_size)
    if variant.board:
        model = NeuralFindRate(hand.shape[1] if variant.move_features else 0)
        model.to(device=args.device, memory_format=torch.channels_last)
    else:
        model = nn.Sequential(nn.Linear(batches.inputs.shape[1], HIDDEN), nn.ReLU(),
                              nn.Linear(HIDDEN, HIDDEN), nn.ReLU(), nn.Linear(HIDDEN, 1)).to(args.device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)
    criterion = nn.BCEWithLogitsLoss()
    history = []
    best_loss = float("inf")
    for epoch in range(1, args.epochs + 1):
        model.train()
        for board, x, y in batches(rng.permutation(train)):
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(logits(model, board, x), y)
            loss.backward()
            optimizer.step()
        val_logits = predict(model, batches, validation)
        value = logistic_loss(found[validation], val_logits)
        if not np.isfinite(value):
            raise ValueError(f"{name} diverged in epoch {epoch}")
        history.append(value)
        print(f"{name} epoch {epoch:2} validation log loss {value:.6f}", flush=True)
        if value < best_loss:
            best_loss, best_epoch = value, epoch
            best_state = copy.deepcopy(model.state_dict())
            best_logits = val_logits
        if epoch - best_epoch >= PATIENCE:
            break
    model.load_state_dict(best_state)
    # Fit one logit temperature on the player-disjoint validation split.
    calibrated = minimize_scalar(lambda log_t: logistic_loss(found[validation], best_logits / np.exp(log_t)),
                                 bounds=(-2, 2), method="bounded")
    if not calibrated.success:
        raise RuntimeError(f"{name} temperature fit failed")
    temperature = float(np.exp(calibrated.x))
    with torch.no_grad():
        output = model.output if variant.board else model[-1]
        output.weight.div_(temperature)
        output.bias.div_(temperature)
    predictions = np.full(len(rows), np.nan, dtype=np.float32)
    predictions[test] = expit(predict(model, batches, test))
    checkpoint = {"state_dict": model.cpu().state_dict(), "ratings": ratings,
                  "variant": asdict(variant), "temperature": temperature}
    torch.save(checkpoint, args.output / f"{name}.pt")
    return predictions, {
        "variant": asdict(variant), "parameters": sum(p.numel() for p in model.parameters()),
        "best_epoch": best_epoch, "validation_history": history,
        "validation_log_loss_temperature_scaled": float(calibrated.fun), "temperature": temperature,
        "ratings": ratings, "seconds": round(time.monotonic() - started, 2),
    }


def train_baseline(name, rows, hand, seed):
    started = time.monotonic()
    joint = name == "joint_boosting_move"
    source = None if joint else "chesscom"
    train, validation, test = (indices(rows, split, source) for split in ("train", "validation", "test"))
    if joint:
        context, _ = context_inputs(rows, train)
        x = np.column_stack((context, hand))
        x_train, x_val, x_test = (x[idx] for idx in (train, validation, test))
    else:
        x_train, x_val, x_test = (design(rows.iloc[idx], "move") for idx in (train, validation, test))
    y_train, y_val = rows.found.iloc[train], rows.found.iloc[validation]
    if name == "logistic_move":
        model = LogisticRegression(max_iter=2000, C=1.0).fit(x_train, y_train)
    else:
        model = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.1, max_leaf_nodes=63,
                                               random_state=seed if joint else 0,
                                               early_stopping=True, scoring="neg_log_loss")
        model.fit(x_train, y_train, X_val=x_val, y_val=y_val)
    predictions = np.full(len(rows), np.nan, dtype=np.float32)
    predictions[test] = model.predict_proba(x_test)[:, 1]
    print(name, "fit complete", flush=True)
    return predictions, {"parameters": model.get_params(), "joint": joint,
                         "iterations": int(np.max(model.n_iter_)), "seconds": round(time.monotonic() - started, 2)}


def scores(y, p):
    return {"log_loss": log_loss(y, p, labels=[0, 1]), "brier": brier_score_loss(y, p),
            "auc": roc_auc_score(y, p)}


def calibration(rows, p):
    df = rows.assign(predicted=p, found=rows.found.astype(int),
                     rating_band=rows.pregame_rating // 200 * 200)
    def grouped(keys):
        return (df.groupby(keys).agg(n=("found", "size"), predicted=("predicted", "mean"),
                                     observed=("found", "mean")).reset_index().to_dict("records"))

    observed, predicted = calibration_curve(df.found, p, n_bins=10, strategy="quantile")
    return {"by_time_control": grouped("time_class"), "by_rating": grouped("rating_band"),
            "by_rating_and_time_control": grouped(["time_class", "rating_band"]),
            "curve": [{"predicted": float(x), "observed": float(y)} for x, y in zip(predicted, observed)]}


def paired_bootstrap(y, players, predictions, pairs):
    """Resample players with replacement. Weight every retained move equally."""
    sample_losses = {}
    for name, p in predictions.items():
        epsilon = np.finfo(p.dtype).eps
        q = np.clip(p.astype(np.float64), epsilon, 1 - epsilon)
        sample_losses[name] = -np.where(y, np.log(q), np.log1p(-q))
    _, group = np.unique(players, return_inverse=True)
    counts = np.bincount(group)
    sums = [np.bincount(group, weights=sample_losses[a] - sample_losses[b]) for a, b in pairs]
    rng = np.random.default_rng(SEED)
    dist = np.empty((BOOTSTRAP_RESAMPLES, len(pairs)))
    for i in range(BOOTSTRAP_RESAMPLES):
        draw = rng.integers(0, len(counts), size=len(counts))
        denominator = counts[draw].sum()
        dist[i] = [diff[draw].sum() / denominator for diff in sums]
    return [{"model": a, "reference": b, "delta": float(diff.sum() / counts.sum()),
             "ci90": np.percentile(dist[:, i], [5, 95]).tolist()}
            for i, ((a, b), diff) in enumerate(zip(pairs, sums, strict=True))]


def write_json(path, result):
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    tmp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default="cpu")
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=1024)
    parser.add_argument("--epochs", type=int, default=24)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--models", nargs="+", choices=(*BASELINES, *VARIANTS), default=[*BASELINES, *VARIANTS])
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    manifest = json.loads((args.prepared / "inputs.json").read_text())
    rows = pd.read_parquet(args.prepared / "rows.parquet")
    boards = np.load(args.prepared / "boards.npy", mmap_mode="r")
    if boards.shape != (manifest["rows"], PACKED_WIDTH) or len(rows) != manifest["rows"]:
        raise ValueError("Prepared tensors and rows disagree")
    config = {**{k: v for k, v in vars(args).items() if k not in ("prepared", "output")},
              "inputs": manifest["sha256"], "learning_rate": LEARNING_RATE,
              "weight_decay": WEIGHT_DECAY, "patience": PATIENCE,
              "bootstrap_resamples": BOOTSTRAP_RESAMPLES, "platform": platform.platform(),
              "python": platform.python_version(), "torch": torch.__version__, "sklearn": sklearn.__version__,
              "pandas": pd.__version__, "variants": {name: asdict(v) for name, v in VARIANTS.items()}}
    config_path = args.output / "config.json"
    if config_path.exists() and json.loads(config_path.read_text()) != config:
        raise ValueError("Use a new output directory when experiment settings change")
    write_json(config_path, config)
    hand = move_design(rows).to_numpy(dtype=np.float32)
    results, predictions = {}, {}

    def record(name, p, detail):
        np.save(args.output / f"{name}.npy", p)
        write_json(args.output / f"{name}.json", detail)

    with threadpool_limits(limits=args.threads):
        for name in args.models:
            if (args.output / f"{name}.json").exists():
                continue
            if name in VARIANTS:
                record(name, *train_neural(name, VARIANTS[name], rows, boards, hand, args))
            else:
                record(name, *train_baseline(name, rows, hand, args.seed))

    for name in args.models:
        p = np.load(args.output / f"{name}.npy")
        detail = json.loads((args.output / f"{name}.json").read_text())
        detail["test"] = {}
        for source in ("chesscom", "lichess"):
            idx = indices(rows, "test", source)
            if np.isnan(p[idx]).all():
                continue
            score = scores(rows.found.iloc[idx], p[idx])
            detail["test"][source] = {**score, "calibration": calibration(rows.iloc[idx], p[idx])}
            print(f"{source:8} {name:25} " + " ".join(f"{k}={v:.6f}" for k, v in score.items()), flush=True)
        results[name] = detail
        predictions[name] = p
    test = indices(rows, "test", "chesscom")
    pairs = [(model, baseline) for model in VARIANTS for baseline in BASELINES]
    pairs.extend([("joint_boosting_move", "boosting_move"),
                  ("joint_board_context", "chesscom_board_context"),
                  ("joint_board_context_move", "joint_board_context"),
                  ("joint_board_context_move", "joint_context_move"),
                  ("joint_board_context_move", "chesscom_board_context_move"),
                  ("joint_board_context", "joint_board_only")])
    pairs = [(model, reference) for model, reference in pairs if model in predictions and reference in predictions]
    deltas = paired_bootstrap(rows.found.iloc[test].to_numpy(), rows.player.iloc[test].str.casefold().to_numpy(),
                              {name: p[test] for name, p in predictions.items()}, pairs)
    splits = (rows.groupby(["source", "split"]).player
              .agg(rows="size", players="nunique").reset_index().to_dict("records"))
    write_json(args.output / "results.json", {"config": config, "splits": splits, "models": results,
                                             "chesscom_log_loss_deltas": deltas})


if __name__ == "__main__":
    main()
