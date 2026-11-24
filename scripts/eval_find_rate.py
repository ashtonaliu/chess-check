"""How often do players find the only good move? A model for the review queue.

The review queue asks you to find a move you missed. This study asks how often players at a given
rating find the best move in positions where only one move works, and whether anything beyond the
rating predicts it: the clock, how much better the best move is than the second, and what kind of
move it is (a capture, a check, a quiet move, a retreat).

Population: positions from the engine dataset (blitz, Stockfish 19 with the two best moves) where
the best move beats the second best by at least 20 points of win chance for the player to move, so
missing it is a real mistake. Label: the player chose the best move.

    python scripts/eval_find_rate.py build      # the table, cached in data/engine/derived/
    python scripts/eval_find_rate.py evaluate   # baseline and models, scored on held-out players
"""
import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import chess
import duckdb
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chesscheck.dataset import DEFAULT_ROOT, register_views  # noqa: E402

DERIVED = Path(__file__).resolve().parents[1] / "data" / "engine" / "derived"
RAW = DERIVED / "find_rate_raw.parquet"
TABLE = DERIVED / "find_rate.parquet"
GAP = 20.0            # win-chance points between the best and second-best move
SAMPLE_MOD = 3        # keep games whose hash is 0 mod this (about a third)
TEST_MOD = 5          # players whose hash is 0 mod this are held out

VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}


def build_raw() -> None:
    con = duckdb.connect()
    register_views(con, DEFAULT_ROOT)
    con.execute(f"""
        COPY (
        WITH games AS (
            SELECT game_id, run_id, base_seconds, increment_seconds FROM _dataset_games
            WHERE hash(game_id) % {SAMPLE_MOD} = 0 AND time_class = 'blitz'
        ), pos AS (
            SELECT p.game_id, p.run_id, p.ply, p.fen, p.mover, p.move_uci, p.best_uci, p.second_uci,
                   _dataset_score(p.cp, p.mate, p.terminal, p.mover) * (CASE WHEN p.mover = 'white' THEN 1 ELSE -1 END) AS best_cp,
                   _dataset_score(p.second_cp, p.second_mate, NULL, p.mover) * (CASE WHEN p.mover = 'white' THEN 1 ELSE -1 END) AS second_cp,
                   lag(p.clock_after) OVER (PARTITION BY p.game_id, p.run_id, p.mover ORDER BY p.ply) AS clock_before,
                   g.base_seconds, g.increment_seconds
            FROM _dataset_positions p JOIN games g USING (game_id, run_id)
            WHERE p.terminal IS NULL
        )
        SELECT pos.*, pg.player, pg.pregame_rating,
               _dataset_win_pct(best_cp) AS best_wp, _dataset_win_pct(second_cp) AS second_wp
        FROM pos
        JOIN read_parquet('{DERIVED / "player_games.parquet"}') pg
          ON pg.game_id = pos.game_id AND pg.run_id = pos.run_id AND pg.color = pos.mover
        WHERE move_uci IS NOT NULL AND best_uci IS NOT NULL AND second_uci IS NOT NULL
          AND pregame_rating IS NOT NULL AND ply >= 2
          AND _dataset_win_pct(best_cp) - _dataset_win_pct(second_cp) >= {GAP}
        ) TO '{RAW}' (FORMAT parquet)
    """)
    print(con.execute(f"SELECT count(*), count(DISTINCT player) FROM '{RAW}'").fetchall())


def move_features(fen: str, uci: str) -> dict:
    """What kind of move the best move is, from the position alone (computable in the browser)."""
    board = chess.Board(fen)
    if not board.is_valid():
        raise ValueError(f"Invalid position: {fen}")
    move = board.parse_uci(uci)
    piece = board.piece_at(move.from_square)
    captured = board.piece_at(move.to_square)
    if board.is_en_passant(move):
        captured = chess.Piece(chess.PAWN, not board.turn)
    me = board.turn
    forward = (chess.square_rank(move.to_square) - chess.square_rank(move.from_square)) * (1 if me == chess.WHITE else -1)
    attacked_before = board.is_attacked_by(not me, move.from_square)
    gives_check = board.gives_check(move)
    moves = list(board.legal_moves)
    legal = len(moves)
    captures = sum(1 for m in moves if board.is_capture(m))
    checks = sum(1 for m in moves if board.gives_check(m))
    material = 0
    non_pawn = 0
    for p in board.piece_map().values():
        v = VALUE[p.piece_type]
        material += v if p.color == me else -v
        if p.piece_type not in (chess.PAWN, chess.KING):
            non_pawn += v
    after = board.copy(stack=False)
    after.push(move)
    lands_attacked = after.is_attacked_by(not me, move.to_square)
    return {
        "piece": piece.piece_type if piece else 0,
        "is_capture": int(captured is not None),
        "captured_value": VALUE[captured.piece_type] if captured else 0,
        "gives_check": int(gives_check),
        "is_promotion": int(move.promotion is not None),
        "is_castle": int(board.is_castling(move)),
        "backward": int(forward < 0),
        "sideways": int(forward == 0),
        "was_attacked": int(attacked_before),
        "lands_attacked": int(lands_attacked),
        "in_check": int(board.is_check()),
        "legal_moves": legal,
        "captures_available": captures,
        "checks_available": checks,
        "material_balance": material,
        "non_pawn_material": non_pawn,
    }


