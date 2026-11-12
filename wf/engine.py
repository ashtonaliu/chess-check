"""Stockfish analysis plus per-move feature engineering.

Every move of every game (the user's AND the opponent's) becomes one row, so
a single user's history also yields population training data for the
blunder-risk model. Losses are measured in win probability (Lichess's logistic
mapping of centipawns) so +9 -> +6 doesn't count like +1 -> -2.
"""
from __future__ import annotations

import io
import json
import math
import os
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import chess
import chess.engine
import chess.pgn

from .fetch import Game

OPENING_PLIES = 24          # through move 12
BLUNDER_DROP = 20.0         # win% lost in one move
CACHE = Path(os.environ.get("WF_CACHE", ".cache/engine"))
PIECE_VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3,
                chess.ROOK: 5, chess.QUEEN: 9}
CACHE_VERSION = 3


def win_pct(cp: float) -> float:
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def non_pawn_material(board: chess.Board) -> int:
    return sum(PIECE_VALUES[p.piece_type] for p in board.piece_map().values()
               if p.piece_type not in (chess.PAWN, chess.KING))


def phase(board: chess.Board, ply: int) -> str:
    if ply < OPENING_PLIES:
        return "opening"
    return "endgame" if non_pawn_material(board) <= 26 else "middlegame"


def material_balance(board: chess.Board, color: bool) -> int:
    s = 0
    for p in board.piece_map().values():
        if p.piece_type != chess.KING:
            s += PIECE_VALUES[p.piece_type] * (1 if p.color == color else -1)
    return s


def base_seconds(time_control: str) -> float | None:
    if not time_control or "/" in time_control:   # daily games
        return None
    try:
        return float(time_control.split("+")[0])
    except ValueError:
        return None


def find_stockfish() -> str | None:
    return os.environ.get("STOCKFISH_PATH") or shutil.which("stockfish") \
        or next((p for p in ("/usr/games/stockfish", "/opt/homebrew/bin/stockfish")
                 if os.path.exists(p)), None)


_local = threading.local()
_all_engines: list[chess.engine.SimpleEngine] = []
_lock = threading.Lock()


def _engine(path: str) -> chess.engine.SimpleEngine:
    eng = getattr(_local, "engine", None)
    if eng is None:
        eng = chess.engine.SimpleEngine.popen_uci(path)
        eng.configure({"Threads": 1, "Hash": 32})
        _local.engine = eng
        with _lock:
            _all_engines.append(eng)
    return eng


def analyse_game(game: Game, path: str, depth: int = 10) -> dict:
    gid = game.url.rsplit("/", 1)[-1]
    key = CACHE / f"v{CACHE_VERSION}_{gid}_d{depth}.json"
    if key.exists():
        res = json.loads(key.read_text())
    else:
        res = _analyse(game, path, depth)
        CACHE.mkdir(parents=True, exist_ok=True)
        key.write_text(json.dumps(res))
    # the cache is per game; "is_me" depends on whose report this is
    me = game.color
    for m in res["moves"]:
        m["is_me"] = m["mover"] == me
    res["color"] = me
    res["opening_eval"] = (res["opening_eval_white"] if me == "white"
                           else -res["opening_eval_white"]) \
        if res["opening_eval_white"] is not None else None
    return res


def _analyse(game: Game, path: str, depth: int) -> dict:
    eng = _engine(path)
    pg = chess.pgn.read_game(io.StringIO(game.pgn))
    board = pg.board()
    limit = chess.engine.Limit(depth=depth)
    base = base_seconds(getattr(game, "time_control", ""))

    def evaluate(b):  # white POV centipawns + best move
        info = eng.analyse(b, limit)
        cp = info["score"].white().score(mate_score=3000)
        best = b.san(info["pv"][0]) if info.get("pv") else None
        return cp, best

    cp_white, best = evaluate(board)
    last_clock = {chess.WHITE: base, chess.BLACK: base}
    moves, opening_eval = [], None
    node = pg
    ply = 0
    while node.variations:
        node = node.variations[0]
        mv = node.move
        mover = board.turn
        sign = 1 if mover == chess.WHITE else -1
        ph = phase(board, ply)
        feats = {
            "legal_moves": board.legal_moves.count(),
            "in_check": int(board.is_check()),
            "captures_available": sum(1 for m in board.legal_moves
                                      if board.is_capture(m)),
            "material_balance": material_balance(board, mover),
            "non_pawn_material": non_pawn_material(board),
        }
        san = board.san(mv)
        is_capture = int(board.is_capture(mv))
        fen = board.fen()
        clock = node.clock()
        prev = last_clock[mover]
        spent = (prev - clock) if (clock is not None and prev is not None) else None
        last_clock[mover] = clock
        board.push(mv)
        if board.is_checkmate():
            cp_after_white, next_best = 3000 * sign, None
        elif board.is_game_over():
            cp_after_white, next_best = 0, None
        else:
            cp_after_white, next_best = evaluate(board)
        before, after = cp_white * sign, cp_after_white * sign
        drop = win_pct(before) - win_pct(after)
        moves.append({
            "ply": ply, "move_no": ply // 2 + 1, "san": san, "best": best,
            "mover": "white" if mover == chess.WHITE else "black",
            "phase": ph, "fen": fen, "cp_before": before, "cp_after": after,
            "wp_loss": round(max(drop, 0.0), 1),
            "clock": clock, "clock_frac": (clock / base) if (clock is not None and base) else None,
            "time_spent": spent, "is_capture": is_capture, **feats,
        })
        if ply + 1 == OPENING_PLIES:
            opening_eval = cp_after_white
        cp_white, best = cp_after_white, next_best
        ply += 1
    return {"url": game.url, "moves": moves, "opening_eval_white": opening_eval}


