#!/usr/bin/env python3
"""Download the Lichess CC0 puzzle database and build a compact bundled puzzle index."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

import duckdb
import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from chesscheck.tactics import REPORTED

PUZZLE_HOST = "database.lichess.org"
PUZZLE_FILE = "lichess_db_puzzle.csv.zst"
PUZZLE_URL = f"https://{PUZZLE_HOST}/{PUZZLE_FILE}"
DEFAULT_DATA_DIR = ROOT / "data" / "lichess" / "puzzles"
DEFAULT_INDEX = ROOT / "web" / "src" / "browser" / "patternPuzzlesIndex.json"
HEADERS = {"User-Agent": "chess-research-client/1.0"}

# Fixed Lichess puzzle rating bands (puzzle ratings are on Lichess's puzzle scale, not game ratings).
BANDS = ((1200, 1399), (1400, 1599), (1600, 1799))
PER_BAND = 50
MIN_POPULARITY = 90
MIN_PLAYS = 1000
MAX_INDEX_BYTES = 150_000


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def download_puzzles(dest: Path, *, force: bool = False) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and not force:
        return dest
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    try:
        with requests.get(PUZZLE_URL, headers=HEADERS, stream=True, timeout=120) as resp:
            resp.raise_for_status()
            with tmp.open("wb") as out:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    if chunk:
                        out.write(chunk)
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)
    return dest


def theme_predicate(motif: str) -> str:
    """Match scripts/eval_tactics.py truth(): exact theme name, or mate/mateIn* for mate."""
    if motif == "mate":
        return "len(list_filter(theme_list, lambda t: t = 'mate' OR starts_with(t, 'mateIn'))) > 0"
    return f"list_contains(theme_list, '{motif}')"


def build_index(source_path: Path, index_path: Path, per_band: int = PER_BAND) -> dict:
    path_lit = "'" + str(source_path).replace("'", "''") + "'"
    with duckdb.connect() as con:
        con.execute("SET threads = 4")
        compression = "zstd" if source_path.suffix == ".zst" else "none"
        con.execute(f"""
            CREATE TEMP TABLE puzzles AS
            SELECT PuzzleId AS id,
                   CAST(Rating AS INTEGER) AS rating,
                   CAST(Popularity AS INTEGER) AS popularity,
                   CAST(NbPlays AS INTEGER) AS plays,
                   string_split(Themes, ' ') AS theme_list
            FROM read_csv({path_lit}, header=true, auto_detect=true, compression='{compression}')
            WHERE Popularity >= {MIN_POPULARITY}
              AND NbPlays >= {MIN_PLAYS}
              AND Rating >= {BANDS[0][0]}
              AND Rating <= {BANDS[-1][1]}
        """)

        motifs_out: dict[str, list[list[list[str | int]]]] = {}
        counts: dict[str, list[int]] = {}
        for motif in REPORTED:
            pred = theme_predicate(motif)
            motif_bands: list[list[list[str | int]]] = []
            band_counts: list[int] = []
            for lo, hi in BANDS:
                rows = con.execute(f"""
                    SELECT id, rating
                    FROM puzzles
                    WHERE rating BETWEEN ? AND ?
                      AND {pred}
                    ORDER BY popularity DESC, plays DESC, id ASC
                    LIMIT ?
                """, [lo, hi, per_band]).fetchall()
                motif_bands.append([[str(pid), int(rating)] for pid, rating in rows])
                band_counts.append(len(rows))
            motifs_out[motif] = motif_bands
            counts[motif] = band_counts

    payload = {
        "source": "Lichess puzzle database (CC0)",
        "bands": [list(b) for b in BANDS],
        "motifs": motifs_out,
    }
    encoded = json.dumps(payload, separators=(",", ":")) + "\n"
    if len(encoded.encode("utf-8")) > MAX_INDEX_BYTES:
        raise ValueError(f"Puzzle index exceeds {MAX_INDEX_BYTES} bytes: {len(encoded.encode('utf-8'))}")
    tmp = index_path.with_suffix(".json.tmp")
    tmp.write_text(encoded, encoding="utf-8")
    tmp.replace(index_path)
    return {"counts": counts, "index_bytes": index_path.stat().st_size}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--per-band", type=int, default=PER_BAND)
    parser.add_argument("--force-download", action="store_true")
    args = parser.parse_args()

    archive = download_puzzles(args.data_dir / PUZZLE_FILE, force=args.force_download)
    summary = build_index(archive, args.index, per_band=args.per_band)
    manifest = {
        "url": PUZZLE_URL,
        "license": "CC0",
        "file": archive.name,
        "bytes": archive.stat().st_size,
        "sha256": sha256_file(archive),
        "built_utc": utc_now(),
        "bands": [list(b) for b in BANDS],
        "per_band": args.per_band,
        "min_popularity": MIN_POPULARITY,
        "min_plays": MIN_PLAYS,
        "index_path": str(args.index.relative_to(ROOT)) if args.index.is_relative_to(ROOT) else str(args.index),
        "index_bytes": summary["index_bytes"],
        "counts": summary["counts"],
    }
    manifest_path = args.data_dir / "manifest.json"
    tmp = manifest_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(manifest_path)
    print(json.dumps(manifest, indent=2), flush=True)


if __name__ == "__main__":
    main()
