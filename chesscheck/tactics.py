"""Tactic and piece analysis of blunders.

For each blunder (a move losing >= 20 win%), two moves are classified:
  allowed - the opponent's best reply after the blunder (what you walked into)
  missed  - the engine's best move before the blunder (what you should have played)

A move is tagged with tactic motifs by looking at the board geometry around
it: fork, pin, skewer, discovered attack, hanging piece, mate, back-rank
mate, promotion. Blunders are also counted by the piece moved and the piece
lost. Everything is compared with the opponents' rates in the same games.

The detector is validated against Lichess puzzle themes (scripts/eval_tactics.py).
"""
from __future__ import annotations

import io
import math
from collections import Counter

import chess
import chess.pgn

from .engine import BLUNDER_DROP, MATE_CP

VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}
PIECE_NAME = {chess.PAWN: "pawn", chess.KNIGHT: "knight", chess.BISHOP: "bishop",
              chess.ROOK: "rook", chess.QUEEN: "queen", chess.KING: "king"}
MOTIFS = ["mate", "backRankMate", "fork", "pin", "skewer", "discoveredAttack", "hangingPiece", "promotion"]
# What the app reports. Pin and back-rank mate are detected but left out: on Lichess
# puzzles their first-move precision was 0.49 and 0.27 (scripts/eval_tactics.py).
# Mate comes from the engine score instead of the board, because a blunder that
# allows mate in 3 is not followed by mate on the next move.
REPORTED = ["mate", "fork", "skewer", "discoveredAttack", "hangingPiece", "promotion"]
MOTIF_LABEL = {"mate": "checkmate", "backRankMate": "back-rank mate", "fork": "fork", "pin": "pin",
               "skewer": "skewer", "discoveredAttack": "discovered attack", "hangingPiece": "hanging piece",
               "promotion": "pawn promotion"}
PUZZLE_URL = {m: f"https://lichess.org/training/{m}" for m in MOTIFS}
PUZZLE_URL["mate"] = "https://lichess.org/training/mate"
SLIDERS = (chess.BISHOP, chess.ROOK, chess.QUEEN)


def _defended(board: chess.Board, square: int, color: bool) -> bool:
    """Is the piece on `square` (owned by `color`) protected by another piece of its own side?"""
    return bool(board.attackers(color, square))


def _in_bad_spot(board: chess.Board, sq: int) -> bool:
    """The piece on `sq` can be taken: attacked and undefended, or attacked by something cheaper."""
    piece = board.piece_at(sq)
    attackers = board.attackers(not piece.color, sq)
    if not attackers:
        return False
    if not _defended(board, sq, piece.color):
        return True
    return any(VALUE[board.piece_at(a).piece_type] < VALUE[piece.piece_type] for a in attackers)


def _valuable_targets(board: chess.Board, attacker_sq: int, attacker_color: bool) -> list[int]:
    """Enemy pieces (not pawns) attacked from attacker_sq that are worth attacking: the king,
    anything more valuable than the attacker, or anything undefended."""
    piece = board.piece_at(attacker_sq)
    out = []
    for sq in board.attacks(attacker_sq):
        t = board.piece_at(sq)
        if not t or t.color == attacker_color or t.piece_type == chess.PAWN:
            continue
        if (t.piece_type == chess.KING or VALUE[t.piece_type] > VALUE[piece.piece_type]
                or not _defended(board, sq, t.color)):
            out.append(sq)
    return out


