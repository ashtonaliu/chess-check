"""Do engine profiles from the stored dataset beat the recalibrated odds formula?

Uses all 14,739 targets in data/engine/v1 (the earlier engine tests used 995). For each target
game, both players' profiles come only from the 50 blitz games listed in samples/targets.parquet,
which all ended before the target started. Nothing from the target game is used except its result.

Baseline: the app's formula, sigmoid(a * logit(Elo) + b * colour), with blitz coefficients fitted
on a separate 1.5M-game sample. Models add feature groups as focal-minus-opponent differences in a
multinomial logistic regression (win/draw/loss), with C chosen by an inner grouped split, evaluated
out of sample by 5 folds grouped by focal player and compared with a paired bootstrap over players.

  python scripts/eval_engine_odds.py build      # about 15 s: per-game stats to data/engine/derived
  python scripts/eval_engine_odds.py evaluate
"""
import argparse
import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from chesscheck.stats import pregame_expected  # noqa: E402

DATA = ROOT / "data/engine/v1"
DERIVED = ROOT / "data/engine/derived"
RECENT = 15  # games counted as "recent form"
SEED = 0


def build() -> None:
    from chesscheck.dataset import EngineDataset
    DERIVED.mkdir(parents=True, exist_ok=True)
    with EngineDataset(threads=16) as d:
        c = d.connection
        c.execute(f"""COPY (SELECT * FROM dataset_player_games(NULL, 9999999999, 'blitz'))
                      TO '{DERIVED / "player_games.parquet"}' (FORMAT parquet)""")
        # The engine's expected score for White at fixed plies (win/draw/loss per mille).
        c.execute(f"""COPY (SELECT game_id, run_id, ply, (wdl_w + 0.5 * wdl_d) / 1000.0 AS white_expect
                            FROM _dataset_positions WHERE ply IN (20, 40, 60) AND wdl_w IS NOT NULL)
                      TO '{DERIVED / "checkpoints.parquet"}' (FORMAT parquet)""")


# Per-game rate columns pooled over a history by their own move counts.
RATES = ["win_pct_loss", "opening_win_pct_loss", "middlegame_win_pct_loss", "endgame_win_pct_loss",
         "critical_best_move_rate", "easy_best_move_rate", "critical_time_spent", "easy_time_spent",
         "low_clock_win_pct_loss", "depth10_blunder_rate", "conversion", "resilience"]


def history_table(con) -> pd.DataFrame:
    """One row per (target, side, history game) with that game's per-player stats."""
    return con.sql(f"""
        WITH h AS (
            SELECT target_id, start_ts AS target_start, 'focal' AS side, lower(focal) AS player,
                   unnest(focal_history) AS game_id FROM '{DATA}/samples/targets.parquet'
            UNION ALL
            SELECT target_id, start_ts, 'opponent', lower(opponent),
                   unnest(opponent_history) FROM '{DATA}/samples/targets.parquet'
        ), pg AS (SELECT * FROM '{DERIVED}/player_games.parquet'),
        cp AS (PIVOT '{DERIVED}/checkpoints.parquet' ON ply USING first(white_expect) GROUP BY game_id)
        SELECT h.target_id, h.target_start, h.side, h.player, g.*,
               o.pregame_rating AS opp_pregame_rating, cp."40" AS white_expect40
        FROM h JOIN pg g ON g.game_id = h.game_id AND g.player = h.player
        LEFT JOIN pg o ON o.game_id = g.game_id AND o.player = g.opponent
        LEFT JOIN cp ON cp.game_id = g.game_id
    """).df()


