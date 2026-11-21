#!/usr/bin/env python3
"""Benchmark and label a stratified sample of played moves from the October Lichess bucket."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
import fcntl
import hashlib
import json
import math
from pathlib import Path
import sys
import tempfile
import time

import chess
import chess.engine
import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chesscheck.dataset import CRITICAL_GAP, _literal
from chesscheck.engine import find_stockfish, win_pct
from chesscheck.lichess_dataset import register_views
from scripts.label_lichess import BudgetedWriter, moves_with_metadata, query_rows
from scripts.lichess_data import DATA, LICHESS, LIMIT, OCTOBER, data_bytes

OUT = DATA / "engine" / "lichess-v1"
GAMES = LICHESS / OCTOBER
CLOUD = LICHESS / f"{OCTOBER}-labels"
WORKERS = 17
BENCH_PER_SPEED = 10_000
SHARD_ROWS = 8192
ENGINE_TIMEOUT = 30
ENGINE_SECONDS = 8 * 3600
ROW_TARGET = 100_000
SAFETY_FACTOR = 1.25
SPEEDS = {"ultraBullet", "bullet", "blitz", "rapid", "classical"}

SCORES = pa.schema([
    ("cp", pa.int32()), ("mate", pa.int32()),
    ("second_cp", pa.int32()), ("second_mate", pa.int32()),
    ("best_uci", pa.string()), ("second_uci", pa.string()), ("pv", pa.string()),
    ("wdl_w", pa.int32()), ("wdl_d", pa.int32()), ("wdl_l", pa.int32()),
    ("depth", pa.int32()), ("nodes", pa.int64()),
    ("gap", pa.float64()), ("found", pa.bool_()),
])


def available_bytes():
    remaining = LIMIT - data_bytes() - 1_000_000
    if remaining <= 0:
        raise ValueError("No space remains within the 150 GB cap")
    return remaining


def write_json(path, value):
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def fingerprint(path):
    with open(path, "rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def source_settings():
    source = json.loads((GAMES / "run.json").read_text())
    if source["projection"]["position_mod"] != 20 or source["projection"]["bucket"] != 0:
        raise ValueError("The labeling run requires the original 1-in-20 position bucket")
    v1 = json.loads((DATA / "engine" / "v1" / "runs.json").read_text())
    keys = ("engine", "binary_sha256", "network", "depth", "multipv", "hash_mb", "threads", "wdl", "pv_moves")
    return {"source": source["source"], "settings": {key: v1[key] for key in keys},
            "duckdb_version": duckdb.__version__, "workers": WORKERS}


def populations():
    actual = json.loads((GAMES / "run.json").read_text())["actual"]
    with duckdb.connect() as con:
        con.execute("SET memory_limit = '8GB'; SET threads = 8; SET max_temp_directory_size = '0B'")
        register_views(con, GAMES)
        sizes = dict(con.execute("""
            SELECT time_class, sum(plies)
            FROM lichess_games WHERE position_sampled AND time_class IS NOT NULL
            GROUP BY time_class
        """).fetchall())
    if sizes.keys() != SPEEDS or sum(sizes.values()) != actual["positions"] - actual["sampled_games"]:
        raise ValueError("Speed population counts differ from the ingest report")
    return sizes


def record_batches(relation):
    reader = getattr(relation, "to_arrow_reader", relation.fetch_record_batch)
    return reader(SHARD_ROWS)


def write_sample(path, counts, sizes, salt):
    """Take the lowest uniform move hashes per speed using a padded candidate threshold."""
    available = available_bytes()
    output_bound = min(8_000_000_000, available // 5)
    partial = path.with_suffix(".parquet.tmp")
    try:
        with tempfile.TemporaryDirectory(prefix=".sample-", dir=OUT) as scratch, duckdb.connect() as con:
            con.execute("SET memory_limit = '12GB'; SET threads = 8; SET preserve_insertion_order = false")
            con.execute(f"SET temp_directory = {_literal(scratch)}")
            con.execute(f"SET max_temp_directory_size = '{available - output_bound}B'")
            register_views(con, GAMES)
            con.execute("CREATE TEMP TABLE allocation (time_class VARCHAR, searches BIGINT, ceiling HUGEINT)")
            allocation = []
            for speed, count in sorted(counts.items()):
                padded = min(sizes[speed], count + max(1000, math.ceil(12 * math.sqrt(count))))
                allocation.append((speed, count, ((1 << 64) * padded + sizes[speed] - 1) // sizes[speed]))
            con.executemany("INSERT INTO allocation VALUES (?, ?, ?)", allocation)
            con.execute(f"""
                CREATE TEMP TABLE sampled_moves AS
                SELECT p.shard, p.game_id, p.ply, p.fen, p.mover, p.move_uci, p.move_san,
                       p.clock_after, p.time_spent, p.source, a.time_class AS bucket_speed,
                       split_part(p.fen, ' ', 1) AS placement,
                       hash(p.game_id, p.ply, {_literal(salt)}) AS draw
                FROM lichess_positions p
                JOIN (SELECT shard, game_id, time_class FROM lichess_games WHERE position_sampled) g
                    USING (shard, game_id)
                JOIN allocation a ON a.time_class = g.time_class
                WHERE p.move_uci IS NOT NULL AND draw::HUGEINT < a.ceiling
                QUALIFY row_number() OVER (
                    PARTITION BY a.time_class ORDER BY draw, p.game_id, p.ply
                ) <= a.searches
            """)
            actual = dict(con.execute("SELECT bucket_speed, count(*) FROM sampled_moves GROUP BY 1").fetchall())
            if actual != counts:
                raise ValueError(f"The selected sample differs from its allocation: {actual}")
            sql = moves_with_metadata("sampled_moves")
            relation = con.sql(f"""
                SELECT * EXCLUDE (draw, bucket_speed)
                FROM ({sql}) ORDER BY time_class, draw, game_id, ply
            """)
            with record_batches(relation) as reader, BudgetedWriter(partial.open("wb", buffering=0), output_bound) as sink:
                with pq.ParquetWriter(sink, reader.schema, compression="zstd") as writer:
                    for batch in reader:
                        writer.write_batch(batch)
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


@contextmanager
def engines(identity):
    binary = find_stockfish()
    settings = identity["settings"]
    if not binary or fingerprint(binary) != settings["binary_sha256"]:
        raise ValueError("The pilot and label run require the recorded v1 Stockfish binary")
    with ExitStack() as stack:
        pool = stack.enter_context(ThreadPoolExecutor(WORKERS))
        ready = [stack.enter_context(chess.engine.SimpleEngine.popen_uci(binary, timeout=ENGINE_TIMEOUT))
                 for _ in range(WORKERS)]
        for engine in ready:
            engine.configure({"Threads": settings["threads"], "Hash": settings["hash_mb"],
                              "UCI_ShowWDL": settings["wdl"]})
            engine.ping()
        yield pool, ready, settings


def score_lines(lines, board, played, settings):
    def as_cp(value):
        return value.score() if not value.is_mate() else (3000 if value.mate() > 0 else -3000)

    first = lines[0]
    score = first["score"].white()
    wdl = first["wdl"].white()
    pv = [move.uci() for move in first["pv"][:settings["pv_moves"]]]
    row = {"cp": score.score(), "mate": score.mate(), "best_uci": pv[0],
           "pv": " ".join(pv), "wdl_w": wdl.wins, "wdl_d": wdl.draws, "wdl_l": wdl.losses,
           "depth": first["depth"], "nodes": first["nodes"], "found": played == pv[0]}
    if len(lines) >= 2:
        second = lines[1]["score"].white()
        sign = 1 if board.turn == chess.WHITE else -1
        row.update(second_cp=second.score(), second_mate=second.mate(),
                   second_uci=lines[1]["pv"][0].uci(), gap=win_pct(sign * as_cp(score)) - win_pct(sign * as_cp(second)))
    return row


def search_rows(engine, settings, rows, deadline):
    result = []
    depth = chess.engine.Limit(depth=settings["depth"])
    for row in rows:
        if time.monotonic() + 2 * ENGINE_TIMEOUT >= deadline:
            raise TimeoutError("The engine time budget for this batch is exhausted")
        board = chess.Board(row["fen"])
        lines = engine.analyse(board, depth, multipv=settings["multipv"], game=object())
        result.append(score_lines(lines, board, row["move_uci"], settings))
    return result


def search_batch(workers, rows, deadline):
    pool, ready, settings = workers
    tasks = [pool.submit(search_rows, engine, settings, rows[i::WORKERS], deadline)
             for i, engine in enumerate(ready)]
    results = [task.result() for task in tasks]
    interleaved = [results[i % WORKERS][i // WORKERS] for i in range(len(rows))]
    return pa.Table.from_pylist(interleaved, schema=SCORES)


def benchmark(identity):
    report = OUT / "benchmark.json"
    if report.exists():
        previous = json.loads(report.read_text())
        if previous["identity"] != identity:
            raise ValueError("The existing benchmark has different inputs or engine settings")
        return previous
    sizes = populations()
    counts = dict.fromkeys(sizes, BENCH_PER_SPEED)
    sample = OUT / "benchmark-sample.parquet"
    write_sample(sample, counts, sizes, "stockfish-benchmark-v1")
    rows = pq.read_table(sample).to_pylist()
    started = time.monotonic()
    with engines(identity) as workers:
        uptime = time.monotonic() - started
        started = time.monotonic()
        result = search_batch(workers, rows, started + ENGINE_SECONDS).to_pylist()
        seconds = time.monotonic() - started
    critical = dict.fromkeys(sizes, 0)
    for row, score in zip(rows, result, strict=True):
        if (score["gap"] is not None and score["gap"] >= CRITICAL_GAP and row["ply"] >= 2
                and row["pregame_rating"] is not None and row["player"] is not None):
            critical[row["time_class"]] += 1
    value = {"identity": identity, "searches": len(rows), "seconds": seconds,
             "searches_per_second": len(rows) / seconds, "startup_seconds": uptime,
             "searched_by_speed": counts, "critical_by_speed": critical}
    write_json(report, value)
    return value


def make_plan(probe):
    sizes = populations()
    rate = probe["searches_per_second"]
    initial = probe["seconds"]
    previous = OUT / "previous-engine.json"
    if previous.exists():
        prior = json.loads(previous.read_text())
        if prior["identity"] != probe["identity"]:
            raise ValueError("The previous engine time belongs to different run inputs")
        initial = prior["charged_seconds"]
    yields = {}
    for speed in sizes:
        n = probe["searched_by_speed"][speed]
        p = probe["critical_by_speed"][speed] / n
        # Use the lower 95% Wilson bound so the planned sample can absorb yield uncertainty.
        z = 1.96
        lower = (p + z*z/(2*n) - z*math.sqrt((p*(1-p) + z*z/(4*n))/n)) / (1 + z*z/n)
        yields[speed] = lower

    def allocation(target):
        return {speed: min(size, math.ceil(target / yields[speed])) if yields[speed] > 0 else size
                for speed, size in sizes.items()}

    affordable = math.floor((ENGINE_SECONDS - initial) * rate / SAFETY_FACTOR)
    if sum(allocation(1).values()) > affordable:
        raise ValueError("The engine budget cannot cover every speed")
    lo, hi = 1, ROW_TARGET
    while lo < hi:
        middle = (lo + hi + 1) // 2
        if sum(allocation(middle).values()) <= affordable:
            lo = middle
        else:
            hi = middle - 1
    counts = allocation(lo)
    return {"identity": probe["identity"], "benchmark_seconds": probe["seconds"],
            "initial_engine_seconds": initial,
            "searches_per_second": rate, "population_by_speed": sizes, "searches_by_speed": counts,
            "row_target_per_speed": lo, "requested_rows_per_speed": ROW_TARGET,
            "engine_budget_seconds": ENGINE_SECONDS,
            "projected_engine_seconds": initial + sum(counts.values()) / rate * SAFETY_FACTOR,
            "shard_rows": SHARD_ROWS, "sample_salt": "stockfish-labels-v1"}


def read_run(plan):
    manifest = OUT / "runs.json"
    if manifest.exists():
        run = json.loads(manifest.read_text())
        if run["plan"] != plan:
            raise ValueError("The resume plan differs from the original run")
        if run["inflight"] is not None:
            # The previous process may have used its entire reservation before exiting.
            run["spent_seconds"] += run["inflight"]
            run["inflight"] = None
            write_json(manifest, run)
        return run
    run = {"plan": plan, "sample_sha256": None, "inflight": None, "spent_seconds": plan["initial_engine_seconds"]}
    write_json(manifest, run)
    return run


def sample_file(run):
    path = OUT / "sample.parquet"
    plan = run["plan"]
    if run["sample_sha256"] is None and not path.exists():
        write_sample(path, plan["searches_by_speed"], plan["population_by_speed"], plan["sample_salt"])
    checksum = fingerprint(path)
    if run["sample_sha256"] is not None and run["sample_sha256"] != checksum:
        raise ValueError("The saved move sample changed since the run began")
    sample = pq.ParquetFile(path)
    if sample.metadata.num_rows != sum(plan["searches_by_speed"].values()):
        raise ValueError("The saved move sample has the wrong row count")
    run["sample_sha256"] = checksum
    write_json(OUT / "runs.json", run)
    return sample


def write_shard(path, sample, scores, run_id):
    table = pa.Table.from_arrays(sample.columns + scores.columns, names=sample.schema.names + scores.schema.names)
    table = table.append_column("run_id", pa.array([run_id] * len(table)))
    partial = path.with_suffix(".parquet.tmp")
    try:
        with BudgetedWriter(partial.open("wb", buffering=0), available_bytes()) as sink:
            pq.write_table(table, sink, compression="zstd")
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


def label(probe):
    plan = make_plan(probe)
    run = read_run(plan)
    print(json.dumps({"projection": plan, "data_bytes_before": data_bytes()}), flush=True)
    source = sample_file(run)
    folder = OUT / "positions"
    folder.mkdir(exist_ok=True)
    remaining = []
    for i in range(source.num_row_groups):
        part = folder / f"part-{i:05}.parquet"
        if part.exists():
            if pq.read_metadata(part).num_rows != source.metadata.row_group(i).num_rows:
                raise ValueError(f"The completed shard {part.name} has the wrong row count")
        else:
            remaining.append((i, part))
    manifest = OUT / "runs.json"
    if remaining:
        with engines(plan["identity"]) as workers:
            for i, part in remaining:
                sample = source.read_row_group(i)
                rows = sample.to_pylist()
                reserve = min(ENGINE_SECONDS - run["spent_seconds"], 180.0)
                if reserve <= 2 * ENGINE_TIMEOUT:
                    raise TimeoutError("There is too little engine time left for another shard")
                run["inflight"] = reserve
                write_json(manifest, run)
                started = time.monotonic()
                scores = search_batch(workers, rows, started + reserve)
                run["spent_seconds"] += time.monotonic() - started
                write_shard(part, sample, scores, run["sample_sha256"][:12])
                run["inflight"] = None
                write_json(manifest, run)
                if (i + 1) % 10 == 0 or i + 1 == source.num_row_groups:
                    print(f"Published shard {i + 1}/{source.num_row_groups} after {run['spent_seconds']:.1f} engine seconds",
                          flush=True)
    return run


def comparison_markdown(rows):
    lines = ["# Lichess label comparison", "",
             "| Group | Stockfish rows | Stockfish find rate | Cloud rows | Cloud find rate |",
             "|---|---:|---:|---:|---:|"]
    groups = {}
    for row in rows:
        if row["grouping_mask"] == 0:
            continue
        key = row["phase"] or row["time_class"] or "All"
        if row["grouping_mask"] == 6:
            band = row["rating_band"]
            key = f"Rating {band}-{band + 199}" if band is not None else "Unknown rating"
        order = {7: 0, 3: 1, 5: 2, 6: 3}[row["grouping_mask"]]
        groups.setdefault((order, key), {})[row["label_source"]] = row
    for (_, key), values in sorted(groups.items(), key=lambda item: item[0][0]):
        fields = []
        for source in ("stockfish", "cloud"):
            row = values.get(source)
            fields += [f"{row['rows']:,}", f"{row['find_rate']:.2%}"] if row else ["0", "n/a"]
        lines.append(f"| {key} | {' | '.join(fields)} |")
    return "\n".join(lines) + "\n"


def compare(run):
    if run["inflight"] is not None or run["sample_sha256"] is None:
        raise ValueError("Finish the Stockfish shards before comparing training rows")
    source = pq.ParquetFile(OUT / "sample.parquet")
    shards = [str(OUT / "positions" / f"part-{i:05}.parquet") for i in range(source.num_row_groups)]
    expected = sum(run["plan"]["searches_by_speed"].values())
    primary = OUT / "training.parquet"
    partial = primary.with_suffix(".parquet.tmp")
    budget = available_bytes()
    try:
        with duckdb.connect() as con:
            con.execute("SET memory_limit = '8GB'; SET threads = 8; SET max_temp_directory_size = '0B'")
            con.register("engine_shards", con.read_parquet(shards))
            (searched, matching), = con.execute(
                "SELECT count(*), count(*) FILTER (WHERE run_id = ?) FROM engine_shards",
                [run["sample_sha256"][:12]],
            ).fetchall()
            if searched != expected or matching != expected:
                raise ValueError("The Stockfish shards do not match the completed sampling plan")
            relation = con.sql(f"""
                SELECT *, 'stockfish_19' AS evaluation_source FROM engine_shards
                WHERE gap >= {CRITICAL_GAP} AND ply >= 2 AND pregame_rating IS NOT NULL AND player IS NOT NULL
            """)
            with record_batches(relation) as reader, BudgetedWriter(partial.open("wb", buffering=0), budget) as sink:
                with pq.ParquetWriter(sink, reader.schema, compression="zstd") as writer:
                    for batch in reader:
                        writer.write_batch(batch)
            cloud = _literal(str(CLOUD / "training.parquet"))
            combined = _literal(str(partial))
            rows = query_rows(con, f"""
                WITH labels AS (
                    SELECT 'stockfish' AS label_source, phase, time_class, rating_band, found
                    FROM read_parquet({combined})
                    UNION ALL
                    SELECT 'cloud' AS label_source, phase, time_class, rating_band, found
                    FROM read_parquet({cloud})
                )
                SELECT label_source, phase, time_class, rating_band,
                       grouping(phase, time_class, rating_band) AS grouping_mask,
                       count(*) AS rows, count(*) FILTER (WHERE found) AS found,
                       avg(found::INT) AS find_rate
                FROM labels
                GROUP BY GROUPING SETS ((label_source), (label_source, phase), (label_source, time_class),
                                        (label_source, rating_band), (label_source, phase, time_class, rating_band))
                ORDER BY grouping_mask DESC, phase, time_class, rating_band, label_source
            """)
        partial.replace(primary)
    finally:
        partial.unlink(missing_ok=True)
    report = {"engine_seconds": run["spent_seconds"], "searches_by_speed": run["plan"]["searches_by_speed"],
              "training_bytes": primary.stat().st_size, "data_bytes": data_bytes(), "rows": rows}
    write_json(OUT / "comparison.json", report)
    markdown = OUT / "comparison.md"
    temporary = markdown.with_suffix(".md.tmp")
    temporary.write_text(comparison_markdown(rows))
    temporary.replace(markdown)
    print(json.dumps({"training": str(primary), "report": str(markdown),
                      "totals": [row for row in rows if row["grouping_mask"] == 7]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["benchmark", "label", "compare"])
    args = parser.parse_args()
    with (LICHESS / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        OUT.mkdir(parents=True, exist_ok=True)
        if args.action == "compare":
            compare(json.loads((OUT / "runs.json").read_text()))
        else:
            probe = benchmark(source_settings())
            print(json.dumps({"benchmark": probe}, sort_keys=True), flush=True)
            if args.action == "label":
                run = label(probe)
                print(json.dumps({"completed_engine_seconds": run["spent_seconds"]}), flush=True)


if __name__ == "__main__":
    main()