def _featurize(chunk: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame([move_features(f, u) for f, u in zip(chunk.fen, chunk.best_uci)], index=chunk.index)


def build() -> None:
    DERIVED.mkdir(parents=True, exist_ok=True)
    if not RAW.exists():
        build_raw()
    raw = duckdb.sql(f"SELECT * FROM '{RAW}'").df()
    print(f"{len(raw):,} positions from {raw.player.nunique():,} players")
    step = -(-len(raw) // 64)
    chunks = [raw.iloc[i:i + step] for i in range(0, len(raw), step)]
    with ProcessPoolExecutor() as pool:
        feats = pd.concat(pool.map(_featurize, chunks))
    df = pd.concat([raw, feats], axis=1)
    df["found"] = (df.move_uci == df.best_uci).astype(int)
    df["gap"] = df.best_wp - df.second_wp
    df["clock_frac"] = (df.clock_before / df.base_seconds).clip(0, 1.5)
    df["test"] = (pd.util.hash_pandas_object(df.player, index=False) % TEST_MOD == 0).astype(int)
    out = df.drop(columns=["fen", "move_uci", "second_uci"])  # noqa: F841 (read by name in the SQL below)
    duckdb.sql(f"COPY (SELECT * FROM out) TO '{TABLE}' (FORMAT parquet)")
    print(f"wrote {TABLE} ({len(df):,} rows, {df.test.mean():.1%} test, found {df.found.mean():.1%})")


# ---------- evaluation ----------

def design(df: pd.DataFrame, which: str) -> pd.DataFrame:
    r = (df.pregame_rating - 1500) / 400
    X = pd.DataFrame({"rating": r, "rating2": r ** 2}, index=df.index)
    if which == "rating":
        return X
    clock = df.clock_frac.fillna(df.clock_frac.median())
    X["clock"] = clock
    X["low_clock"] = (clock < 0.1).astype(int)
    X["no_clock"] = df.clock_frac.isna().astype(int)
    if which in ("clock", ):
        return X
    X = pd.concat([X, move_design(df)], axis=1)
    if which == "move":
        return X
    X["gap"] = df.gap / 100
    X["best_wp"] = df.best_wp / 100
    X["winning"] = (df.best_wp >= 80).astype(int)
    return X


def move_design(df: pd.DataFrame) -> pd.DataFrame:
    """The score-free handcrafted inputs in the order the browser encodes them."""
    X = df[["is_capture", "gives_check", "is_promotion", "is_castle", "backward", "sideways", "was_attacked",
            "lands_attacked", "in_check"]].copy()
    X["captured_value"] = df.captured_value / 9
    X["log_legal"] = np.log1p(df.legal_moves)
    X["captures_available"] = np.log1p(df.captures_available)
    X["checks_available"] = np.log1p(df.checks_available)
    X["non_pawn"] = df.non_pawn_material / 62
    X["material"] = df.material_balance.clip(-15, 15) / 15
    for p in range(1, 7):
        X[f"piece_{p}"] = (df.piece == p).astype(int)
    return X


def evaluate() -> None:
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

    df = duckdb.sql(f"SELECT * FROM '{TABLE}'").df()
    train, test = df[df.test == 0], df[df.test == 1]
    print(f"train {len(train):,} positions ({train.player.nunique():,} players), "
          f"test {len(test):,} ({test.player.nunique():,} players); found {df.found.mean():.1%}")
    y, yt = train.found.values, test.found.values
    base = np.full(len(yt), y.mean())
    rows = [("Overall rate", log_loss(yt, base), brier_score_loss(yt, base), 0.5)]
    results = {}
    for which in ["rating", "clock", "move", "engine"]:
        m = LogisticRegression(max_iter=2000, C=1.0)
        m.fit(design(train, which), y)
        p = m.predict_proba(design(test, which))[:, 1]
        rows.append((f"Logistic: {which}", log_loss(yt, p), brier_score_loss(yt, p), roc_auc_score(yt, p)))
        results[which] = (m, p)
    gb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.1, max_leaf_nodes=63, random_state=0)
    gb.fit(design(train, "engine"), y)
    pg = gb.predict_proba(design(test, "engine"))[:, 1]
    rows.append(("Boosting: engine", log_loss(yt, pg), brier_score_loss(yt, pg), roc_auc_score(yt, pg)))
    gm = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.1, max_leaf_nodes=63, random_state=0)
    gm.fit(design(train, "move"), y)
    pm = gm.predict_proba(design(test, "move"))[:, 1]
    rows.append(("Boosting: move", log_loss(yt, pm), brier_score_loss(yt, pm), roc_auc_score(yt, pm)))
    print(f"\n{'Model':28s} {'log loss':>9s} {'Brier':>8s} {'AUC':>6s}")
    for name, ll, br, auc in rows:
        print(f"{name:28s} {ll:9.4f} {br:8.4f} {auc:6.3f}")

    # bootstrap by player: is the move model's gain over rating real?
    rng = np.random.default_rng(0)
    players = test.player.values
    uniq = np.unique(players)
    idx = {p: np.where(players == p)[0] for p in uniq}
    pr, pmv = results["rating"][1], results["move"][1]
    diffs = []
    for _ in range(200):
        pick = np.concatenate([idx[p] for p in rng.choice(uniq, len(uniq))])
        diffs.append(log_loss(yt[pick], pr[pick], labels=[0, 1]) - log_loss(yt[pick], pmv[pick], labels=[0, 1]))
    lo, hi = np.percentile(diffs, [5, 95])
    print(f"\nlog-loss gain of the move model over rating alone: {np.mean(diffs):.4f} (90% interval {lo:.4f} to {hi:.4f})")

    # calibration of the move model in deciles
    q = pd.qcut(pmv, 10, labels=False, duplicates="drop")
    cal = pd.DataFrame({"p": pmv, "y": yt, "q": q}).groupby("q").agg(pred=("p", "mean"), actual=("y", "mean"), n=("y", "size"))
    print("\ncalibration (move model, deciles):")
    print(cal.round(3).to_string())

    # find rate by rating band, for the write-up
    band = (df.pregame_rating // 200 * 200).clip(600, 2600)
    print("\nfind rate by rating:")
    print(df.groupby(band).found.agg(["mean", "size"]).round(3).to_string())

    m = results["move"][0]
    cols = list(design(test.head(1), "move").columns)
    coef = dict(zip(cols, np.round(m.coef_[0], 4)))
    print("\nmove model coefficients:", json.dumps(coef))
    export(m, cols, train)


# ---------- export to the browser ----------

WEB = Path(__file__).resolve().parents[1] / "web"


def export(model, cols: list[str], train: pd.DataFrame) -> None:
    """Write the move model as TypeScript, and a fixture of positions with Python's features and
    probabilities so the browser port can be checked against it. In the browser the clock is held
    at the training median: the number describes the position, not the player's clock."""
    clock_ref = float(train.clock_frac.median())
    coef = {k: round(float(v), 6) for k, v in zip(cols, model.coef_[0])}
    ts = f"""// Generated by scripts/eval_find_rate.py: how often blitz players find the only good move, from
// {len(train):,} positions in the engine dataset (logistic regression; see docs/methods.md).
export const FIND_RATE_MODEL = {json.dumps({"intercept": round(float(model.intercept_[0]), 6), "clockRef": round(clock_ref, 4), "coef": coef}, indent=2)} as const;
"""
    (WEB / "src" / "browser" / "findRateModel.ts").write_text(ts)
    raw = duckdb.sql(f"SELECT fen, best_uci FROM '{RAW}'").df()
    df = duckdb.sql(f"SELECT * FROM '{TABLE}'").df()
    df["fen"] = raw.fen.values
    sample = df[df.test == 1].sample(300, random_state=1).copy()
    sample["clock_frac"] = clock_ref
    X = design(sample, "move")
    p = model.predict_proba(X)[:, 1]
    feats = ["piece", "is_capture", "captured_value", "gives_check", "is_promotion", "is_castle", "backward", "sideways",
             "was_attacked", "lands_attacked", "in_check", "legal_moves", "captures_available", "checks_available",
             "material_balance", "non_pawn_material"]
    rows = [{"fen": r.fen, "best": r.best_uci, "rating": int(r.pregame_rating),
             "features": {f: int(getattr(r, f)) for f in feats}, "p": round(float(pi), 6)}
            for r, pi in zip(sample.itertuples(), p)]
    (WEB / "test" / "fixtures" / "find_rate.json").write_text(json.dumps(rows))
    print(f"wrote findRateModel.ts (clock held at {clock_ref:.3f}) and a 300-position parity fixture")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["build", "evaluate"])
    {"build": build, "evaluate": evaluate}[ap.parse_args().step]()
