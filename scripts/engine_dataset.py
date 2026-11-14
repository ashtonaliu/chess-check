"""Build the reusable engine dataset described in docs/engine-study-plan.md.

Analyzes every game behind the odds study's 15,000 blitz targets (each focal player's and each
opponent's 50 games before the target's PGN start) with Stockfish, once, and stores every raw
result so later questions are queries instead of new engine runs.

  python scripts/engine_dataset.py select      # pick targets, download histories (cached)
  python scripts/engine_dataset.py benchmark   # time depth / node budget / worker settings
  python scripts/engine_dataset.py analyze     # the long run; resumable, safe to interrupt

Output, under data/engine/v1/ (gitignored), queried with DuckDB:
  games/part-NNNNN.parquet      one row per game (metadata and the full PGN)
  positions/part-NNNNN.parquet  one row per position (ply 0 = start): evaluations from White's side
                                (cp, mate), win/draw/loss per mille, best line, second-best move
                                (MultiPV 2), clock and time spent, and a deeper re-check of
                                positions around big mistakes
  samples/targets.parquet       which games are targets and which histories belong to them
  runs.json                     engine version, binary hash, network and every setting

Crash safety: each batch writes positions first, then games, each to a temporary file renamed into
place when complete, so a power loss never leaves a half-written file. A game counts as done once
its games shard exists; a restart skips done games, deletes leftover temporary files and refuses
to continue with different settings.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import chess
import chess.engine
import chess.pgn

sys.path.insert(0, str(Path(__file__).resolve().parent))
import eval_engine_features as study  # noqa: E402  (target selection, history cutoffs, downloads)
from chesscheck import engine as cc_engine  # noqa: E402

ROOT = study.ROOT
OUT = ROOT / "data" / "engine" / "v1"
SOURCE = ROOT / "data" / "odds" / "v3"
CACHE = ROOT / "data" / "odds" / "engine"          # shared download cache with the engine study
SETTINGS = {"depth": 10, "multipv": 2, "wdl": True, "recheck_depth": 14, "recheck_drop": 20.0,
            "hash_mb": 32, "threads": 1, "pv_moves": 6}
BATCH = 200
CLK = re.compile(r"\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]")


# ---------- selection ----------

def select(count: int) -> None:
    targets = json.loads((SOURCE / "targets.json").read_text())
    chosen = study.sample_targets(targets, count)
    print(f"{len(chosen)} targets from {len({t['focal'].lower() for t in chosen})} focal players", flush=True)
    rows, jobs, exclusions = study.plan(chosen, SOURCE, CACHE)
    print(f"eligible targets {len(rows)}; excluded {exclusions}; games to analyze {len(jobs)}", flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "samples").mkdir(exist_ok=True)
    keep = ("url", "pgn", "white", "black", "time_control", "time_class", "end_time", "eco", "rated", "accuracies")
    jobs = {gid: {k: raw[k] for k in keep if k in raw} for gid, raw in jobs.items()}
    jobs_path = OUT / "samples" / "jobs.json"
    study.write_json(jobs_path, jobs)
    import duckdb
    con = duckdb.connect()
    con.execute("CREATE TABLE t (target_id VARCHAR, focal VARCHAR, opponent VARCHAR, start_ts BIGINT, "
                "focal_pre DOUBLE, opponent_pre DOUBLE, focal_history VARCHAR[], opponent_history VARCHAR[])")
    for focal, raw, gid, ratings, past in rows:
        color = study.side(raw, focal)
        opp = raw["black" if color == "white" else "white"]["username"].lower()
        con.execute("INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [gid, focal, opp, study.game_start(raw), ratings[0], ratings[1],
                     [k for k, _ in past[0]], [k for k, _ in past[1]]])
    _copy(con, "SELECT * FROM t", OUT / "samples" / "targets.parquet")
    print(f"wrote {jobs_path} and samples/targets.parquet", flush=True)


# ---------- analysis of one game ----------

def _clocks(pgn: str) -> list[float]:
    return [int(h) * 3600 + int(m) * 60 + float(s) for h, m, s in CLK.findall(pgn)]


def _score(info) -> tuple[int | None, int | None]:
    s = info["score"].white()
    return (None, s.mate()) if s.is_mate() else (s.score(), None)


def _wdl(info) -> tuple[int | None, int | None, int | None]:
    w = info.get("wdl")
    if w is None:
        return None, None, None
    w = w.white()
    return w.wins, w.draws, w.losses


def _win_pct_white(cp: int | None, mate: int | None) -> float:
    if mate is not None:
        return 100.0 if mate > 0 else 0.0
    return cc_engine.win_pct(cp)


def analyze_game(raw: dict, fish: chess.engine.SimpleEngine, run_id: str, cfg: dict) -> tuple[dict, list[dict]]:
    gid = study.game_id(raw["url"])
    game = chess.pgn.read_game(io.StringIO(raw["pgn"]))
    board = game.board()
    moves = list(game.mainline_moves())
    clocks = _clocks(raw["pgn"])
    tc = str(raw.get("time_control", ""))
    base, inc = (tc.split("+") + ["0"])[:2] if "/" not in tc else ("0", "0")
    base, inc = float(base or 0), float(inc or 0)
    limit = chess.engine.Limit(depth=cfg["depth"])
    rows = []
    for ply in range(len(moves) + 1):
        row = {"game_id": gid, "ply": ply, "fen": board.fen(), "mover": "white" if board.turn else "black",
               "run_id": run_id}
        if ply < len(moves):
            mv = moves[ply]
            row["move_uci"], row["move_san"] = mv.uci(), board.san(mv)
            own = clocks[ply] if ply < len(clocks) else None
            prev_own = clocks[ply - 2] if ply >= 2 and ply - 2 < len(clocks) else (base if base else None)
            row["clock_after"] = own
            row["time_spent"] = (prev_own - own + inc) if own is not None and prev_own is not None else None
        else:
            row.update(move_uci=None, move_san=None, clock_after=None, time_spent=None)
        if board.is_game_over():
            outcome = board.outcome()
            row.update(terminal=outcome.termination.name.lower(), cp=None, mate=None, wdl_w=None, wdl_d=None,
                       wdl_l=None, best_uci=None, pv=None, second_uci=None, second_cp=None, second_mate=None,
                       depth=None, nodes=None)
        else:
            row["terminal"] = None
            infos = fish.analyse(board, limit, multipv=cfg["multipv"], game=gid)
            first = infos[0]
            cp, mate = _score(first)
            w, d, l = _wdl(first)
            pv = [m.uci() for m in first.get("pv", [])[:cfg["pv_moves"]]]
            row.update(cp=cp, mate=mate, wdl_w=w, wdl_d=d, wdl_l=l, best_uci=pv[0] if pv else None,
                       pv=" ".join(pv) or None, depth=first.get("depth"), nodes=first.get("nodes"))
            if len(infos) > 1:
                s_cp, s_mate = _score(infos[1])
                second = infos[1].get("pv", [None])[0]
                row.update(second_uci=second.uci() if second else None, second_cp=s_cp, second_mate=s_mate)
            else:
                row.update(second_uci=None, second_cp=None, second_mate=None)   # only one legal move
        rows.append(row)
        if ply < len(moves):
            board.push(moves[ply])
    # deeper re-check around big mistakes: the position before the move and the one after it
    deep_limit = chess.engine.Limit(depth=cfg["recheck_depth"])
    flagged = set()

    def mover_win_pct(row: dict, mover: str) -> float | None:
        """Winning chances for `mover` in this position (from its stored evaluation or the result)."""
        if row["terminal"] == "checkmate":
            return 0.0 if row["mover"] == mover else 100.0       # the side to move is mated
        if row["terminal"]:
            return 50.0
        if row["cp"] is None and row["mate"] is None:
            return None
        white = _win_pct_white(row["cp"], row["mate"])
        return white if mover == "white" else 100 - white

    for ply in range(len(moves)):
        a, b = rows[ply], rows[ply + 1]
        before, after = mover_win_pct(a, a["mover"]), mover_win_pct(b, a["mover"])
        if before is not None and after is not None and before - after >= cfg["recheck_drop"]:
            flagged.update((ply, ply + 1))
    for r in rows:
        r.update(deep_cp=None, deep_mate=None, deep_best=None, deep_pv=None)
    for ply in sorted(flagged):
        if rows[ply]["terminal"]:
            continue
        b = chess.Board(rows[ply]["fen"])
        info = fish.analyse(b, deep_limit, game=gid)
        cp, mate = _score(info)
        pv = [m.uci() for m in info.get("pv", [])[:cfg["pv_moves"]]]
        rows[ply].update(deep_cp=cp, deep_mate=mate, deep_best=pv[0] if pv else None, deep_pv=" ".join(pv) or None)
    h = game.headers
    acc = raw.get("accuracies") or {}
    meta = {"game_id": gid, "url": raw["url"], "white": raw["white"]["username"], "black": raw["black"]["username"],
            "white_rating_after": raw["white"].get("rating"), "black_rating_after": raw["black"].get("rating"),
            "white_result": raw["white"].get("result"), "black_result": raw["black"].get("result"),
            "time_class": raw.get("time_class"), "time_control": tc, "base_seconds": base, "increment_seconds": inc,
            "start_ts": study.game_start(raw), "end_ts": raw.get("end_time"), "eco": h.get("ECO"),
            "opening_url": raw.get("eco"), "rated": raw.get("rated"), "plies": len(moves),
            "white_accuracy": acc.get("white"), "black_accuracy": acc.get("black"), "pgn": raw["pgn"],
            "run_id": run_id}
    return meta, rows


# ---------- batches, files and resuming ----------

def _copy(con, query: str, path: Path) -> None:
    """Write a query to Parquet atomically: a temporary file renamed into place when complete."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".parquet.tmp")
    con.execute(f"COPY ({query}) TO '{tmp}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    os.replace(tmp, path)


def run_batch(args: tuple[int, list[dict], str, str, dict, str]) -> tuple[int, int, float]:
    index, raws, binary, run_id, cfg, out = args
    out = Path(out)
    import duckdb
    import pandas as pd
    started = time.perf_counter()
    games, positions = [], []
    with chess.engine.SimpleEngine.popen_uci(binary) as fish:
        fish.configure({"Threads": cfg["threads"], "Hash": cfg["hash_mb"], "UCI_ShowWDL": cfg["wdl"]})
        for raw in raws:
            meta, rows = analyze_game(raw, fish, run_id, cfg)
            games.append(meta); positions.extend(rows)
    con = duckdb.connect()
    pos_df, games_df = pd.DataFrame(positions), pd.DataFrame(games)
    con.register("pos_df", pos_df); con.register("games_df", games_df)
    _copy(con, "SELECT * FROM pos_df", out / "positions" / f"part-{index:05d}.parquet")
    _copy(con, "SELECT * FROM games_df", out / "games" / f"part-{index:05d}.parquet")   # last: marks done
    return index, len(raws), time.perf_counter() - started


def _engine_identity(binary: str) -> dict:
    with Path(binary).open("rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    out = subprocess.run([binary], input="uci\nquit\n", capture_output=True, text=True, timeout=15).stdout
    name = next((l[8:] for l in out.splitlines() if l.startswith("id name ")), "?")
    net = next((l.split("default ")[-1] for l in out.splitlines() if "EvalFile" in l), "?")
    return {"engine": name, "binary_sha256": digest, "network": net}


def _commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    except OSError:
        return "?"


def analyze(workers: int, limit_games: int | None) -> None:
    binary = cc_engine.find_stockfish()
    if not binary:
        sys.exit("Stockfish not found. Set STOCKFISH_PATH.")
    jobs = json.loads((OUT / "samples" / "jobs.json").read_text())
    for tmp in OUT.rglob("*.parquet.tmp"):
        tmp.unlink()
    identity = _engine_identity(binary)
    runs_path = OUT / "runs.json"
    settings = {**SETTINGS, **identity}
    if runs_path.exists():
        prior = json.loads(runs_path.read_text())
        if {k: prior[k] for k in settings} != settings:
            sys.exit(f"{runs_path} has different settings; refusing to mix them into the same dataset.")
        run_id = prior["run_id"]
    else:
        run_id = hashlib.sha256(json.dumps(settings, sort_keys=True).encode()).hexdigest()[:12]
        study.write_json(runs_path, {"run_id": run_id, **settings, "script_commit": _commit(),
                                     "started": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
    # games already stored, read from the small games shards
    done: set[str] = set()
    shards = sorted((OUT / "games").glob("part-*.parquet")) if (OUT / "games").exists() else []
    if shards:
        import duckdb
        done = {r[0] for r in duckdb.sql(f"SELECT game_id FROM read_parquet('{OUT}/games/part-*.parquet')").fetchall()}
    todo = [raw for gid, raw in sorted(jobs.items()) if gid not in done]
    if limit_games:
        todo = todo[:limit_games]
    next_index = max((int(p.stem.split("-")[1]) for p in shards), default=-1) + 1
    batches = [(next_index + i, todo[i * BATCH:(i + 1) * BATCH], binary, run_id, SETTINGS, str(OUT))
               for i in range((len(todo) + BATCH - 1) // BATCH)]
    print(f"{len(done)} games already stored, {len(todo)} to analyze in {len(batches)} batches, {workers} workers", flush=True)
    started, finished = time.perf_counter(), 0
    with ProcessPoolExecutor(workers) as pool:
        for fut in as_completed([pool.submit(run_batch, b) for b in batches]):
            index, n, seconds = fut.result()
            finished += n
            rate = finished / (time.perf_counter() - started)
            left = (len(todo) - finished) / rate if rate else 0
            print(f"batch {index}: {n} games in {seconds:.0f}s; {finished}/{len(todo)} done, "
                  f"{rate:.1f} games/s, about {left / 3600:.1f} h left", flush=True)
    prior = json.loads(runs_path.read_text())
    prior["last_finished"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    study.write_json(runs_path, prior)


# ---------- timing ----------

def benchmark(games: int) -> None:
    """Time settings on the same games before the long run (results go to a scratch folder)."""
    binary = cc_engine.find_stockfish()
    jobs = json.loads((OUT / "samples" / "jobs.json").read_text())
    sample = [jobs[k] for k in sorted(jobs)[:games]]
    for label, change, workers in (("depth 10, MultiPV 2, 17 workers", {}, 17),
                                   ("depth 8, MultiPV 2, 17 workers", {"depth": 8}, 17),
                                   ("depth 10, MultiPV 1, 17 workers", {"multipv": 1}, 17),
                                   ("depth 10, MultiPV 2, 12 workers", {}, 12),
                                   ("depth 10, MultiPV 2, 18 workers", {}, 18)):
        cfg = {**SETTINGS, **change}
        out = OUT.parent / "benchmark" / re.sub(r"[^a-z0-9]+", "_", label.lower())
        per = -(-len(sample) // workers)
        chunks = [(i, sample[i * per:(i + 1) * per], binary, "bench", cfg, str(out)) for i in range(workers)
                  if sample[i * per:(i + 1) * per]]
        started = time.perf_counter()
        with ProcessPoolExecutor(workers) as pool:
            n = sum(f.result()[1] for f in as_completed([pool.submit(run_batch, c) for c in chunks]))
        rate = n / (time.perf_counter() - started)
        print(f"{label:34s} {rate:5.1f} games/s  -> {len(jobs) / rate / 3600:4.1f} h for all {len(jobs):,} games", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["select", "benchmark", "analyze"])
    ap.add_argument("--count", type=int, default=15000)
    ap.add_argument("--workers", type=int, default=17)
    ap.add_argument("--games", type=int, default=170, help="benchmark sample size")
    ap.add_argument("--limit", type=int, default=None, help="analyze at most this many games (testing)")
    a = ap.parse_args()
    if a.cmd == "select":
        select(a.count)
    elif a.cmd == "benchmark":
        benchmark(a.games)
    else:
        analyze(a.workers, a.limit)


if __name__ == "__main__":
    main()
