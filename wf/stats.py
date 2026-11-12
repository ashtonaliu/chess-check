"""Rating-adjusted opening performance with empirical-Bayes shrinkage.

For each game, expected score comes from the Elo formula. The residual
(actual - expected) removes opponent strength. Per-opening mean residuals
are shrunk toward 0 (the player's average) in proportion to how little data
backs them, so 4 unlucky games don't become "a weakness".
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd
from scipy.stats import norm

from .fetch import Game

Z90 = 1.645


def expected_score(my: float, opp: float) -> float:
    return 1.0 / (1.0 + 10 ** ((opp - my) / 400.0))


def games_frame(games: list[Game]) -> pd.DataFrame:
    df = pd.DataFrame([{
        "url": g.url, "color": g.color, "my_rating": g.my_rating,
        "opp_rating": g.opp_rating, "score": g.score,
        "time_class": g.time_class, "eco": g.eco, "opening": g.opening,
        "family": g.family, "end_time": g.end_time,
        "moves": " ".join(g.moves_san[:16]),
    } for g in games])
    if df.empty:
        return df
    df["expected"] = [expected_score(a, b)
                      for a, b in zip(df.my_rating, df.opp_rating)]
    df["residual"] = df.score - df.expected
    return df


def shrink(groups: pd.DataFrame, sigma2: float) -> pd.DataFrame:
    """Normal-normal empirical Bayes. groups needs columns n, mean_resid.

    sigma2: per-game residual variance. tau2 (between-opening variance) is
    estimated by method of moments and floored so it is never zero.
    """
    g = groups.copy()
    noise = sigma2 / g.n
    tau2 = max(float(np.average(g.mean_resid ** 2, weights=g.n)
                     - np.average(noise, weights=g.n)), 0.002)
    post_var = 1.0 / (1.0 / tau2 + 1.0 / noise)
    g["shrunk"] = post_var * (g.mean_resid / noise)
    g["post_sd"] = np.sqrt(post_var)
    g["ci_low"] = g.shrunk - Z90 * g.post_sd
    g["ci_high"] = g.shrunk + Z90 * g.post_sd
    g["p_below"] = norm.cdf(0, loc=g.shrunk, scale=g.post_sd)
    g["tau2"] = tau2
    return g


def opening_table(df: pd.DataFrame, min_games: int = 3) -> pd.DataFrame:
    """One row per (color, opening family), worst first."""
    if df.empty:
        return df
    from .db import opening_groups  # SQL aggregation in DuckDB

    sigma2 = max(float(df.residual.var(ddof=1)), 0.05) if len(df) > 1 else 0.2
    grp = opening_groups(df, min_games)
    if grp.empty:
        return grp
    out = shrink(grp, sigma2)
    return out.sort_values("shrunk").reset_index(drop=True)


def verdict(row) -> str:
    if row.p_below >= 0.9 and row.ci_high < 0:
        return "weakness"
    if row.p_below >= 0.75:
        return "possible weakness"
    if row.p_below <= 0.1 and row.ci_low > 0:
        return "strength"
    if row.p_below <= 0.25:
        return "possible strength"
    return "not enough evidence"


def worst_branch(df: pd.DataFrame, color: str, family: str,
                 min_games: int = 3, max_ply: int = 12) -> dict | None:
    """Find the move sequence inside an opening where results drop most.

    Looks at every prefix of the first max_ply moves and returns the longest,
    worst-scoring prefix with at least min_games games.
    """
    sub = df[(df.color == color) & (df.family == family)]
    if len(sub) < min_games:
        return None
    base = sub.residual.mean()
    best = None
    for ply in range(4, max_ply + 1):
        prefixes = sub.moves.str.split().str[:ply].str.join(" ")
        for pre, idx in prefixes.groupby(prefixes).groups.items():
            if len(idx) < min_games or len(pre.split()) < ply:
                continue
            r = sub.loc[idx]
            gap = r.residual.mean() - base
            cand = {"moves": pre, "ply": ply, "n": len(idx),
                    "score": r.score.mean(), "expected": r.expected.mean(),
                    "mean_resid": r.residual.mean(), "gap": gap}
            # prefer clearly worse branches, then longer (more specific) ones
            if gap < -0.1 and (best is None or
                               (cand["mean_resid"], -ply) <
                               (best["mean_resid"], -best["ply"])):
                best = cand
    return best


def format_moves(moves: str, start_white: bool = True) -> str:
    """'e4 c5 Nf3' -> '1.e4 c5 2.Nf3'."""
    out = []
    for i, san in enumerate(moves.split()):
        if i % 2 == 0:
            out.append(f"{i // 2 + 1}.{san}")
        else:
            out.append(san)
    return " ".join(out)


def pct(x: float) -> str:
    return f"{round(100 * x)}%"


def overall(df: pd.DataFrame) -> dict:
    return {
        "games": len(df),
        "score": float(df.score.mean()),
        "expected": float(df.expected.mean()),
        "resid": float(df.residual.mean()),
        "avg_rating": int(round(df.my_rating.mean())),
        "first_ts": int(df.end_time.min()), "last_ts": int(df.end_time.max()),
        "se": float(df.residual.std(ddof=1) / math.sqrt(len(df)))
        if len(df) > 1 else float("nan"),
    }
