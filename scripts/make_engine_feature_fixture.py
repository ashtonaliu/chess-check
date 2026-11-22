#!/usr/bin/env python3
"""Build engine-core/tests/fixtures/find_rate_features.json from Python's reference functions.

Calls `move_features` from `scripts/eval_find_rate.py` and `encode_board` from
`chesscheck/neural_find_rate.py` on at least 10,000 positions with moves, starting from
`tests/fixtures/engine-v1/positions/*.parquet` and topping up from `web/test/fixtures/`
when the checked-in Parquet shards have fewer than `--limit` unique positions.

Board encodings are stored as 21 * 8 = 168 little-endian packed bitboard bytes in base64
(bit `sq` of plane `p` matches `encode_board(fen, uci)[p, sq // 8, sq % 8]`).
"""
from __future__ import annotations

import argparse
import base64
import glob
import io
import json
import sys
from pathlib import Path

import chess
import chess.pgn
import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from chesscheck.neural_find_rate import BOARD_PLANES, encode_board  # noqa: E402
from scripts.eval_find_rate import move_features  # noqa: E402

OUT_PATH = ROOT / "engine-core" / "tests" / "fixtures" / "find_rate_features.json"
DEFAULT_PARQUET_GLOB = "tests/fixtures/engine-v1/positions/*.parquet"
WEB_FIXTURES = ROOT / "web" / "test" / "fixtures"
MAX_BYTES = 5_000_000

FEATURE_NAMES = [
    "piece",
    "is_capture",
    "captured_value",
    "gives_check",
    "is_promotion",
    "is_castle",
    "backward",
    "sideways",
    "was_attacked",
    "lands_attacked",
    "in_check",
    "legal_moves",
    "captures_available",
    "checks_available",
    "material_balance",
    "non_pawn_material",
]

# Synthetic edge cases covering pinned-piece attacks, illegal/legal EP, castling, promotions,
# backward/sideways moves, and landing on a square attacked by a pinned piece.
SYNTHETIC_CASES = [
    ("r3k2r/8/8/8/3pP3/8/8/R3K2R b KQkq e3 0 1", "d4e3"),
    ("r3k2r/8/8/8/3pP3/8/8/R3K2R b KQkq e3 0 1", "e8g8"),
    ("r3k2r/8/8/8/3pP3/8/8/R3K2R b KQkq e3 0 1", "e8c8"),
    ("4r2k/8/8/3pP3/8/8/8/4K3 w - d6 0 1", "e1d1"),
    ("3r3k/4P3/8/8/8/8/8/4K3 w - - 0 1", "e7d8q"),
    ("3r3k/4P3/8/8/8/8/8/4K3 w - - 0 1", "e7e8n"),
    ("4k3/8/8/8/8/4r3/4N3/4K3 w - - 0 1", "e1f1"),
]


def pack_board(planes: np.ndarray) -> str:
    if planes.shape != (BOARD_PLANES, 8, 8):
        raise ValueError(f"Unexpected board shape: {planes.shape}")
    flat = planes.reshape(BOARD_PLANES, 64)
    if not np.all((flat == 0.0) | (flat == 1.0)):
        raise ValueError("Board encoding contains non-binary values")
    packed = np.packbits(flat.astype(np.uint8), axis=1, bitorder="little")
    return base64.b64encode(packed.tobytes()).decode("ascii")


