"""Join the Phase B inputs, assign player groups and cache board tensors."""
import argparse
from concurrent.futures import ProcessPoolExecutor
import hashlib
import json
from pathlib import Path
import sys
import time

import duckdb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from chesscheck.neural_find_rate import BOARD_PLANES, SPEEDS, encode_board
from scripts.eval_find_rate import TEST_MOD, move_features

KEYS = ["game_id", "run_id", "ply", "mover", "player", "pregame_rating", "best_uci"]
CONTEXT = ["player", "pregame_rating", "time_class", "clock_frac", "found", "source"]
MOVE_COLUMNS = (
    "piece, is_capture, captured_value, gives_check, is_promotion, is_castle, backward, "
    "sideways, was_attacked, lands_attacked, in_check, legal_moves, captures_available, "
    "checks_available, material_balance, non_pawn_material"
)
PACKED_WIDTH = BOARD_PLANES * 8


def inputs(root: Path, workers: int) -> pd.DataFrame:
    chesscom = root / "derived" / "find_rate.parquet"
    raw = root / "derived" / "find_rate_raw.parquet"
    lichess = root / "lichess-v1" / "training.parquet"
    keys = ", ".join(KEYS)
    with duckdb.connect(config={"threads": workers}) as con:
        table = con.execute(f"SELECT {keys}, found, clock_frac, test, {MOVE_COLUMNS} FROM read_parquet(?)",
                            [str(chesscom)]).df()
        boards = con.execute(f"SELECT {keys}, fen FROM read_parquet(?)", [str(raw)]).df()
        other = con.execute(
            f"""SELECT {', '.join(CONTEXT)}, fen, best_uci
                FROM read_parquet(?) WHERE evaluation_source = 'stockfish_19'""", [str(lichess)]
        ).df()
        n_lichess, = con.execute("SELECT count(*) FROM read_parquet(?)", [str(lichess)]).fetchone()
    joined = table.merge(boards, on=KEYS, validate="one_to_one")
    if len(joined) != len(table) or len(joined) != len(boards):
        raise ValueError("The Chess.com feature table and raw FENs must have identical row keys")
    if not len(other) or len(other) != n_lichess or set(other.source) != {"lichess"}:
        raise ValueError("The Lichess table must contain only local Stockfish labels")
    joined["source"], joined["time_class"] = "chesscom", "blitz"
    df = pd.concat([joined, other], ignore_index=True)
    if df[["player", "pregame_rating", "time_class", "found", "fen", "best_uci"]].isna().any().any():
        raise ValueError("A training row has a missing required value")
    if not set(df.time_class).issubset(SPEEDS):
        raise ValueError("A training row has an unknown speed")

    # Match the existing Chess.com test fold. Use a second base-5 digit for validation.
    # Casefolding keeps spelling variants of the same name together across both sources.
    groups = pd.util.hash_pandas_object(df.player.str.casefold(), index=False).to_numpy()
    test = groups % TEST_MOD == 0
    if not np.array_equal(test[:len(joined)], joined.test.to_numpy(dtype=bool)):
        raise ValueError("The assigned Chess.com test players differ from the existing holdout")
    validation = (groups // TEST_MOD) % TEST_MOD == 0
    df["split"] = np.select([test, validation], ["test", "validation"], default="train")
    return df


def encode_chunk(task):
    fens, moves, compute_features = task
    packed = np.empty((len(fens), PACKED_WIDTH), dtype=np.uint8)
    features = []
    for i, (fen, move) in enumerate(zip(fens, moves, strict=True)):
        packed[i] = np.packbits(encode_board(fen, move).astype(np.uint8), axis=None)
        if compute_features:
            features.append(move_features(fen, move))
    return packed, features


def prepare(root: Path, directory: Path, workers: int):
    directory.mkdir(parents=True, exist_ok=True)
    if (directory / "inputs.json").exists():
        raise FileExistsError(f"Prepared inputs already exist in {directory}")
    started = time.monotonic()
    df = inputs(root, workers)
    paths = [root / filename for filename in
             ("derived/find_rate.parquet", "derived/find_rate_raw.parquet", "lichess-v1/training.parquet")]
    inputs_sha = {}
    for path in paths:
        with path.open("rb") as handle:
            inputs_sha[path.name] = hashlib.file_digest(handle, "sha256").hexdigest()
    print(df.groupby(["source", "split"]).player.agg(["size", "nunique"]).to_string(), flush=True)
    columns = MOVE_COLUMNS.split(", ")
    boards = np.lib.format.open_memmap(directory / "boards.npy.tmp", mode="w+", dtype=np.uint8,
                                      shape=(len(df), PACKED_WIDTH))
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for source in ("chesscom", "lichess"):
            rows = df.index[df.source == source]
            batches = [rows[i:i + 2048] for i in range(0, len(rows), 2048)]
            tasks = ((df.loc[idx, "fen"].tolist(), df.loc[idx, "best_uci"].tolist(), source == "lichess")
                     for idx in batches)
            for idx, (packed, features) in zip(batches, pool.map(encode_chunk, tasks), strict=True):
                boards[idx] = packed
                if features:
                    df.loc[idx, columns] = pd.DataFrame(features, columns=columns, index=idx)
            print(f"Encoded {len(rows):,} {source} positions", flush=True)
    boards.flush()
    del boards
    (directory / "boards.npy.tmp").replace(directory / "boards.npy")
    df[CONTEXT + columns + ["split"]].to_parquet(directory / "rows.parquet.tmp", index=False)
    (directory / "rows.parquet.tmp").replace(directory / "rows.parquet")
    manifest = {"sha256": inputs_sha, "rows": len(df), "seconds": round(time.monotonic() - started, 2)}
    (directory / "inputs.json").write_text(json.dumps(manifest, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=ROOT / "data" / "engine")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    prepare(args.data_root, args.output, args.workers)


if __name__ == "__main__":
    main()
