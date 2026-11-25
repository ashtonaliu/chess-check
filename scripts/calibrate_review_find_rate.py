"""Evaluate the shipped review find-rate model on held-out test positions."""
import argparse
import base64
from concurrent.futures import ProcessPoolExecutor
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from chesscheck.neural_find_rate import BOARD_PLANES, CHANNELS, HIDDEN, SPEEDS, NeuralFindRate
from scripts.eval_find_rate import TEST_MOD, move_design
from scripts.prepare_neural_find_rate import MOVE_COLUMNS, PACKED_WIDTH, encode_chunk, inputs

REVIEW_CLOCK_FRACTION = 0.6561
MIN_BAND_N = 200
FIRST_RULE_ECE = 0.03
BIAS_THRESHOLD = 0.02
DEFAULT_DRAWS = 2000
DEFAULT_SEED = 24
SITE_ORDER = (
    ("chesscom", "blitz"),
    ("lichess", "blitz"),
    ("lichess", "rapid"),
    ("lichess", "bullet"),
    ("lichess", "classical"),
    ("lichess", "ultraBullet"),
    ("chesscom", "rapid"),
    ("chesscom", "bullet"),
)


def decode_float16(encoded: str, shape: tuple[int, ...]) -> torch.Tensor:
    raw = base64.b64decode(encoded)
    arr = np.frombuffer(raw, dtype="<f2").astype(np.float32)
    return torch.from_numpy(arr.reshape(shape).copy())


def load_shipped_model(weights_path: Path) -> tuple[NeuralFindRate, dict]:
    artifact = json.loads(weights_path.read_text())
    if artifact.get("version") != 2 or not artifact.get("moveFeatures"):
        raise ValueError("Expected float16 version 2 weights with move features")
    model = NeuralFindRate(extra_features=21)
    layers = artifact["layers"]
    hidden_in = CHANNELS * 64 + 1 + len(SPEEDS) + 3 + 21
    with torch.no_grad():
        model.conv1.weight.copy_(decode_float16(layers["conv1"]["weights"], (CHANNELS, BOARD_PLANES, 3, 3)))
        model.conv1.bias.copy_(decode_float16(layers["conv1"]["biases"], (CHANNELS,)))
        model.conv2.weight.copy_(decode_float16(layers["conv2"]["weights"], (CHANNELS, CHANNELS, 3, 3)))
        model.conv2.bias.copy_(decode_float16(layers["conv2"]["biases"], (CHANNELS,)))
        model.hidden.weight.copy_(decode_float16(layers["hidden"]["weights"], (HIDDEN, hidden_in)))
        model.hidden.bias.copy_(decode_float16(layers["hidden"]["biases"], (HIDDEN,)))
        model.output.weight.copy_(decode_float16(layers["output"]["weights"], (1, HIDDEN)))
        model.output.bias.copy_(decode_float16(layers["output"]["biases"], (1,)))
    model.eval()
    return model, artifact


def encode_dataframe(df: pd.DataFrame, workers: int, *, compute_features: bool) -> tuple[pd.DataFrame, np.ndarray]:
    columns = MOVE_COLUMNS.split(", ")
    packed = np.empty((len(df), PACKED_WIDTH), dtype=np.uint8)
    batches = [df.index[i:i + 2048] for i in range(0, len(df), 2048)]
    if workers <= 1:
        for idx in batches:
            chunk_boards, features = encode_chunk(
                (df.loc[idx, "fen"].tolist(), df.loc[idx, "best_uci"].tolist(), compute_features)
            )
            packed[idx] = chunk_boards
            if features:
                df.loc[idx, columns] = pd.DataFrame(features, columns=columns, index=idx)
        return df, packed

    with ProcessPoolExecutor(max_workers=workers) as pool:
        tasks = (
            (df.loc[idx, "fen"].tolist(), df.loc[idx, "best_uci"].tolist(), compute_features)
            for idx in batches
        )
        for idx, (chunk_boards, features) in zip(batches, pool.map(encode_chunk, tasks), strict=True):
            packed[idx] = chunk_boards
            if features:
                df.loc[idx, columns] = pd.DataFrame(features, columns=columns, index=idx)
    return df, packed