def analyse_games(games: list[Game], depth: int = 10, workers: int | None = None,
                  progress=None) -> list[dict]:
    path = find_stockfish()
    if not path:
        raise RuntimeError("Stockfish not found; install it or set STOCKFISH_PATH")
    # WF_ENGINE_WORKERS caps Stockfish processes on small hosts, where
    # os.cpu_count() reports the machine's cores, not the container's share
    workers = workers or int(os.environ.get("WF_ENGINE_WORKERS", 0)) \
        or max(1, (os.cpu_count() or 2) - 1)
    out: list[dict | None] = [None] * len(games)
    try:
        with ThreadPoolExecutor(workers) as pool:
            futs = {pool.submit(analyse_game, g, path, depth): i
                    for i, g in enumerate(games)}
            for done, f in enumerate(as_completed(futs), 1):
                out[futs[f]] = f.result()
                if progress:
                    progress(done, len(games))
    finally:
        with _lock:
            for e in _all_engines:
                try:
                    e.quit()
                except Exception:
                    pass
            _all_engines.clear()
    _local.__dict__.clear()
    return out  # type: ignore[return-value]


def my_moves(analyses: list[dict]):
    for a in analyses:
        for m in a["moves"]:
            if m["is_me"]:
                yield a, m


def phase_summary(analyses: list[dict], mine: bool = True) -> dict:
    """Average win% lost per move, and blunder rate, by phase.

    mine=True: the user's moves; mine=False: their opponents' moves."""
    rows = {p: {"moves": 0, "loss": 0.0, "blunders": 0}
            for p in ("opening", "middlegame", "endgame")}
    sel = ((a, m) for a in analyses for m in a["moves"] if m["is_me"] == mine)
    for _, m in sel:
        r = rows[m["phase"]]
        r["moves"] += 1
        r["loss"] += m["wp_loss"]
        r["blunders"] += m["wp_loss"] >= BLUNDER_DROP
    return {p: {"moves": r["moves"],
                "avg_loss": r["loss"] / r["moves"] if r["moves"] else 0.0,
                "blunder_rate": r["blunders"] / r["moves"] if r["moves"] else 0.0}
            for p, r in rows.items()}


def opening_exit(analyses: list[dict], urls: set[str]) -> dict | None:
    """Average eval after move 12 and win% lost in moves 13-25 for a game set."""
    evals, mid_losses, mid_moves = [], 0.0, 0
    for a in analyses:
        if a["url"] not in urls:
            continue
        if a["opening_eval"] is not None:
            evals.append(a["opening_eval"])
        for m in a["moves"]:
            if m["is_me"] and 12 < m["move_no"] <= 25:
                mid_losses += m["wp_loss"]
                mid_moves += 1
    if not evals:
        return None
    evals.sort()
    mid = len(evals) // 2
    median = evals[mid] if len(evals) % 2 else (evals[mid - 1] + evals[mid]) / 2
    return {"games": len(evals),
            # median: one -7 blowout shouldn't define a whole opening
            "avg_eval_after_12": median,
            "avg_loss_13_25": mid_losses / mid_moves if mid_moves else 0.0}


def worst_blunders(analyses: list[dict], k: int = 5) -> list[dict]:
    allm = [dict(m, url=a["url"]) for a, m in my_moves(analyses)]
    return sorted(allm, key=lambda m: -m["wp_loss"])[:k]