def _line_motifs(board: chess.Board, sq: int, color: bool) -> set[str]:
    """Pin or skewer created by the slider on `sq`: two enemy pieces on one line behind each other."""
    piece = board.piece_at(sq)
    if not piece or piece.piece_type not in SLIDERS:
        return set()
    dirs = []
    if piece.piece_type in (chess.ROOK, chess.QUEEN):
        dirs += [(0, 1), (0, -1), (1, 0), (-1, 0)]
    if piece.piece_type in (chess.BISHOP, chess.QUEEN):
        dirs += [(1, 1), (1, -1), (-1, 1), (-1, -1)]
    found = set()
    f0, r0 = chess.square_file(sq), chess.square_rank(sq)
    for df, dr in dirs:
        hits = []
        f, r = f0 + df, r0 + dr
        while 0 <= f < 8 and 0 <= r < 8 and len(hits) < 2:
            here = chess.square(f, r)
            p = board.piece_at(here)
            if p:
                if p.color == color:
                    break
                hits.append((p, here))
            f, r = f + df, r + dr
        if len(hits) == 2:
            (front, front_sq), (back, back_sq) = hits
            # pin: a real piece stuck in front of the king or queen
            if (back.piece_type in (chess.KING, chess.QUEEN) and front.piece_type != chess.PAWN
                    and VALUE[back.piece_type] > VALUE[front.piece_type]):
                found.add("pin")
            # skewer: king or queen in front, something worth winning behind it
            elif (front.piece_type in (chess.KING, chess.QUEEN) and back.piece_type != chess.PAWN
                  and VALUE[front.piece_type] > VALUE[back.piece_type]
                  and (VALUE[back.piece_type] > VALUE[piece.piece_type]
                       or not _defended(board, back_sq, back.color))):
                found.add("skewer")
    return found


def motifs(board: chess.Board, move: chess.Move) -> set[str]:
    """Tactic motifs of `move` (played by the side to move on `board`). Does not modify `board`."""
    color = board.turn
    out: set[str] = set()
    mover = board.piece_at(move.from_square)
    if mover is None:
        return out
    captured = board.piece_at(move.to_square)
    if board.is_en_passant(move):
        captured = chess.Piece(chess.PAWN, not color)
    # hanging piece: winning a piece that nothing defends (and not just trading for it)
    if (captured and captured.piece_type != chess.PAWN and not _defended(board, move.to_square, not color)
            and VALUE[captured.piece_type] >= 3):
        out.add("hangingPiece")
    if move.promotion:
        out.add("promotion")
    # attacks by other sliders before the move, for discovered attacks
    before = {s: set(board.attacks(s)) for s in board.pieces(chess.BISHOP, color) |
              board.pieces(chess.ROOK, color) | board.pieces(chess.QUEEN, color) if s != move.from_square}
    after = board.copy(stack=False)
    after.push(move)
    if after.is_checkmate():
        out.add("mate")
        king = after.king(not color)
        back_rank = 0 if (not color) == chess.WHITE else 7   # the mated side's home rank
        piece = after.piece_at(move.to_square)
        if (king is not None and chess.square_rank(king) == back_rank and piece
                and piece.piece_type in (chess.ROOK, chess.QUEEN)
                and chess.square_rank(move.to_square) == back_rank):
            # the king is boxed in by its own pieces on the rank in front of it
            step = 1 if back_rank == 0 else -1
            kf = chess.square_file(king)
            front = [chess.square(f, back_rank + step) for f in (kf - 1, kf, kf + 1) if 0 <= f < 8]
            own = [sq for sq in front if (q := after.piece_at(sq)) and q.color == (not color)]
            if len(own) >= 2:
                out.add("backRankMate")
        return out
    safe = not _in_bad_spot(after, move.to_square)
    # fork: the moved piece attacks two or more worthwhile targets and can't simply be taken
    if mover.piece_type != chess.KING and safe and len(_valuable_targets(after, move.to_square, color)) >= 2:
        out.add("fork")
    if safe:
        out |= _line_motifs(after, move.to_square, color)
    # discovered attack: moving a piece opens a line from another piece onto a real target
    for s, prev in before.items():
        slider = after.piece_at(s)
        if slider is None:
            continue
        for t in set(after.attacks(s)) - prev:
            p = after.piece_at(t)
            if (p and p.color != color and p.piece_type != chess.PAWN
                    and (p.piece_type == chess.KING or VALUE[p.piece_type] > VALUE[slider.piece_type]
                         or not _defended(after, t, p.color))):
                out.add("discoveredAttack")
                break
    return out


def _san_move(board: chess.Board, san: str | None) -> chess.Move | None:
    if not san:
        return None
    try:
        return board.parse_san(san)
    except ValueError:
        return None


def _geometric(board: chess.Board, move: chess.Move) -> list[str]:
    return [m for m in REPORTED if m != "mate" and m in motifs(board, move)]