def load_extra_chesscom(extra_path: Path, workers: int) -> tuple[pd.DataFrame, np.ndarray]:
    df = pd.read_parquet(extra_path)
    groups = pd.util.hash_pandas_object(df["player"].str.casefold(), index=False).to_numpy()
    df = df.loc[groups % TEST_MOD == 0].reset_index(drop=True)
    if not len(df):
        return df, np.empty((0, PACKED_WIDTH), dtype=np.uint8)
    df["source"] = "chesscom"
    df["split"] = "test"
    return encode_dataframe(df, workers, compute_features=True)


def load_test_split(data_root: Path, prepared: Path | None, workers: int,
                    chesscom_extra: Path | None = None) -> tuple[pd.DataFrame, np.ndarray]:
    if prepared is not None:
        manifest = json.loads((prepared / "inputs.json").read_text())
        rows = pd.read_parquet(prepared / "rows.parquet")
        boards = np.load(prepared / "boards.npy", mmap_mode="r")
        if boards.shape != (manifest["rows"], PACKED_WIDTH) or len(rows) != manifest["rows"]:
            raise ValueError("Prepared tensors and rows disagree")
        test_idx = np.flatnonzero(rows["split"] == "test")
        base_rows, base_boards = rows.iloc[test_idx].reset_index(drop=True), np.asarray(boards[test_idx])
    else:
        df = inputs(data_root, workers)
        test_df = df.loc[df["split"] == "test"].reset_index(drop=True)
        parts_df = []
        parts_boards = []
        for source in ("chesscom", "lichess"):
            sub = test_df.loc[test_df["source"] == source].reset_index(drop=True)
            sub_df, sub_boards = encode_dataframe(sub, workers, compute_features=(source == "lichess"))
            parts_df.append(sub_df)
            parts_boards.append(sub_boards)
        base_rows = pd.concat(parts_df, ignore_index=True)
        base_boards = np.concatenate(parts_boards, axis=0)

    if chesscom_extra is not None and chesscom_extra.exists():
        extra_rows, extra_boards = load_extra_chesscom(chesscom_extra, workers)
        if len(extra_rows):
            keep_cols = list(base_rows.columns)
            base_rows = pd.concat([base_rows, extra_rows[keep_cols]], ignore_index=True)
            base_boards = np.concatenate([base_boards, extra_boards], axis=0)
    return base_rows, base_boards


def predict_review_clock(model: NeuralFindRate, artifact: dict, rows: pd.DataFrame, boards: np.ndarray,
                         batch_size: int = 2048) -> np.ndarray:
    scaled_rating = np.zeros(len(rows), dtype=np.float32)
    for source, scale in artifact["ratings"].items():
        mask = rows["source"] == source
        scaled_rating[mask] = (rows.loc[mask, "pregame_rating"].to_numpy(dtype=np.float32) - scale["mean"]) / scale["std"]
    clock_arr = np.full(len(rows), REVIEW_CLOCK_FRACTION, dtype=np.float32)
    missing_arr = np.zeros(len(rows), dtype=np.float32)
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


def ece_10(y: np.ndarray, p: np.ndarray) -> float:
    edges = np.linspace(0.0, 1.0, 11)
    bins = np.clip(np.digitize(p, edges[1:-1], right=False), 0, 9)
    total = len(y)
    err = 0.0
    for b in range(10):
        mask = bins == b
        cnt = int(mask.sum())
        if cnt > 0:
            err += (cnt / total) * abs(float(y[mask].mean()) - float(p[mask].mean()))
    return err