def profiles(hist: pd.DataFrame) -> pd.DataFrame:
    assert (hist.end_ts < hist.target_start).all(), "a history game ended after its target started"
    hist = hist.sort_values(["target_id", "side", "end_ts"])
    hist["recent"] = hist.groupby(["target_id", "side"]).cumcount(ascending=False) < RECENT
    for r in RATES:
        hist[r + "_sum"] = hist[r].fillna(0) * hist[r + "_n"].fillna(0)
    # Results against rating in the history games (no engine): score minus pre-game expectation.
    ok = hist.pregame_rating.notna() & hist.opp_pregame_rating.notna()
    hist["expected"] = np.where(ok, [pregame_expected(a, b, c, "blitz") if k else np.nan for a, b, c, k in
                                     zip(hist.pregame_rating, hist.opp_pregame_rating, hist.color, ok)], np.nan)
    hist["over"] = hist.score - hist.expected
    # Results after move 20 against the engine's expectation at move 20.
    mine = np.where(hist.color == "white", hist.white_expect40, 1 - hist.white_expect40)
    hist["after20"] = hist.score - mine
    keys = ["target_id", "side"]
    g = hist.groupby(keys)
    out = pd.DataFrame({"games": g.size()})
    for r in RATES:
        out[r] = g[r + "_sum"].sum() / g[r + "_n"].sum().replace(0, np.nan)
    rec, old = hist[hist.recent].groupby(keys), hist[~hist.recent].groupby(keys)
    out["loss_trend"] = (rec.win_pct_loss_sum.sum() / rec.win_pct_loss_n.sum()
                         - old.win_pct_loss_sum.sum() / old.win_pct_loss_n.sum().replace(0, np.nan))
    out["over_rating"] = g.over.mean()
    out["after20"] = g.after20.mean()
    first = hist.groupby(keys).pregame_rating.first()
    last = hist.groupby(keys).pregame_rating.last()
    out["rating_climb"] = last - first
    out["time_ratio"] = out.critical_time_spent / out.easy_time_spent
    return out.reset_index()


def assemble() -> pd.DataFrame:
    con = duckdb.connect(config={"threads": 16})
    prof = profiles(history_table(con))
    targets = con.sql(f"""
        SELECT t.target_id, lower(t.focal) AS focal, t.focal_pre, t.opponent_pre,
               CASE WHEN lower(g.white) = lower(t.focal) THEN 'white' ELSE 'black' END AS color,
               CASE WHEN lower(g.white) = lower(t.focal) THEN g.white_result ELSE g.black_result END AS result
        FROM '{DATA}/samples/targets.parquet' t JOIN '{DATA}/games/part-*.parquet' g ON g.game_id = t.target_id
    """).df()
    from chesscheck.fetch import DRAW_RESULTS
    targets["score"] = [1.0 if r == "win" else 0.5 if r in DRAW_RESULTS else 0.0 for r in targets.result]
    wide = prof.pivot(index="target_id", columns="side")
    wide.columns = [f"{side}_{name}" for name, side in wide.columns]
    df = targets.merge(wide.reset_index(), on="target_id")
    p = np.array([pregame_expected(a, b, c, "blitz") for a, b, c in zip(df.focal_pre, df.opponent_pre, df.color)])
    df["base_p"] = p
    df["base_logit"] = np.log(p / (1 - p))
    df["white"] = np.where(df.color == "white", 1.0, -1.0)
    return df


def implied_rating(df: pd.DataFrame, train: np.ndarray) -> np.ndarray:
    """Rating predicted from move quality alone, fitted on training rows (no results used)."""
    from sklearn.linear_model import LinearRegression
    cols = ["win_pct_loss", "critical_best_move_rate", "depth10_blunder_rate", "endgame_win_pct_loss"]
    X = np.vstack([df[[f"{s}_{c}" for c in cols]].to_numpy() for s in ("focal", "opponent")])
    y = np.concatenate([df.focal_pre.to_numpy(), df.opponent_pre.to_numpy()])
    tr = np.concatenate([train, train])
    ok = np.isfinite(X).all(1)
    model = LinearRegression().fit(X[tr & ok], y[tr & ok])
    pred = np.where(ok, model.predict(np.nan_to_num(X)), np.nan)
    gap = pred - y  # positive: plays better than the rating says
    n = len(df)
    return gap[:n] - gap[n:]


GROUPS = {
    "history (no engine)": ["over_rating", "rating_climb"],
    "move quality": ["win_pct_loss", "depth10_blunder_rate", "critical_best_move_rate", "easy_best_move_rate"],
    "phases": ["opening_win_pct_loss", "middlegame_win_pct_loss", "endgame_win_pct_loss"],
    "clock": ["low_clock_win_pct_loss", "time_ratio"],
    "conversion": ["conversion", "resilience", "after20"],
    "form": ["loss_trend"],
}


