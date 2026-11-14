"""Rating-adjusted opening performance with hierarchical Bayesian shrinkage.

For each game, expected score comes from the Elo formula. The residual
(actual - expected) removes opponent strength. Per-opening mean residuals
are shrunk toward the player's average in proportion to how little data
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


TAU_PRIOR_SCALE = 0.10   # half-normal prior on the between-opening SD (10 points)
TAU_GRID = np.linspace(0.005, 0.40, 80)
THETA_GRID = np.linspace(-1.0, 1.0, 2001)


def shrink(groups: pd.DataFrame, sigma2: float, mu: float = 0.0) -> pd.DataFrame:
    """Hierarchical normal model, with the between-opening SD integrated out.

        mean_resid_i ~ N(theta_i, sigma2 / n_i)
        theta_i      ~ N(mu, tau^2)        mu = the player's overall residual
        tau          ~ HalfNormal(0.10)

    Plugging in a single estimate of tau (empirical Bayes) is overconfident:
    with ~30 small groups the likelihood for tau is nearly flat, and point
    estimates often collapse to ~0, which shrinks every opening to the mean.
    Instead the posterior for each theta_i is a mixture over a grid of tau,
    weighted by marginal likelihood x prior.
    """
    g = groups.copy()
    n = g.n.to_numpy(float)
    y = g.mean_resid.to_numpy(float)
    noise = sigma2 / n                                   # (G,)
    t2 = TAU_GRID[:, None] ** 2                          # (T,1)
    marg_var = t2 + noise[None, :]                       # (T,G)
    loglik = -0.5 * np.sum(np.log(marg_var) + (y - mu) ** 2 / marg_var, axis=1)
    logprior = -0.5 * (TAU_GRID / TAU_PRIOR_SCALE) ** 2
    lw = loglik + logprior
    w = np.exp(lw - lw.max())
    w /= w.sum()                                         # (T,)

    k = t2 / marg_var                                    # shrink factor (T,G)
    m = mu + k * (y - mu)                                # conditional means
    v = 1.0 / (1.0 / t2 + 1.0 / noise[None, :])          # conditional variances
    post_mean = (w[:, None] * m).sum(0)
    post_var = (w[:, None] * (v + m ** 2)).sum(0) - post_mean ** 2

    # mixture CDF on a grid -> interval and P(theta < 0)
    sd = np.sqrt(v)
    cdf = np.einsum("t,tgx->gx", w,
                    norm.cdf((THETA_GRID[None, None, :] - m[:, :, None]) / sd[:, :, None]))
    lo = THETA_GRID[np.argmax(cdf >= 0.05, axis=1)]
    hi = THETA_GRID[np.argmax(cdf >= 0.95, axis=1)]
    p0 = (w[:, None] * norm.cdf((0 - m) / sd)).sum(0)

    g["shrunk"] = post_mean
    g["post_sd"] = np.sqrt(np.maximum(post_var, 0))
    g["ci_low"], g["ci_high"], g["p_below"] = lo, hi, p0
    g["tau_post_mean"] = float((w * TAU_GRID).sum())
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
    out = shrink(grp, sigma2, mu=float(df.residual.mean()))
    out["raw_z"] = out.mean_resid / np.sqrt(sigma2 / out.n)   # unadjusted z-score
    out["n_openings"] = len(out)
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
    # Clearly bad on its own, but not after accounting for how many openings
    # were tested (one of ~30 openings at z = -2 is expected by chance).
    if row.n >= 8 and row.raw_z <= -1.645:
        return "worth watching"
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