def simulated_ece_p95(p: np.ndarray, draws: int, rng: np.random.Generator) -> float:
    """95th percentile of 10-bin ECE when outcomes are drawn from Bernoulli(p)."""
    edges = np.linspace(0.0, 1.0, 11)
    bins = np.clip(np.digitize(p, edges[1:-1], right=False), 0, 9)
    n = len(p)
    ece_draws = np.zeros(draws, dtype=np.float64)
    for b in range(10):
        mask = bins == b
        cnt = int(mask.sum())
        if cnt == 0:
            continue
        pb = p[mask]
        # Draw Bernoulli(pb) outcomes for this bin across all Monte Carlo draws.
        y_sim = rng.random((draws, cnt)) < pb[None, :]
        ece_draws += np.abs(y_sim.sum(axis=1) - pb.sum()) / n
    return float(np.percentile(ece_draws, 95))


def longest_contiguous_span(bands: list[int]) -> tuple[int, int] | None:
    best: list[int] = []
    cur: list[int] = []
    for band in sorted(bands):
        if not cur or band == cur[-1] + 100:
            cur.append(band)
        else:
            if len(cur) > len(best):
                best = cur
            cur = [band]
    if len(cur) > len(best):
        best = cur
    return (best[0], best[-1] + 99) if best else None