def collect_positions(parquet_glob: str, limit: int) -> tuple[list[tuple[str, str]], dict[str, int]]:
    rows: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    counts: dict[str, int] = {}

    def add(fen: str, uci: str, source: str) -> None:
        if len(rows) >= limit:
            return
        key = (fen, uci)
        if key in seen:
            return
        seen.add(key)
        rows.append(key)
        counts[source] = counts.get(source, 0) + 1

    # 1. All (fen, best_uci) pairs from the Parquet shards.
    parquet_files = sorted(glob.glob(str(ROOT / parquet_glob)))
    for path in parquet_files:
        table = pq.read_table(path, columns=["fen", "best_uci"]).to_pydict()
        for fen, best in zip(table["fen"], table["best_uci"]):
            if fen and best:
                add(fen, best, parquet_glob)

    # 2. Synthetic edge cases so rare board/feature combinations are always exercised.
    for fen, uci in SYNTHETIC_CASES:
        add(fen, uci, "synthetic")

    if len(rows) >= limit:
        return rows[:limit], counts

    # 3. Top up from checked-in web/test/fixtures when the Parquet shards have < limit positions.
    find_rate = json.loads((WEB_FIXTURES / "find_rate.json").read_text())
    for item in find_rate:
        add(item["fen"], item["best"], "web/test/fixtures/find_rate.json")

    def add_pgn_moves(pgn_text: str, source: str) -> None:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
        if not game:
            return
        board = game.board()
        for mv in game.mainline_moves():
            add(board.fen(), mv.uci(), source)
            board.push(mv)

    for name in (
        "archive_promo.json",
        "archive_promo_capture.json",
        "archive_187138001290.json",
    ):
        arch = json.loads((WEB_FIXTURES / name).read_text())
        if arch.get("pgn"):
            add_pgn_moves(arch["pgn"], f"web/test/fixtures/{name}")

    tactics = json.loads((WEB_FIXTURES / "tactics.json").read_text())
    for item in tactics.get("positions", []):
        fen = item.get("fen")
        mv = item.get("best") or item.get("move") or item.get("uci")
        if fen and mv:
            board = chess.Board(fen)
            try:
                parsed = board.parse_uci(mv)
            except ValueError:
                parsed = board.parse_san(mv)
            add(fen, parsed.uci(), "web/test/fixtures/tactics.json")

    def add_san_game(moves: list[str], source: str) -> None:
        board = chess.Board()
        for san in moves:
            mv = board.parse_san(san)
            add(board.fen(), mv.uci(), source)
            board.push(mv)

    for name, data in (
        ("tactics.json", tactics),
        ("parity.json", json.loads((WEB_FIXTURES / "parity.json").read_text())),
        ("model.json", json.loads((WEB_FIXTURES / "model.json").read_text())),
    ):
        for game in data.get("games", []):
            if len(rows) >= limit:
                break
            add_san_game(game.get("moves", []), f"web/test/fixtures/{name}")

    if len(rows) < limit:
        raise RuntimeError(f"Only collected {len(rows)} positions, need at least {limit}")
    return rows[:limit], counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parquet-glob", default=DEFAULT_PARQUET_GLOB)
    parser.add_argument("--limit", type=int, default=10_000)
    parser.add_argument("--output", type=Path, default=OUT_PATH)
    args = parser.parse_args()
    if args.limit < 10_000:
        raise ValueError(f"--limit must be at least 10000, got {args.limit}")

    selected, source_counts = collect_positions(args.parquet_glob, args.limit)
    encoded_rows = []
    for fen, uci in selected:
        feats = move_features(fen, uci)
        feat_vec = [int(feats[name]) for name in FEATURE_NAMES]
        board_b64 = pack_board(encode_board(fen, uci))
        encoded_rows.append([fen, uci, feat_vec, board_b64])

    payload = {
        "feature_names": FEATURE_NAMES,
        "board_planes": BOARD_PLANES,
        "bitorder": "little",
        "position_count": len(encoded_rows),
        "source_counts": source_counts,
        "positions": encoded_rows,
    }
    raw = json.dumps(payload, separators=(",", ":"))
    size = len(raw.encode("utf-8"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(raw, encoding="utf-8")
    print(
        f"Wrote {args.output}: {len(encoded_rows)} positions, "
        f"{size / (1024 * 1024):.2f} MB ({size} bytes), sources={source_counts}"
    )
    if size >= MAX_BYTES:
        raise RuntimeError(f"Fixture exceeds 5 MB limit ({size} bytes >= {MAX_BYTES})")


if __name__ == "__main__":
    main()
