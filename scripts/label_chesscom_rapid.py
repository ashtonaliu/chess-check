#!/usr/bin/env python3
"""Benchmark and label Chess.com rapid and bullet moves with v1 Stockfish 19 settings."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import time

import chess
import chess.engine
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from chesscheck.dataset import CRITICAL_GAP
from chesscheck.engine import find_stockfish, win_pct

WORKERS = 17
BENCH_PER_SPEED = 2_500
SHARD_ROWS = 8192
ENGINE_TIMEOUT = 30
ENGINE_BUDGET_SECONDS = 8 * 3600
SAFETY_FACTOR = 1.25
DATA_LIMIT_BYTES = 20 * 1024**3
SPEEDS = ("rapid", "bullet")
SEED = 24

SCORES_SCHEMA = pa.schema([
    ("cp", pa.int32()), ("mate", pa.int32()),
    ("second_cp", pa.int32()), ("second_mate", pa.int32()),
    ("best_uci", pa.string()), ("second_uci", pa.string()), ("pv", pa.string()),
    ("wdl_w", pa.int32()), ("wdl_d", pa.int32()), ("wdl_l", pa.int32()),
    ("depth", pa.int32()), ("nodes", pa.int64()),
    ("gap", pa.float64()), ("found", pa.bool_()),
])


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path: Path, value: dict) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    tmp.replace(path)


def fingerprint(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def dir_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def load_v1_settings(v1_root: Path) -> dict:
    v1 = json.loads((v1_root / "runs.json").read_text())
    keys = ("engine", "binary_sha256", "network", "depth", "multipv", "hash_mb", "threads", "wdl", "pv_moves")
    return {key: v1[key] for key in keys}


@contextmanager
def engines(settings: dict, workers: int = WORKERS):
    binary = find_stockfish()
    if not binary or fingerprint(Path(binary)) != settings["binary_sha256"]:
        raise ValueError("Labeling requires the recorded v1 Stockfish 19 binary")
    with ExitStack() as stack:
        pool = stack.enter_context(ThreadPoolExecutor(workers))
        ready = [stack.enter_context(chess.engine.SimpleEngine.popen_uci(binary, timeout=ENGINE_TIMEOUT))
                 for _ in range(workers)]
        for engine in ready:
            engine.configure({"Threads": settings["threads"], "Hash": settings["hash_mb"],
                              "UCI_ShowWDL": settings["wdl"]})
            engine.ping()
        yield pool, ready, settings


def score_lines(lines: list[dict], board: chess.Board, played: str, settings: dict) -> dict:
    def as_cp(value):
        return value.score() if not value.is_mate() else (3000 if value.mate() > 0 else -3000)

    first = lines[0]
    score = first["score"].white()
    wdl = first["wdl"].white()
    pv = [move.uci() for move in first["pv"][:settings["pv_moves"]]]
    row = {
        "cp": score.score(), "mate": score.mate(), "best_uci": pv[0],
        "pv": " ".join(pv), "wdl_w": wdl.wins, "wdl_d": wdl.draws, "wdl_l": wdl.losses,
        "depth": first["depth"], "nodes": first["nodes"], "found": played == pv[0],
    }
    if len(lines) >= 2:
        second = lines[1]["score"].white()
        sign = 1 if board.turn == chess.WHITE else -1
        row.update(
            second_cp=second.score(), second_mate=second.mate(),
            second_uci=lines[1]["pv"][0].uci(),
            gap=win_pct(sign * as_cp(score)) - win_pct(sign * as_cp(second)),
        )
    return row


def search_rows(engine, settings: dict, rows: list[dict], deadline: float) -> list[dict]:
    result = []
    limit = chess.engine.Limit(depth=settings["depth"])
    for row in rows:
        if time.monotonic() + 2 * ENGINE_TIMEOUT >= deadline:
            raise TimeoutError("The engine time budget for this shard is exhausted")
        board = chess.Board(row["fen"])
        # Pass a fresh game sentinel so Stockfish clears its hash before every search.
        lines = engine.analyse(board, limit, multipv=settings["multipv"], game=object())
        result.append(score_lines(lines, board, row["move_uci"], settings))
    return result


def search_batch(workers_ctx, rows: list[dict], deadline: float) -> pa.Table:
    pool, ready, settings = workers_ctx
    n_workers = len(ready)
    tasks = [pool.submit(search_rows, engine, settings, rows[i::n_workers], deadline)
             for i, engine in enumerate(ready)]
    results = [task.result() for task in tasks]
    interleaved = [results[i % n_workers][i // n_workers] for i in range(len(rows))]
    return pa.Table.from_pylist(interleaved, schema=SCORES_SCHEMA)


def build_sample(moves_path: Path, sample_path: Path, max_per_band: int, seed: int) -> pd.DataFrame:
    df = pd.read_parquet(moves_path)
    df = df[df["time_class"].isin(SPEEDS) & (df["ply"] >= 2) & df["pregame_rating"].notna()].copy()
    df["band"] = (df["pregame_rating"].astype(int) // 100) * 100
    rng = np.random.default_rng(seed)
    parts = []
    for (_, _), grp in df.groupby(["time_class", "band"], sort=True):
        if len(grp) > max_per_band:
            idx = rng.choice(grp.index.to_numpy(), size=max_per_band, replace=False)
            parts.append(grp.loc[np.sort(idx)])
        else:
            parts.append(grp)
    sampled = pd.concat(parts, ignore_index=True).drop(columns=["band"])
    sampled = sampled.sort_values(["time_class", "game_id", "ply"]).reset_index(drop=True)
    tmp = sample_path.with_suffix(".parquet.tmp")
    pq.write_table(pa.Table.from_pandas(sampled, preserve_index=False), tmp, compression="zstd",
                   row_group_size=SHARD_ROWS)
    tmp.replace(sample_path)
    return sampled


def run_benchmark(out_dir: Path, settings: dict, seed: int) -> dict:
    report_path = out_dir / "benchmark.json"
    if report_path.exists():
        prev = json.loads(report_path.read_text())
        if prev.get("settings") == settings:
            return prev

    moves_path = out_dir / "moves.parquet"
    df = pd.read_parquet(moves_path)
    rng = np.random.default_rng(seed)
    parts = []
    for speed in SPEEDS:
        sub = df[df["time_class"] == speed]
        take = min(len(sub), BENCH_PER_SPEED)
        if take > 0:
            idx = rng.choice(sub.index.to_numpy(), size=take, replace=False)
            parts.append(sub.loc[np.sort(idx)])
    bench_df = pd.concat(parts, ignore_index=True)
    rows = bench_df.to_dict("records")

    t_start = time.monotonic()
    with engines(settings, WORKERS) as workers_ctx:
        startup = time.monotonic() - t_start
        t_search = time.monotonic()
        scores = search_batch(workers_ctx, rows, t_search + ENGINE_BUDGET_SECONDS).to_pylist()
        seconds = time.monotonic() - t_search

    searched_by_speed = {s: int((bench_df["time_class"] == s).sum()) for s in SPEEDS}
    critical_by_speed = dict.fromkeys(SPEEDS, 0)
    for row, score in zip(rows, scores, strict=True):
        if score["gap"] is not None and score["gap"] >= CRITICAL_GAP:
            critical_by_speed[row["time_class"]] += 1

    report = {
        "settings": settings,
        "workers": WORKERS,
        "searches": len(rows),
        "seconds": round(seconds, 3),
        "startup_seconds": round(startup, 3),
        "searches_per_second": len(rows) / seconds,
        "searched_by_speed": searched_by_speed,
        "critical_by_speed": critical_by_speed,
    }
    write_json(report_path, report)
    return report


def write_shard(path: Path, sample_tbl: pa.Table, scores_tbl: pa.Table, run_id: str) -> None:
    combined = pa.Table.from_arrays(
        sample_tbl.columns + scores_tbl.columns,
        names=sample_tbl.schema.names + scores_tbl.schema.names,
    ).append_column("run_id", pa.array([run_id] * len(sample_tbl)))
    tmp = path.with_suffix(".parquet.tmp")
    try:
        pq.write_table(combined, tmp, compression="zstd")
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def run_label(out_dir: Path, settings: dict, max_per_band: int, seed: int) -> None:
    if dir_bytes(out_dir) >= DATA_LIMIT_BYTES:
        raise ValueError(f"{out_dir} reached the 20 GB storage cap")

    probe = run_benchmark(out_dir, settings, seed)
    sample_path = out_dir / "sample.parquet"
    if not sample_path.exists():
        build_sample(out_dir / "moves.parquet", sample_path, max_per_band, seed)
    sample_file = pq.ParquetFile(sample_path)
    sample_sha = fingerprint(sample_path)
    total_searches = sample_file.metadata.num_rows
    rate = probe["searches_per_second"]
    projected_seconds = probe["seconds"] + (total_searches / rate) * SAFETY_FACTOR

    projection = {
        "settings": settings,
        "workers": WORKERS,
        "total_searches": total_searches,
        "shards": sample_file.num_row_groups,
        "shard_rows": SHARD_ROWS,
        "searches_per_second": round(rate, 2),
        "benchmark_seconds": probe["seconds"],
        "projected_engine_seconds": round(projected_seconds, 1),
        "engine_budget_seconds": ENGINE_BUDGET_SECONDS,
        "data_bytes_before": dir_bytes(out_dir),
    }
    print(json.dumps({"projection": projection}, indent=2), flush=True)
    if projected_seconds > ENGINE_BUDGET_SECONDS:
        raise ValueError(f"Projected time {projected_seconds:.1f}s exceeds the 8-hour engine budget")

    manifest_path = out_dir / "runs.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    engine_run = manifest.get("engine_run")
    if engine_run is None:
        engine_run = {
            "started_utc": utc_now(),
            "settings": settings,
            "workers": WORKERS,
            "sample_sha256": sample_sha,
            "total_searches": total_searches,
            "shards": sample_file.num_row_groups,
            "projected_engine_seconds": round(projected_seconds, 1),
            "spent_seconds": probe["seconds"],
            "inflight": None,
        }
    else:
        if engine_run["sample_sha256"] != sample_sha:
            raise ValueError("The saved sample.parquet changed since labeling began")
        if engine_run.get("inflight") is not None:
            engine_run["spent_seconds"] += engine_run["inflight"]
            engine_run["inflight"] = None
    manifest["engine_run"] = engine_run
    write_json(manifest_path, manifest)

    pos_dir = out_dir / "positions"
    pos_dir.mkdir(exist_ok=True)
    remaining = []
    for i in range(sample_file.num_row_groups):
        part = pos_dir / f"part-{i:05d}.parquet"
        if part.exists():
            if pq.read_metadata(part).num_rows != sample_file.metadata.row_group(i).num_rows:
                raise ValueError(f"Shard {part.name} has an unexpected row count")
        else:
            remaining.append((i, part))

    if remaining:
        with engines(settings, WORKERS) as workers_ctx:
            for i, part in remaining:
                if dir_bytes(out_dir) >= DATA_LIMIT_BYTES:
                    raise ValueError("Reached 20 GB storage cap mid-run")
                rg = sample_file.read_row_group(i)
                rows = rg.to_pylist()
                reserve = min(ENGINE_BUDGET_SECONDS - engine_run["spent_seconds"], 300.0)
                if reserve <= 2 * ENGINE_TIMEOUT:
                    raise TimeoutError("Engine budget exhausted")
                engine_run["inflight"] = reserve
                write_json(manifest_path, manifest)
                t0 = time.monotonic()
                scores = search_batch(workers_ctx, rows, t0 + reserve)
                engine_run["spent_seconds"] += time.monotonic() - t0
                write_shard(part, rg, scores, sample_sha[:12])
                engine_run["inflight"] = None
                write_json(manifest_path, manifest)
                if (i + 1) % 5 == 0 or i + 1 == sample_file.num_row_groups:
                    print(f"Published shard {i + 1}/{sample_file.num_row_groups} "
                          f"({engine_run['spent_seconds']:.1f}s engine time)", flush=True)

    # Assemble training.parquet atomically from completed shards.
    shards = [pq.read_table(pos_dir / f"part-{i:05d}.parquet") for i in range(sample_file.num_row_groups)]
    full = pa.concat_tables(shards).to_pandas()
    critical = full[(full["gap"].notna()) & (full["gap"] >= CRITICAL_GAP)
                    & (full["ply"] >= 2) & full["pregame_rating"].notna()].copy()
    critical["evaluation_source"] = "stockfish_19"
    training_path = out_dir / "training.parquet"
    tmp = training_path.with_suffix(".parquet.tmp")
    pq.write_table(pa.Table.from_pandas(critical, preserve_index=False), tmp, compression="zstd")
    tmp.replace(training_path)

    engine_run["finished_utc"] = utc_now()
    engine_run["spent_seconds"] = round(engine_run["spent_seconds"], 2)
    manifest["engine_run"] = engine_run
    manifest.setdefault("counts", {})
    manifest["counts"]["searched_positions"] = int(len(full))
    manifest["counts"]["critical_positions"] = int(len(critical))
    manifest["counts"]["critical_by_speed"] = {k: int(v) for k, v in critical["time_class"].value_counts().items()}
    manifest["counts"]["critical_games"] = int(critical["game_id"].nunique())
    manifest["data_bytes"] = dir_bytes(out_dir)
    write_json(manifest_path, manifest)

    print(json.dumps({
        "training": str(training_path),
        "searched_positions": len(full),
        "critical_positions": len(critical),
        "critical_by_speed": manifest["counts"]["critical_by_speed"],
        "spent_seconds": engine_run["spent_seconds"],
        "data_bytes": manifest["data_bytes"],
    }, indent=2), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["benchmark", "label"])
    parser.add_argument("--v1-root", type=Path, default=ROOT / "data" / "engine" / "v1")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "engine" / "chesscom-rapid-v1")
    parser.add_argument("--max-per-band", type=int, default=12_000)
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args()

    settings = load_v1_settings(args.v1_root)
    if args.action == "benchmark":
        probe = run_benchmark(args.output, settings, args.seed)
        print(json.dumps({"benchmark": probe}, indent=2), flush=True)
    else:
        run_label(args.output, settings, args.max_per_band, args.seed)


if __name__ == "__main__":
    main()