def classify_game(pgn: str, analysis: dict) -> list[dict]:
    """One record per blunder (both players): motifs allowed and missed, piece moved and lost.
    Uses the deep re-check (engine.recheck_blunders) when present: a blunder that is not
    confirmed at the deeper depth is dropped."""
    game = chess.pgn.read_game(io.StringIO(pgn))
    board = game.board()
    rows = analysis["moves"]
    out = []
    for i, mv in enumerate(game.mainline_moves()):
        row = rows[i] if i < len(rows) else None
        loss = row.get("deep_loss", row["wp_loss"]) if row else 0
        if row and row["wp_loss"] >= BLUNDER_DROP and loss >= BLUNDER_DROP:
            moved = board.piece_at(mv.from_square)
            rec = {"url": analysis["url"], "ply": row["ply"], "move_no": row["move_no"], "san": row["san"],
                   "is_me": row["is_me"], "phase": row["phase"], "wp_loss": loss,
                   "piece": PIECE_NAME[moved.piece_type] if moved else None,
                   "allowed": [], "missed": [], "lost": None, "refutation": None, "best": row.get("best"),
                   "fen": board.fen()}
            best = _san_move(board, row.get("deep_best", row.get("best")))
            rec["best"] = board.san(best) if best else None
            if best and best != mv:
                rec["missed"] = _geometric(board, best)
                if row.get("deep_cp_before", row["cp_before"]) >= MATE_CP:
                    rec["missed"] = ["mate"] + rec["missed"]
            after = board.copy(stack=False)
            after.push(mv)
            nxt = rows[i + 1] if i + 1 < len(rows) else None
            refute = _san_move(after, row.get("deep_refutation") or (nxt.get("best") if nxt else None))
            if row.get("deep_cp_after", row["cp_after"]) <= -MATE_CP:
                rec["allowed"].append("mate")
            if refute:
                rec["refutation"] = after.san(refute)
                rec["allowed"] += _geometric(after, refute)
                cap = after.piece_at(refute.to_square)
                if cap and cap.color == board.turn:
                    rec["lost"] = PIECE_NAME[cap.piece_type]
                fork_piece = after.piece_at(refute.from_square)
                if "fork" in rec["allowed"] and fork_piece:
                    rec["fork_by"] = PIECE_NAME[fork_piece.piece_type]
            if "fork" in rec["missed"] and best:
                fp = board.piece_at(best.from_square)
                rec["missed_fork_by"] = PIECE_NAME[fp.piece_type] if fp else None
            out.append(rec)
        board.push(mv)
    return out


def ratio_interval(a: int, n_a: int, b: int, n_b: int, z: float = 1.645) -> tuple[float, float, float]:
    """Rate ratio (a/n_a) / (b/n_b) with a 90% interval, by a Wilson interval on a's share of the
    events conditioned on the total (a + b), adjusted for exposure."""
    if n_a == 0 or n_b == 0 or a + b == 0:
        return float("nan"), float("nan"), float("nan")
    t = a + b
    p = a / t
    denom = 1 + z * z / t
    centre = (p + z * z / (2 * t)) / denom
    half = z * math.sqrt(p * (1 - p) / t + z * z / (4 * t * t)) / denom
    lo_p, hi_p = max(centre - half, 0.0), min(centre + half, 1.0)
    expo = n_b / n_a

    def to_ratio(q):
        return float("inf") if q >= 1 else q / (1 - q) * expo

    return (a / n_a) / (b / n_b) if b else float("inf"), to_ratio(lo_p), to_ratio(hi_p)


Z90 = 1.645


def _z_family(n_tests: int, alpha: float = 0.10) -> float:
    """Two-sided z for a Bonferroni-corrected family of n_tests at overall level alpha."""
    from scipy.stats import norm
    return float(norm.ppf(1 - alpha / (2 * max(n_tests, 1))))


def verdict(a: int, n_a: int, b: int, n_b: int, z_family: float) -> str:
    """"pattern" if the rate ratio differs from 1 even after correcting for every comparison
    made; "worth watching" if it only passes the plain 90% interval."""
    _, lo, hi = ratio_interval(a, n_a, b, n_b, z_family)
    if lo > 1 or hi < 1:
        return "pattern"
    _, lo, hi = ratio_interval(a, n_a, b, n_b, Z90)
    if lo > 1 or hi < 1:
        return "worth watching"
    return "no difference"