def evaluate_groups(rows: pd.DataFrame, preds: np.ndarray, draws: int, seed: int) -> tuple[pd.DataFrame, dict, dict]:
    rng = np.random.default_rng(seed)
    df = pd.DataFrame({
        "source": rows["source"].to_numpy(),
        "speed": rows["time_class"].to_numpy(),
        "band": (rows["pregame_rating"].to_numpy(dtype=np.int64) // 100) * 100,
        "y": rows["found"].to_numpy(dtype=np.float64),
        "p": preds.astype(np.float64),
    })

    records = []
    for source, speed in SITE_ORDER:
        sub = df[(df["source"] == source) & (df["speed"] == speed)]
        for band, grp in sub.groupby("band", sort=True):
            y = grp["y"].to_numpy()
            p = grp["p"].to_numpy()
            n = len(grp)
            mean_p = float(p.mean())
            mean_y = float(y.mean())
            ece = ece_10(y, p)
            p95 = simulated_ece_p95(p, draws, rng) if n >= MIN_BAND_N else float("nan")
            brier = float(np.mean((p - y) ** 2))
            abs_bias = abs(mean_p - mean_y)
            records.append({
                "source": source,
                "speed": speed,
                "band": int(band),
                "rating_band": f"{int(band)}-{int(band) + 99}",
                "n": n,
                "predicted": mean_p,
                "actual": mean_y,
                "bias": mean_p - mean_y,
                "abs_bias": abs_bias,
                "ece10": ece,
                "ece_p95": p95,
                "brier": brier,
            })

    table = pd.DataFrame(records)
    first_ranges: dict[tuple[str, str], tuple[int, int] | None] = {}
    new_ranges: dict[tuple[str, str], tuple[int, int] | None] = {}
    first_statuses = []
    new_statuses = []

    for source, speed in SITE_ORDER:
        sub = table[(table["source"] == source) & (table["speed"] == speed)]
        first_qual = sub.loc[(sub["n"] >= MIN_BAND_N) & (sub["ece10"] <= FIRST_RULE_ECE), "band"].tolist()
        new_fail = (sub["ece10"] > sub["ece_p95"]) & (sub["abs_bias"] > BIAS_THRESHOLD)
        new_qual = sub.loc[(sub["n"] >= MIN_BAND_N) & (~new_fail), "band"].tolist()
        first_ranges[(source, speed)] = longest_contiguous_span(first_qual)
        new_ranges[(source, speed)] = longest_contiguous_span(new_qual)

    for row in table.itertuples(index=False):
        key = (row.source, row.speed)
        if row.n < MIN_BAND_N:
            first_statuses.append("too few")
            new_statuses.append("too few")
            continue
        f_span = first_ranges[key]
        if row.ece10 <= FIRST_RULE_ECE:
            first_statuses.append("allowed" if f_span and f_span[0] <= row.band <= f_span[1] else "pass (outside span)")
        else:
            first_statuses.append("fail")

        n_span = new_ranges[key]
        if row.ece10 > row.ece_p95 and row.abs_bias > BIAS_THRESHOLD:
            new_statuses.append("fail")
        else:
            new_statuses.append("allowed" if n_span and n_span[0] <= row.band <= n_span[1] else "pass (outside span)")

    table["first_rule_status"] = first_statuses
    table["status"] = new_statuses
    return table, first_ranges, new_ranges


def format_markdown(table: pd.DataFrame) -> str:
    lines = [
        "| Site | Speed | Rating band | n | Predicted | Actual | Bias | 10-bin ECE | Noise p95 | Brier | Status |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for row in table.itertuples(index=False):
        site = "Chess.com" if row.source == "chesscom" else "Lichess"
        p95_str = "n/a" if np.isnan(row.ece_p95) else f"{row.ece_p95:.4f}"
        lines.append(
            f"| {site} | {row.speed} | {row.rating_band} | {row.n} | {row.predicted:.4f} | "
            f"{row.actual:.4f} | {row.bias:+.4f} | {row.ece10:.4f} | {p95_str} | {row.brier:.4f} | {row.status} |"
        )
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=ROOT / "data" / "engine")
    parser.add_argument("--prepared", type=Path, default=None,
                        help="Optional prepared-v1 directory from scripts/prepare_neural_find_rate.py")
    parser.add_argument("--chesscom-extra", type=Path, default=None,
                        help="Optional Chess.com rapid/bullet training.parquet (defaults to <data-root>/chesscom-rapid-v1/training.parquet if present)")
    parser.add_argument("--weights", type=Path, default=ROOT / "web" / "src" / "extension" / "neuralFindRateWeights.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--draws", type=int, default=DEFAULT_DRAWS)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    if args.draws < 1000:
        raise ValueError("Use at least 1,000 Monte Carlo draws for the ECE noise floor")

    extra_path = args.chesscom_extra
    if extra_path is None:
        candidate = args.data_root / "chesscom-rapid-v1" / "training.parquet"
        if candidate.exists():
            extra_path = candidate

    model, artifact = load_shipped_model(args.weights)
    rows, boards = load_test_split(args.data_root, args.prepared, args.workers, extra_path)
    preds = predict_review_clock(model, artifact, rows, boards)
    table, first_ranges, new_ranges = evaluate_groups(rows, preds, args.draws, args.seed)

    args.output.mkdir(parents=True, exist_ok=True)
    table.to_csv(args.output / "calibration.csv", index=False)
    (args.output / "calibration.md").write_text(format_markdown(table))

    print(f"Evaluated {len(rows):,} held-out test positions (draws={args.draws}, seed={args.seed})")
    print(f"{'Site':10} {'Speed':12} {'First rule':12} {'New rule':12} {'n in new':9} {'Pred':7} {'Actual':7} {'Max ECE':8} {'Brier':7}")
    for source, speed in SITE_ORDER:
        f_rng = first_ranges[(source, speed)]
        n_rng = new_ranges[(source, speed)]
        f_str = f"{f_rng[0]}-{f_rng[1]}" if f_rng else "none"
        n_str = f"{n_rng[0]}-{n_rng[1]}" if n_rng else "none"
        if n_rng:
            sub = table[(table["source"] == source) & (table["speed"] == speed)
                        & (table["band"] >= n_rng[0]) & (table["band"] <= n_rng[1])]
            n_tot = int(sub["n"].sum())
            w_pred = float((sub["n"] * sub["predicted"]).sum() / n_tot)
            w_act = float((sub["n"] * sub["actual"]).sum() / n_tot)
            w_brier = float((sub["n"] * sub["brier"]).sum() / n_tot)
            max_ece = float(sub["ece10"].max())
            print(f"{source:10} {speed:12} {f_str:12} {n_str:12} {n_tot:9d} {w_pred:7.4f} {w_act:7.4f} {max_ece:8.4f} {w_brier:7.4f}")
        else:
            print(f"{source:10} {speed:12} {f_str:12} {n_str:12}")


if __name__ == "__main__":
    main()