def diff(df, names):
    return np.column_stack([df[f"focal_{n}"] - df[f"opponent_{n}"] for n in names]) if names else np.empty((len(df), 0))


def evaluate() -> None:
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import GroupKFold
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from threadpoolctl import threadpool_limits
    sys.path.insert(0, str(ROOT / "scripts"))
    from eval_odds import _boot

    df = assemble()
    y = (2 * df.score).astype(int).to_numpy()
    groups = df.focal.to_numpy()
    n = len(df)
    print(f"{n} target games, {len(set(groups))} focal players, "
          f"win/draw/loss {np.mean(y == 2):.3f}/{np.mean(y == 1):.3f}/{np.mean(y == 0):.3f}")
    base = df[["base_logit", "white"]].to_numpy()
    outer = list(GroupKFold(5).split(base, y, groups))
    cs = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1.0]

    def fit_predict(X, tr, te, c):
        m = make_pipeline(SimpleImputer(), StandardScaler(), LogisticRegression(C=c, max_iter=5000))
        m.fit(X[tr], y[tr])
        return m.predict_proba(X[te])

    def brier(p):
        return (p[:, 2] + 0.5 * p[:, 1] - y / 2) ** 2

    def run(make_X):
        out = np.zeros((n, 3))
        for tr, te in outer:
            trm = np.zeros(n, bool); trm[tr] = True
            X = make_X(trm)
            inner = [(tr[a], tr[b]) for a, b in GroupKFold(4).split(tr, y[tr], groups[tr])]
            def score(c, X=X, inner=inner):
                return np.mean(np.concatenate([(lambda p: (p[:, 2] + 0.5 * p[:, 1] - y[b] / 2) ** 2)(
                    fit_predict(X, a, b, c)) for a, b in inner]))
            c = min(cs, key=score)
            out[te] = fit_predict(X, tr, te, c)
        return out

    preds = {}
    p0 = df.base_p.to_numpy()
    preds["app formula (fixed)"] = (p0 - y / 2) ** 2
    with threadpool_limits(limits=1):
        preds["formula refit"] = brier(run(lambda m: base))
        hist = diff(df, GROUPS["history (no engine)"])
        preds["+ history (no engine)"] = brier(run(lambda m: np.column_stack([base, hist])))
        for name, cols in GROUPS.items():
            if name.startswith("history"):
                continue
            preds[f"+ history + {name}"] = brier(run(lambda m, cols=cols: np.column_stack([base, hist, diff(df, cols)])))
        preds["+ history + implied rating"] = brier(run(lambda m: np.column_stack([base, hist, implied_rating(df, m)])))
        engine = [c for k, v in GROUPS.items() if not k.startswith("history") for c in v]
        preds["+ history + all engine"] = brier(run(lambda m: np.column_stack(
            [base, hist, diff(df, engine), implied_rating(df, m)])))

    rng = np.random.default_rng(SEED)
    ref = {"formula refit": "app formula (fixed)", "+ history (no engine)": "formula refit"}
    print("\n| Model | Brier | Gain vs reference (90% interval) | Reference |\n|---|---:|---:|---|")
    for name, b in preds.items():
        r = ref.get(name, "+ history (no engine)") if name != "app formula (fixed)" else None
        if r is None:
            print(f"| {name} | {b.mean():.5f} | | |")
            continue
        d = preds[r] - b
        lo, hi = _boot(d, groups, rng)
        print(f"| {name} | {b.mean():.5f} | {d.mean():+.5f} ({lo:+.5f} to {hi:+.5f}) | {r} |")

    # How each profile tracks rating, as a sanity check.
    print("\nCorrelation with the player's own pre-game rating (focal side):")
    for c in ["win_pct_loss", "critical_best_move_rate", "conversion", "after20", "over_rating", "loss_trend"]:
        ok = df[f"focal_{c}"].notna()
        print(f"  {c}: {np.corrcoef(df.loc[ok, f'focal_{c}'], df.loc[ok, 'focal_pre'])[0, 1]:+.3f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["build", "evaluate"])
    {"build": build, "evaluate": evaluate}[ap.parse_args().step]()