def summarize(analyses: list[dict], pgns: dict[str, str], deep_depth: int = 16) -> dict:
    """Counts and rates for the user vs their opponents."""
    recs = [r for a in analyses for r in classify_game(pgns[a["url"]], a)]
    moves_me = sum(1 for a in analyses for m in a["moves"] if m["is_me"])
    moves_opp = sum(1 for a in analyses for m in a["moves"] if not m["is_me"])
    pieces_me = Counter(PIECE_NAME[_piece_of(m)] for a in analyses for m in a["moves"] if m["is_me"] and _piece_of(m))
    pieces_opp = Counter(PIECE_NAME[_piece_of(m)] for a in analyses for m in a["moves"] if not m["is_me"] and _piece_of(m))
    out = {"games": len(analyses), "moves_me": moves_me, "moves_opp": moves_opp, "motifs": [], "pieces": [],
           "examples": {}}
    for kind in ("allowed", "missed"):
        for m in REPORTED:
            a = sum(m in r[kind] for r in recs if r["is_me"])
            b = sum(m in r[kind] for r in recs if not r["is_me"])
            if a + b == 0:
                continue
            ratio, lo, hi = ratio_interval(a, moves_me, b, moves_opp)
            out["motifs"].append({"kind": kind, "motif": m, "me": a, "opp": b,
                                  "ratio": ratio, "ci_low": lo, "ci_high": hi})
    for p in ("pawn", "knight", "bishop", "rook", "queen", "king"):
        a = sum(1 for r in recs if r["is_me"] and r["piece"] == p)
        b = sum(1 for r in recs if not r["is_me"] and r["piece"] == p)
        n_a, n_b = pieces_me.get(p, 0), pieces_opp.get(p, 0)
        if n_a == 0:
            continue
        ratio, lo, hi = ratio_interval(a, n_a, b, n_b) if n_b else (float("nan"),) * 3
        out["pieces"].append({"piece": p, "moves": n_a, "blunders": a, "rate": a / n_a,
                              "opp_moves": n_b, "opp_blunders": b, "opp_rate": b / n_b if n_b else float("nan"),
                              "ratio": ratio, "ci_low": lo, "ci_high": hi})
    # one family: every motif comparison plus every piece comparison
    z_fam = _z_family(len(out["motifs"]) + len(out["pieces"]))
    for m in out["motifs"]:
        m["verdict"] = verdict(m["me"], moves_me, m["opp"], moves_opp, z_fam)
        m["higher"] = m["ratio"] > 1
    for p in out["pieces"]:
        p["verdict"] = verdict(p["blunders"], p["moves"], p["opp_blunders"], p["opp_moves"], z_fam) \
            if p["opp_moves"] else "no difference"
    out["n_tests"] = len(out["motifs"]) + len(out["pieces"])
    flagged = sum(m["wp_loss"] >= BLUNDER_DROP for a in analyses for m in a["moves"])
    out["flagged"], out["confirmed"] = flagged, len(recs)
    out["deep"] = any("deep_loss" in m for a in analyses for m in a["moves"])
    out["deep_depth"] = deep_depth
    fork_by = Counter(r.get("fork_by") for r in recs if r["is_me"] and r.get("fork_by"))
    out["forks_allowed_by"] = dict(fork_by)
    out["pieces_lost"] = dict(Counter(r["lost"] for r in recs if r["is_me"] and r["lost"]))
    for r in sorted((r for r in recs if r["is_me"]), key=lambda r: -r["wp_loss"]):
        for kind in ("allowed", "missed"):
            for m in r[kind]:
                out["examples"].setdefault(f"{kind}:{m}", r)
    out["blunders"] = [r for r in recs if r["is_me"]]
    return out


def _piece_of(m: dict) -> int | None:
    """Piece type that made a recorded move, from its SAN."""
    san = m["san"]
    if san.startswith("O-O"):
        return chess.KING
    return {"N": chess.KNIGHT, "B": chess.BISHOP, "R": chess.ROOK, "Q": chess.QUEEN,
            "K": chess.KING}.get(san[0], chess.PAWN)
