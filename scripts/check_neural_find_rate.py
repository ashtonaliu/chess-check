"""Check Python, ONNX and TypeScript parity using initialized weights and optional completed shards."""
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
import pyarrow.parquet as pq
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from chesscheck.neural_find_rate import NeuralFindRate, RatingScale, encode_board, encode_scalars
from scripts.export_neural_find_rate import export_model

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


def check(cases, directory):
    boards, scalars = [], []
    for row in cases:
        context = row["context"]
        boards.append(encode_board(row["fen"], row["best"]))
        scalars.append(encode_scalars(context["rating"], context["speed"], context["clockFrac"],
                                      context["source"], TEST_RATINGS[context["source"]]))
    inputs = {"board": np.stack(boards), "scalars": np.stack(scalars)}
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(123)
        model = NeuralFindRate().eval()
    with torch.inference_mode():
        expected = model(*(torch.from_numpy(value) for value in inputs.values())).numpy()
    export_model(model, TEST_RATINGS, directory)

    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    float_session = ort.InferenceSession(str(directory / "model.onnx"), options, ["CPUExecutionProvider"])
    int8_session = ort.InferenceSession(str(directory / "model.int8.onnx"), options, ["CPUExecutionProvider"])
    np.testing.assert_allclose(float_session.run(None, inputs)[0], expected, atol=1e-6, rtol=0)
    # Exercise both the traced batch size and a larger batch.
    one = {name: value[:1] for name, value in inputs.items()}
    np.testing.assert_allclose(float_session.run(None, one)[0], expected[:1], atol=1e-6, rtol=0)
    quantized = int8_session.run(None, inputs)[0]
    np.testing.assert_allclose(int8_session.run(None, one)[0], quantized[:1], atol=1e-6, rtol=0)
    np.testing.assert_allclose(quantized, expected, atol=0.005, rtol=0)

    rows = [dict(row, board=base64.b64encode(board.astype(np.uint8).tobytes()).decode("ascii"),
                 scalars=scalar.tolist(), probability=float(p))
            for row, board, scalar, p in zip(cases, boards, scalars, quantized, strict=True)]
    fixture = directory / "parity.json"
    fixture.write_text(json.dumps(rows, separators=(",", ":"), allow_nan=False))
    subprocess.run(["node", "--import", "tsx", "--test", "test/neuralFindRate.test.ts"], cwd=ROOT / "web",
                   env={**os.environ, "NEURAL_FIND_RATE_PARITY": str(fixture)}, check=True)
    print(f"Checked {len(cases)} positions. Max float-to-int8 probability error {np.max(abs(expected - quantized)):.6f}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--positions", type=Path, help="directory of completed Lichess position shards")
    parser.add_argument("--count", type=int, default=300, help="number of shard positions to check")
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be positive")
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    cases = examples()
    if args.positions is not None:
        cases.extend(shard_examples(args.positions, args.count))
    with tempfile.TemporaryDirectory(prefix="neural-find-rate-") as directory:
        check(cases, Path(directory))


if __name__ == "__main__":
    main()
