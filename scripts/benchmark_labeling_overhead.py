#!/usr/bin/env python3
"""Measure python-chess and UCI overhead against Stockfish's own search time."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import csv
import hashlib
import json
import multiprocessing as mp
from pathlib import Path
import platform
import random
import subprocess
import sys
import time

import chess
import chess.engine
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from chesscheck.engine import find_stockfish

DEFAULT_PUZZLES = ROOT / "data" / "puzzles_50k.csv"
DEFAULT_V1_RUNS = ROOT / "data" / "engine" / "v1" / "runs.json"
DEFAULT_OUT = ROOT / "eval_results" / "labeling-overhead"
SAMPLE_COUNT = 2000
SAMPLE_SEED = 20261126
WORKERS = 17
RUNS = 3
ENGINE_TIMEOUT = 30


def sha256_file(path: str | Path) -> str:
    with open(path, "rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def load_v1_settings(v1_runs: Path) -> dict:
    raw = json.loads(v1_runs.read_text())
    return {
        "engine": raw["engine"],
        "binary_sha256": raw["binary_sha256"],
        "network": raw["network"],
        "depth": int(raw["depth"]),
        "multipv": int(raw["multipv"]),
        "wdl": bool(raw["wdl"]),
        "hash_mb": int(raw["hash_mb"]),
        "threads": int(raw["threads"]),
    }


def sample_positions(puzzles_csv: Path, count: int, seed: int, out_txt: Path) -> list[str]:
    with puzzles_csv.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if len(rows) < count:
        raise ValueError(f"Requested {count} positions, but {puzzles_csv} only has {len(rows)}")
    chosen = random.Random(seed).sample(rows, count)
    fens: list[str] = []
    for row in chosen:
        board = chess.Board(row["FEN"])
        first_move = row["Moves"].split()[0]
        board.push_uci(first_move)
        fens.append(board.fen())
    out_txt.parent.mkdir(parents=True, exist_ok=True)
    out_txt.write_text("\n".join(fens) + "\n", encoding="utf-8")
    return fens


def extract_python_chess_result(lines: list[dict]) -> dict:
    def score_tuple(info: dict) -> tuple[str, int]:
        sc = info["score"].relative
        if sc.is_mate():
            return ("mate", int(sc.mate()))
        return ("cp", int(sc.score()))

    def wdl_tuple(info: dict) -> tuple[int, int, int] | None:
        wdl = info.get("wdl")
        if wdl is None:
            return None
        rel = wdl.relative
        return (int(rel.wins), int(rel.draws), int(rel.losses))

    first = lines[0]
    best_uci = first["pv"][0].uci() if first.get("pv") else None
    second_uci = None
    score2 = None
    wdl2 = None
    if len(lines) >= 2:
        second = lines[1]
        second_uci = second["pv"][0].uci() if second.get("pv") else None
        score2 = score_tuple(second)
        wdl2 = wdl_tuple(second)
    return {
        "best_uci": best_uci,
        "second_uci": second_uci,
        "score1": score_tuple(first),
        "score2": score2,
        "wdl1": wdl_tuple(first),
        "wdl2": wdl2,
        "depth": int(first["depth"]),
    }


def run_mode_a_single(binary: str, settings: dict, fens: list[str], capture_results: bool = False) -> dict:
    depth = chess.engine.Limit(depth=settings["depth"])
    times_ms: list[float] = []
    results: list[dict] = []
    with chess.engine.SimpleEngine.popen_uci(binary, timeout=ENGINE_TIMEOUT) as engine:
        engine.configure({
            "Threads": settings["threads"],
            "Hash": settings["hash_mb"],
            "UCI_ShowWDL": settings["wdl"],
        })
        engine.ping()
        t_start = time.perf_counter()
        for fen in fens:
            t0 = time.perf_counter()
            board = chess.Board(fen)
            lines = engine.analyse(board, depth, multipv=settings["multipv"], game=object())
            if capture_results:
                results.append(extract_python_chess_result(lines))
            t1 = time.perf_counter()
            times_ms.append((t1 - t0) * 1000.0)
        wall_s = time.perf_counter() - t_start
    return {"wall_s": wall_s, "times_ms": times_ms, "results": results}


def parse_uci_info(line: str) -> dict | None:
    tokens = line.split()
    if not tokens or tokens[0] != "info":
        return None
    if "pv" not in tokens or "score" not in tokens:
        return None
    if "lowerbound" in tokens or "upperbound" in tokens:
        return None
    multipv = 1
    depth = 0
    time_ms = 0
    score: tuple[str, int] | None = None
    wdl: tuple[int, int, int] | None = None
    first_move: str | None = None
    i = 1
    n = len(tokens)
    while i < n:
        tok = tokens[i]
        if tok == "multipv" and i + 1 < n:
            multipv = int(tokens[i + 1])
            i += 2
        elif tok == "depth" and i + 1 < n:
            depth = int(tokens[i + 1])
            i += 2
        elif tok == "time" and i + 1 < n:
            time_ms = int(tokens[i + 1])
            i += 2
        elif tok == "score" and i + 2 < n:
            score = (tokens[i + 1], int(tokens[i + 2]))
            i += 3
        elif tok == "wdl" and i + 3 < n:
            wdl = (int(tokens[i + 1]), int(tokens[i + 2]), int(tokens[i + 3]))
            i += 4
        elif tok == "pv" and i + 1 < n:
            first_move = tokens[i + 1]
            break
        else:
            i += 1
    if score is None or first_move is None:
        return None
    return {
        "multipv": multipv,
        "depth": depth,
        "time_ms": time_ms,
        "score": score,
        "wdl": wdl,
        "move": first_move,
    }


def start_raw_uci(binary: str, settings: dict) -> subprocess.Popen[str]:
    proc = subprocess.Popen(
        [binary],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    assert proc.stdin is not None and proc.stdout is not None
    proc.stdin.write("uci\n")
    proc.stdin.flush()
    for line in proc.stdout:
        if line.strip() == "uciok":
            break
    wdl_val = "true" if settings["wdl"] else "false"
    proc.stdin.write(
        f"setoption name Threads value {settings['threads']}\n"
        f"setoption name Hash value {settings['hash_mb']}\n"
        f"setoption name UCI_ShowWDL value {wdl_val}\n"
        f"setoption name MultiPV value {settings['multipv']}\n"
        "isready\n"
    )
    proc.stdin.flush()
    for line in proc.stdout:
        if line.strip() == "readyok":
            break
    return proc


def stop_raw_uci(proc: subprocess.Popen[str]) -> None:
    try:
        if proc.stdin is not None:
            proc.stdin.write("quit\n")
            proc.stdin.flush()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
        proc.wait()


def search_raw_uci(proc: subprocess.Popen[str], depth: int, fens: list[str],
                   capture_results: bool = False) -> dict:
    assert proc.stdin is not None and proc.stdout is not None
    stdin = proc.stdin
    stdout = proc.stdout
    total_ms: list[float] = []
    clear_ms: list[float] = []
    sf_time_ms: list[float] = []
    results: list[dict] = []
    t_start = time.perf_counter()
    for fen in fens:
        t0 = time.perf_counter()
        stdin.write("ucinewgame\nisready\n")
        stdin.flush()
        for line in stdout:
            if line.strip() == "readyok":
                break
        t1 = time.perf_counter()
        stdin.write(f"position fen {fen}\ngo depth {depth}\n")
        stdin.flush()
        last_by_pv: dict[int, dict] = {}
        last_info_time = 0
        for line in stdout:
            if line.startswith("info "):
                parsed = parse_uci_info(line)
                if parsed is not None:
                    last_by_pv[parsed["multipv"]] = parsed
                    last_info_time = parsed["time_ms"]
            elif line.startswith("bestmove "):
                break
        t2 = time.perf_counter()
        clear_ms.append((t1 - t0) * 1000.0)
        total_ms.append((t2 - t0) * 1000.0)
        sf_time_ms.append(float(last_info_time))
        if capture_results:
            p1 = last_by_pv.get(1)
            p2 = last_by_pv.get(2)
            results.append({
                "best_uci": p1["move"] if p1 else None,
                "second_uci": p2["move"] if p2 else None,
                "score1": p1["score"] if p1 else None,
                "score2": p2["score"] if p2 else None,
                "wdl1": p1["wdl"] if p1 else None,
                "wdl2": p2["wdl"] if p2 else None,
                "depth": p1["depth"] if p1 else 0,
            })
    wall_s = time.perf_counter() - t_start
    return {
        "wall_s": wall_s,
        "total_ms": total_ms,
        "clear_ms": clear_ms,
        "sf_time_ms": sf_time_ms,
        "results": results,
    }


def run_mode_b_single(binary: str, settings: dict, fens: list[str], capture_results: bool = False) -> dict:
    proc = start_raw_uci(binary, settings)
    try:
        return search_raw_uci(proc, settings["depth"], fens, capture_results=capture_results)
    finally:
        stop_raw_uci(proc)


def run_mode_a_parallel(binary: str, settings: dict, fens: list[str], workers: int) -> dict:
    depth = chess.engine.Limit(depth=settings["depth"])

    def worker(engine: chess.engine.SimpleEngine, chunk: list[str]) -> list[float]:
        out: list[float] = []
        for fen in chunk:
            t0 = time.perf_counter()
            board = chess.Board(fen)
            engine.analyse(board, depth, multipv=settings["multipv"], game=object())
            out.append((time.perf_counter() - t0) * 1000.0)
        return out

    with ExitStack() as stack:
        pool = stack.enter_context(ThreadPoolExecutor(workers))
        ready = [
            stack.enter_context(chess.engine.SimpleEngine.popen_uci(binary, timeout=ENGINE_TIMEOUT))
            for _ in range(workers)
        ]
        for engine in ready:
            engine.configure({
                "Threads": settings["threads"],
                "Hash": settings["hash_mb"],
                "UCI_ShowWDL": settings["wdl"],
            })
            engine.ping()
        t_start = time.perf_counter()
        futs = [pool.submit(worker, engine, fens[i::workers]) for i, engine in enumerate(ready)]
        per_worker = [f.result() for f in futs]
        wall_s = time.perf_counter() - t_start

    all_ms = [t for chunk in per_worker for t in chunk]
    return {"wall_s": wall_s, "throughput": len(fens) / wall_s, "times_ms": all_ms}


def _mode_b_worker(conn, binary: str, settings: dict, chunk: list[str]) -> None:
    proc = start_raw_uci(binary, settings)
    try:
        conn.send("ready")
        cmd = conn.recv()
        if cmd == "go":
            res = search_raw_uci(proc, settings["depth"], chunk, capture_results=False)
            conn.send({
                "total_ms": res["total_ms"],
                "clear_ms": res["clear_ms"],
                "sf_time_ms": res["sf_time_ms"],
            })
    finally:
        stop_raw_uci(proc)
        conn.close()


def run_mode_b_parallel(binary: str, settings: dict, fens: list[str], workers: int) -> dict:
    ctx = mp.get_context("fork")
    conns = []
    procs = []
    for i in range(workers):
        parent, child = ctx.Pipe()
        p = ctx.Process(target=_mode_b_worker, args=(child, binary, settings, fens[i::workers]))
        p.start()
        child.close()
        conns.append(parent)
        procs.append(p)
    for c in conns:
        msg = c.recv()
        if msg != "ready":
            raise RuntimeError(f"Unexpected worker ready message: {msg}")
    t_start = time.perf_counter()
    for c in conns:
        c.send("go")
    worker_results = [c.recv() for c in conns]
    wall_s = time.perf_counter() - t_start
    for c in conns:
        c.close()
    for p in procs:
        p.join()
    all_ms = [t for w in worker_results for t in w["total_ms"]]
    all_clear_ms = [t for w in worker_results for t in w["clear_ms"]]
    all_sf_ms = [t for w in worker_results for t in w["sf_time_ms"]]
    return {
        "wall_s": wall_s,
        "throughput": len(fens) / wall_s,
        "times_ms": all_ms,
        "clear_ms": all_clear_ms,
        "sf_time_ms": all_sf_ms,
    }


def summarize_ms(values: list[float]) -> dict[str, float]:
    arr = np.asarray(values, dtype=np.float64)
    return {
        "p10": float(np.percentile(arr, 10)),
        "median": float(np.percentile(arr, 50)),
        "p90": float(np.percentile(arr, 90)),
        "mean": float(arr.mean()),
    }


def compare_results(fens: list[str], res_a: list[dict], res_b: list[dict]) -> list[dict]:
    mismatches = []
    keys = ("best_uci", "second_uci", "score1", "score2", "wdl1", "wdl2")
    for idx, (fen, a, b) in enumerate(zip(fens, res_a, res_b, strict=True)):
        diffs = {k: (a[k], b[k]) for k in keys if a[k] != b[k]}
        if diffs:
            mismatches.append({"index": idx, "fen": fen, "diffs": diffs})
    return mismatches


def machine_info() -> dict[str, str]:
    info = {"macos": platform.mac_ver()[0]}
    for key in ("machdep.cpu.brand_string", "hw.ncpu", "hw.perflevel0.physicalcpu", "hw.perflevel1.physicalcpu"):
        res = subprocess.run(["sysctl", "-n", key], capture_output=True, text=True)
        if res.returncode == 0:
            info[key] = res.stdout.strip()
    return info


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--puzzles", type=Path, default=DEFAULT_PUZZLES)
    parser.add_argument("--v1-runs", type=Path, default=DEFAULT_V1_RUNS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--count", type=int, default=SAMPLE_COUNT)
    parser.add_argument("--seed", type=int, default=SAMPLE_SEED)
    parser.add_argument("--workers", type=int, default=WORKERS)
    parser.add_argument("--runs", type=int, default=RUNS)
    args = parser.parse_args()

    binary = find_stockfish()
    if not binary:
        raise SystemExit("Stockfish binary not found via find_stockfish()")
    settings = load_v1_settings(args.v1_runs)
    actual_sha = sha256_file(binary)
    if actual_sha != settings["binary_sha256"]:
        raise SystemExit(
            f"Stockfish SHA-256 mismatch: got {actual_sha}, expected {settings['binary_sha256']}"
        )

    args.output.mkdir(parents=True, exist_ok=True)
    fens = sample_positions(args.puzzles, args.count, args.seed, args.output / "positions.txt")
    print(f"Binary: {binary} (sha256 {actual_sha} matches v1)")
    print(f"Sampled {len(fens)} positions (seed {args.seed}) -> {args.output / 'positions.txt'}")
    sys.stdout.flush()

    seq_a_runs = []
    seq_b_runs = []
    first_a_results: list[dict] = []
    first_b_results: list[dict] = []
    for r in range(args.runs):
        res_a = run_mode_a_single(binary, settings, fens, capture_results=(r == 0))
        if r == 0:
            first_a_results = res_a["results"]
        seq_a_runs.append({"wall_s": res_a["wall_s"], "stats": summarize_ms(res_a["times_ms"]),
                           "times_ms": res_a["times_ms"]})
        print(f"Seq A run {r + 1}/{args.runs}: wall={res_a['wall_s']:.2f}s, "
              f"median={seq_a_runs[-1]['stats']['median']:.2f}ms", flush=True)

        res_b = run_mode_b_single(binary, settings, fens, capture_results=(r == 0))
        if r == 0:
            first_b_results = res_b["results"]
        seq_b_runs.append({
            "wall_s": res_b["wall_s"],
            "stats": summarize_ms(res_b["total_ms"]),
            "clear_stats": summarize_ms(res_b["clear_ms"]),
            "sf_stats": summarize_ms(res_b["sf_time_ms"]),
            "total_ms": res_b["total_ms"],
            "clear_ms": res_b["clear_ms"],
            "sf_time_ms": res_b["sf_time_ms"],
        })
        print(f"Seq B run {r + 1}/{args.runs}: wall={res_b['wall_s']:.2f}s, "
              f"median={seq_b_runs[-1]['stats']['median']:.2f}ms, "
              f"clear={seq_b_runs[-1]['clear_stats']['median']:.3f}ms, "
              f"sf_time={seq_b_runs[-1]['sf_stats']['median']:.2f}ms", flush=True)

    mismatches = compare_results(fens, first_a_results, first_b_results)
    print(f"Correctness check (A vs B on {len(fens)} positions): {len(mismatches)} mismatches", flush=True)
    for m in mismatches[:5]:
        print("  Mismatch:", m, flush=True)

    par_a_runs = []
    par_b_runs = []
    for r in range(args.runs):
        pa = run_mode_a_parallel(binary, settings, fens, args.workers)
        par_a_runs.append({"wall_s": pa["wall_s"], "throughput": pa["throughput"],
                           "stats": summarize_ms(pa["times_ms"])})
        print(f"Par A ({args.workers}w) run {r + 1}/{args.runs}: wall={pa['wall_s']:.2f}s, "
              f"rate={pa['throughput']:.1f}/s, per-pos median={par_a_runs[-1]['stats']['median']:.2f}ms",
              flush=True)

        pb = run_mode_b_parallel(binary, settings, fens, args.workers)
        par_b_runs.append({
            "wall_s": pb["wall_s"],
            "throughput": pb["throughput"],
            "stats": summarize_ms(pb["times_ms"]),
            "clear_stats": summarize_ms(pb["clear_ms"]),
            "sf_stats": summarize_ms(pb["sf_time_ms"]),
        })
        print(f"Par B ({args.workers}w) run {r + 1}/{args.runs}: wall={pb['wall_s']:.2f}s, "
              f"rate={pb['throughput']:.1f}/s, per-pos median={par_b_runs[-1]['stats']['median']:.2f}ms, "
              f"sf_time median={par_b_runs[-1]['sf_stats']['median']:.2f}ms",
              flush=True)

    pooled_a = [t for run in seq_a_runs for t in run["times_ms"]]
    pooled_b = [t for run in seq_b_runs for t in run["total_ms"]]
    pooled_clear = [t for run in seq_b_runs for t in run["clear_ms"]]
    pooled_c = [t for run in seq_b_runs for t in run["sf_time_ms"]]
    pooled_clear_share = [100.0 * c / b for c, b in zip(pooled_clear, pooled_b, strict=True)]

    seq_summary = {
        "A_ms": summarize_ms(pooled_a),
        "B_ms": summarize_ms(pooled_b),
        "B_clear_ms": summarize_ms(pooled_clear),
        "B_clear_pct": summarize_ms(pooled_clear_share),
        "C_ms": summarize_ms(pooled_c),
        "A_run_walls_s": [r["wall_s"] for r in seq_a_runs],
        "B_run_walls_s": [r["wall_s"] for r in seq_b_runs],
    }

    ta = float(np.median([r["throughput"] for r in par_a_runs]))
    tb = float(np.median([r["throughput"] for r in par_b_runs]))
    median_c_s = seq_summary["C_ms"]["median"] / 1000.0
    tc = args.workers / median_c_s
    par_c_median_ms = float(np.median([r["sf_stats"]["median"] for r in par_b_runs]))
    tc_parallel_c = args.workers / (par_c_median_ms / 1000.0)
    mean_c_s = seq_summary["C_ms"]["mean"] / 1000.0
    tc_mean_c = args.workers / mean_c_s

    def rule(ceiling: float) -> str:
        if ta >= 0.8 * ceiling:
            return "keep_current_python_chess"
        if tb >= 0.8 * ceiling:
            return "switch_to_raw_uci_processes"
        return "build_cpp_batch_labeler"

    # The ucinewgame hash clear is Stockfish's own work: any labeler that reproduces the v1 labels,
    # including an in-process C++ one, has to clear the hash too. Throughput follows mean time, not
    # median time, so the ceiling is the parallel mean search time plus the parallel mean clear.
    par_work_ms = float(np.median([r["sf_stats"]["mean"] + r["clear_stats"]["mean"] for r in par_b_runs]))
    tw = args.workers / (par_work_ms / 1000.0)
    par_a_mean_ms = float(np.median([r["stats"]["mean"] for r in par_a_runs]))
    par_b_mean_ms = float(np.median([r["stats"]["mean"] for r in par_b_runs]))
    decision_original_rule = rule(tc)
    decision = rule(tw)

    report = {
        "machine": machine_info(),
        "binary": binary,
        "binary_sha256": actual_sha,
        "settings": settings,
        "sample_count": len(fens),
        "sample_seed": args.seed,
        "workers": args.workers,
        "runs": args.runs,
        "mismatches": len(mismatches),
        "mismatch_examples": mismatches[:10],
        "sequential": seq_summary,
        "parallel": {
            "A_runs": par_a_runs,
            "B_runs": par_b_runs,
            "TA": ta,
            "TB": tb,
            "TC_from_seq_median_C": tc,
            "TC_from_par_median_C": tc_parallel_c,
            "TC_from_seq_mean_C": tc_mean_c,
            "TA_over_TC": ta / tc,
            "TB_over_TC": tb / tc,
            "TB_over_TA": tb / ta,
            "TC_over_TA": tc / ta,
            "stockfish_work_ms": par_work_ms,
            "TW": tw,
            "A_mean_ms": par_a_mean_ms,
            "B_mean_ms": par_b_mean_ms,
            "A_overhead_pct": 100.0 * (par_a_mean_ms - par_work_ms) / par_a_mean_ms,
            "B_overhead_pct": 100.0 * (par_b_mean_ms - par_work_ms) / par_b_mean_ms,
            "TA_over_TW": ta / tw,
            "TB_over_TW": tb / tw,
        },
        "decision_original_rule": decision_original_rule,
        "decision": decision,
    }
    (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print("\n=== SUMMARY ===")
    print(f"Sequential (1 engine, {args.runs} runs x {len(fens)} positions):")
    for label, key in [("Mode A (python-chess)", "A_ms"), ("Mode B (raw UCI)", "B_ms"),
                       ("B ucinewgame/readyok", "B_clear_ms"), ("Mode C (Stockfish time)", "C_ms")]:
        s = seq_summary[key]
        print(f"  {label:24}: median={s['median']:.2f}ms (p10={s['p10']:.2f}, p90={s['p90']:.2f}, mean={s['mean']:.2f})")
    cs = seq_summary["B_clear_pct"]
    print(f"  {'B clear share (%)':24}: median={cs['median']:.2f}% (p10={cs['p10']:.2f}%, p90={cs['p90']:.2f}%)")
    print(f"\nParallel ({args.workers} engines, {args.runs} runs x {len(fens)} positions):")
    print(f"  TA (python-chess threads)  : {ta:.1f} searches/s (wall/pos median={np.median([r['stats']['median'] for r in par_a_runs]):.2f}ms)")
    print(f"  TB (raw UCI processes)     : {tb:.1f} searches/s (wall/pos median={np.median([r['stats']['median'] for r in par_b_runs]):.2f}ms)")
    print(f"  TC (17 / median seq C)     : {tc:.1f} searches/s (0.8 * TC = {0.8 * tc:.1f})")
    print(f"  TC (17 / median par C)     : {tc_parallel_c:.1f} searches/s")
    print(f"  TC (17 / mean seq C)       : {tc_mean_c:.1f} searches/s")
    print(f"  Stockfish work (search + clear, parallel mean): {par_work_ms:.2f}ms per search")
    print(f"  TW (workers / that)        : {tw:.1f} searches/s (0.8 * TW = {0.8 * tw:.1f})")
    print(f"  Overhead per search        : A {100.0 * (par_a_mean_ms - par_work_ms) / par_a_mean_ms:.1f}%, "
          f"B {100.0 * (par_b_mean_ms - par_work_ms) / par_b_mean_ms:.1f}%")
    print(f"  Decision (original TC rule): {decision_original_rule}")
    print(f"  Decision (TW ceiling)      : {decision}")


if __name__ == "__main__":
    main()
