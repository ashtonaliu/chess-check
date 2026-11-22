"""Check Python, ONNX and TypeScript parity and measure packed-weight drift."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import chess
import numpy as np
import onnxruntime as ort
import pandas as pd
import pyarrow.parquet as pq
from sklearn.metrics import log_loss
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from chesscheck.neural_find_rate import (
    BOARD_PLANES, MOVE_FEATURES, NeuralFindRate, RatingScale, encode_board, encode_scalars,
)
from scripts.eval_find_rate import move_design, move_features
from scripts.export_neural_find_rate import export_model, load_checkpoint
from scripts.prepare_neural_find_rate import CONTEXT, inputs

TEST_RATINGS = {"chesscom": RatingScale(1500, 400), "lichess": RatingScale(1750, 350)}


def case(fen, best, speed, clock=None, source="lichess", rating=1600):
    return {"fen": fen, "best": best, "context": {"rating": rating, "speed": speed,
                                                "clockFrac": clock, "source": source}}


def examples():
    return [
        case(chess.STARTING_FEN, "Nf3", "blitz", source="chesscom"),
        case("4k3/8/8/8/3Pp3/8/8/4K3 b - d3 0 1", "e4d3", "bullet", 0.25),
        case("k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", "e1d2", "rapid", 0.03),
        case("r3k2r/8/8/8/8/8/8/R3K2R b Qkq - 0 1", "O-O-O", "classical", 1.8),
        case("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8n", "ultraBullet", 0),
        case("4k3/8/8/8/8/8/p7/4K3 b - - 0 1", "a2a1r", "daily", source="chesscom"),
    ]


def shard_examples(directory, count):
    shards = sorted(directory.glob("part-*.parquet"))
    if not shards:
        raise ValueError(f"No completed position shards in {directory}")
    # Snapshot and spread across a few published files. Read one small batch at a time.
    n = min(10, len(shards), count)
    paths = [shards[i * (len(shards) - 1) // max(1, n - 1)] for i in range(n)]
    selected = []
    columns = ["fen", "best_uci", "time_class", "clock_frac", "source", "pregame_rating", "gap", "ply"]
    for index, path in enumerate(paths):
        left = count - len(selected)
        want = (left + n - index - 1) // (n - index)
        for batch in pq.ParquetFile(path).iter_batches(batch_size=512, columns=columns, use_threads=False):
            for row in batch.to_pylist():
                if row["best_uci"] and row["pregame_rating"] is not None and row["ply"] >= 2 \
                        and row["gap"] is not None and row["gap"] >= 20:
                    selected.append(case(row["fen"], row["best_uci"], row["time_class"], row["clock_frac"],
                                         row["source"], row["pregame_rating"]))
                    want -= 1
                    if not want:
                        break
            if not want:
                break
    if len(selected) != count:
        raise ValueError(f"Found {len(selected)} critical moves, expected {count} in the sampled shards")
    return selected


def parity_inputs(cases, ratings, with_moves):
    boards, scalars = [], []
    for row in cases:
        context = row["context"]
        boards.append(encode_board(row["fen"], row["best"]))
        scalars.append(encode_scalars(context["rating"], context["speed"], context["clockFrac"],
                                      context["source"], ratings[context["source"]]))
    scalars = np.stack(scalars)
    if with_moves:
        moves = []
        for row in cases:
            fen, best = row["fen"], row["best"]
            uci = chess.Board(fen).parse_san(best).uci()
            moves.append(move_features(fen, uci))
        scalars = np.column_stack((scalars, move_design(pd.DataFrame(moves)).to_numpy(dtype=np.float32)))
    return {"board": np.stack(boards), "scalars": scalars}


def check(cases, directory, model, ratings, holdout=None, precision="int8", review_clock=None):
    export_model(model, ratings, directory, precision)
    artifact = json.loads((directory / "weights.json").read_text())
    with_moves = artifact["moveFeatures"]
    cases = [row for row in cases if row["context"]["source"] in ratings]
    inputs = parity_inputs(cases, ratings, with_moves)
    with torch.inference_mode():
        expected = model(*(torch.from_numpy(value) for value in inputs.values())).numpy()
    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    float_session = ort.InferenceSession(str(directory / "model.onnx"), options, ["CPUExecutionProvider"])
    packed_session = ort.InferenceSession(str(directory / f"model.{precision}.onnx"), options, ["CPUExecutionProvider"])
    float_output = float_session.run(None, inputs)[0]
    # Trained weights can magnify the rounding differences between CPU kernels.
    float_tolerance = 1e-6 if holdout is None else 3e-6
    np.testing.assert_allclose(float_output, expected, atol=float_tolerance, rtol=0)
    # Exercise both the traced batch size and a larger batch.
    one = {name: value[:1] for name, value in inputs.items()}
    np.testing.assert_allclose(float_session.run(None, one)[0], expected[:1], atol=float_tolerance, rtol=0)
    quantized = packed_session.run(None, inputs)[0]
    np.testing.assert_allclose(packed_session.run(None, one)[0], quantized[:1], atol=float_tolerance, rtol=0)
    if holdout is None:
        np.testing.assert_allclose(quantized, expected, atol=0.005, rtol=0)
    rows = [dict(row, board=base64.b64encode(board.astype(np.uint8).tobytes()).decode("ascii"),
                 scalars=scalar.tolist(), probability=float(p))
            for row, board, scalar, p in zip(cases, inputs["board"], inputs["scalars"], quantized, strict=True)]
    fixture = directory / "parity.json"
    fixture.write_text(json.dumps(rows, separators=(",", ":"), allow_nan=False))
    subprocess.run(["node", "--import", "tsx", "--test", "test/neuralFindRate.test.ts"], cwd=ROOT / "web",
                   env={**os.environ, "NEURAL_FIND_RATE_PARITY": str(fixture.resolve())}, check=True)
    sample_error = float(np.max(abs(expected - quantized)))
    print(f"Checked {len(cases)} positions. Max float-to-{precision} sample error {sample_error:.6f}.")
    if holdout is not None:
        dataset, board_path = holdout
        result = check_holdout(dataset, board_path, ratings["chesscom"], with_moves,
                               float_session, packed_session, precision)
        result.update(parity_positions=len(cases), parity_sample_max_difference=sample_error,
                      float_onnx_pytorch_max_difference=float(np.max(abs(float_output - expected))))
        if review_clock is not None:
            result["review_clock"] = review_clock
            result["fixed_clock_holdout"] = check_holdout(dataset.assign(clock_frac=review_clock), board_path,
                                                           ratings["chesscom"], with_moves, float_session,
                                                           packed_session, precision)
        (directory / "quantization.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))
        if precision == "float16" and max(result["largest_probability_difference"],
                                            result.get("fixed_clock_holdout", {}).get("largest_probability_difference", 0)) >= 0.005:
            raise ValueError("Float16 drift must stay below 0.005 on the full Chess.com holdout")


def check_holdout(rows, board_path, scale, with_moves, float_session, packed_session, precision):
    idx = np.flatnonzero((rows.source == "chesscom") & (rows.split == "test"))
    test = rows.iloc[idx]
    boards = np.load(board_path, mmap_mode="r")
    scalars = np.stack([encode_scalars(r.pregame_rating, r.time_class,
                                       None if pd.isna(r.clock_frac) else r.clock_frac, r.source, scale)
                        for r in test.itertuples()])
    if with_moves:
        scalars = np.column_stack((scalars, move_design(test).to_numpy(dtype=np.float32)))
    float_p, packed_p = [], []
    for start in range(0, len(idx), 1024):
        batch = slice(start, start + 1024)
        board = np.unpackbits(boards[idx[batch]], axis=1).reshape(-1, BOARD_PLANES, 8, 8).astype(np.float32)
        data = {"board": board, "scalars": scalars[batch]}
        float_p.append(float_session.run(None, data)[0])
        packed_p.append(packed_session.run(None, data)[0])
    p, q = np.concatenate(float_p), np.concatenate(packed_p)
    float_loss, packed_loss = (log_loss(test.found, prob, labels=[0, 1]) for prob in (p, q))
    error = np.abs(p - q)
    return {"chesscom_positions": len(test), "float_log_loss": float_loss, f"{precision}_log_loss": packed_loss,
            "log_loss_delta": packed_loss - float_loss, "largest_probability_difference": float(error.max()),
            "positions_above_0_005": int(np.count_nonzero(error > 0.005))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--positions", type=Path, help="directory of completed Lichess position shards")
    parser.add_argument("--count", type=int, default=300, help="number of shard positions to check")
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--prepared", type=Path, help="prepared Phase B inputs")
    parser.add_argument("--data-root", type=Path, help="directory containing the original engine tables")
    parser.add_argument("--output", type=Path, help="trained export and reports")
    parser.add_argument("--precision", choices=("int8", "float16"), default="int8")
    parser.add_argument("--review-clock", type=float, help="also check the whole holdout at this fixed clock fraction")
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be positive")
    if args.review_clock is not None and (not args.checkpoint or not 0 <= args.review_clock <= 1.5):
        parser.error("--review-clock requires a trained checkpoint and a fraction between 0 and 1.5")
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    if any((args.checkpoint, args.prepared, args.data_root, args.output)) and not all(
        (args.checkpoint, args.prepared, args.data_root, args.output)
    ):
        parser.error("trained parity requires --checkpoint, --prepared, --data-root and --output")
    cases = examples()
    if args.positions is not None:
        cases.extend(shard_examples(args.positions, args.count))
    if args.checkpoint:
        model, ratings = load_checkpoint(args.checkpoint)
        prepared = pd.read_parquet(args.prepared / "rows.parquet")
        raw = inputs(args.data_root, 1)
        pd.testing.assert_frame_equal(raw[CONTEXT + ["split"]], prepared[CONTEXT + ["split"]], check_dtype=False)
        held_out = raw[(raw.source == "chesscom") & (raw.split == "test")].sample(args.count, random_state=1)
        cases.extend(case(r.fen, r.best_uci, r.time_class, None if pd.isna(r.clock_frac) else r.clock_frac,
                          r.source, r.pregame_rating) for r in held_out.itertuples())
        check(cases, args.output, model, ratings, (prepared, args.prepared / "boards.npy"),
              args.precision, args.review_clock)
    else:
        with tempfile.TemporaryDirectory(prefix="neural-find-rate-") as directory:
            for extra in (0, MOVE_FEATURES):
                torch.manual_seed(123)
                model = NeuralFindRate(extra).eval()
                check(cases, Path(directory) / str(extra), model, TEST_RATINGS, precision=args.precision)


if __name__ == "__main__":
    main()
