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


def inputs(root: Path, workers: int, chesscom_extra: Path | None = None) -> pd.DataFrame:
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
    joined["needs_move_features"] = False
    other["needs_move_features"] = True
    parts = [joined, other]
    if chesscom_extra is not None:
        with duckdb.connect(config={"threads": workers}) as con:
            extra = con.execute(
                f"""SELECT {', '.join(CONTEXT)}, fen, best_uci
                    FROM read_parquet(?) WHERE evaluation_source = 'stockfish_19'""",
                [str(chesscom_extra)],
            ).df()
        if not len(extra) or set(extra.source) != {"chesscom"}:
            raise ValueError("The extra Chess.com table must contain only Chess.com Stockfish labels")
        extra_groups = pd.util.hash_pandas_object(extra.player.str.casefold(), index=False).to_numpy()
        if (extra_groups % TEST_MOD == 0).any():
            raise ValueError("Held-out test players must not appear in chesscom_extra training data")
        extra["needs_move_features"] = True
        parts.append(extra)
    df = pd.concat(parts, ignore_index=True)
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


def prepare(root: Path, directory: Path, workers: int, chesscom_extra: Path | None = None,
            base_prepared: Path | None = None):
    directory.mkdir(parents=True, exist_ok=True)
    if (directory / "inputs.json").exists():
        raise FileExistsError(f"Prepared inputs already exist in {directory}")
    started = time.monotonic()
    df = inputs(root, workers, chesscom_extra=chesscom_extra)
    base_names = ("derived/find_rate.parquet", "derived/find_rate_raw.parquet", "lichess-v1/training.parquet")
    paths = [root / filename for filename in base_names]
    if chesscom_extra is not None:
        paths.append(chesscom_extra)
    inputs_sha = {}
    for path in paths:
        with path.open("rb") as handle:
            key = f"{path.parent.name}/{path.name}" if path == chesscom_extra else path.name
            inputs_sha[key] = hashlib.file_digest(handle, "sha256").hexdigest()
    print(df.groupby(["source", "time_class", "split"]).player.agg(["size", "nunique"]).to_string(), flush=True)
    columns = MOVE_COLUMNS.split(", ")
    boards = np.lib.format.open_memmap(directory / "boards.npy.tmp", mode="w+", dtype=np.uint8,
                                      shape=(len(df), PACKED_WIDTH))
    reused = 0
    if base_prepared is not None:
        base_manifest = json.loads((base_prepared / "inputs.json").read_text())
        expected_base_sha = {Path(name).name: inputs_sha[Path(name).name] for name in base_names}
        if base_manifest.get("sha256") != expected_base_sha:
            raise ValueError("base_prepared SHA-256 does not match the v1 inputs")
        reused = int(base_manifest["rows"])
        base_rows = pd.read_parquet(base_prepared / "rows.parquet")
        base_boards = np.load(base_prepared / "boards.npy", mmap_mode="r")
        if len(base_rows) != reused or base_boards.shape != (reused, PACKED_WIDTH):
            raise ValueError("base_prepared rows and boards disagree")
        boards[:reused] = base_boards
        df.loc[:reused - 1, columns] = base_rows[columns].to_numpy()
        print(f"Reused {reused:,} encoded positions from {base_prepared}", flush=True)
    remaining = df.iloc[reused:]
    groups_to_encode = [
        (False, remaining.index[~remaining["needs_move_features"]]),
        (True, remaining.index[remaining["needs_move_features"]]),
    ]
    if workers <= 1:
        for compute_features, rows in groups_to_encode:
            if not len(rows):
                continue
            for i in range(0, len(rows), 2048):
                idx = rows[i:i + 2048]
                packed, features = encode_chunk(
                    (df.loc[idx, "fen"].tolist(), df.loc[idx, "best_uci"].tolist(), compute_features)
                )
                boards[idx] = packed
                if features:
                    df.loc[idx, columns] = pd.DataFrame(features, columns=columns, index=idx)
            print(f"Encoded {len(rows):,} positions (move_features={compute_features})", flush=True)
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            for compute_features, rows in groups_to_encode:
                if not len(rows):
                    continue
                batches = [rows[i:i + 2048] for i in range(0, len(rows), 2048)]
                tasks = ((df.loc[idx, "fen"].tolist(), df.loc[idx, "best_uci"].tolist(), compute_features)
                         for idx in batches)
                for idx, (packed, features) in zip(batches, pool.map(encode_chunk, tasks), strict=True):
                    boards[idx] = packed
                    if features:
                        df.loc[idx, columns] = pd.DataFrame(features, columns=columns, index=idx)
                print(f"Encoded {len(rows):,} positions (move_features={compute_features})", flush=True)
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
    parser.add_argument("--chesscom-extra", type=Path, default=None,
                        help="Optional Chess.com rapid/bullet training.parquet (non-test rows only)")
    parser.add_argument("--base-prepared", type=Path, default=None,
                        help="Optional existing prepared-v1 directory to reuse v1 boards and move features")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    prepare(args.data_root, args.output, args.workers,
            chesscom_extra=args.chesscom_extra, base_prepared=args.base_prepared)


if __name__ == "__main__":
    main()
