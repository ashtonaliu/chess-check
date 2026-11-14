"""Do learned playstyle embeddings predict who outplays whom better than ratings?

Each player gets k numbers (their "style"). Two players' matchup term is s(i, j) = x_i^T A x_j with
A antisymmetric (A = M - M^T), so s(i, j) = -s(j, i): however much i is favored against j by
style, j is disfavored by exactly as much. The model is

    P(score) = sigmoid(beta * rating_logit + bias + s(i, j))

where rating_logit is the logit of the Elo expected score from pre-game ratings. It is trained on
every game in the cached player histories that ended before a cutoff time (a few million results
between real opponents) and tested on the odds experiment's target games after the cutoff, against
a ratings-only model (the same model without s) fitted on the same games. Splitting by time keeps
test games out of training: the cached histories include the target games themselves.

Players with fewer than MIN_GAMES training games get no embedding (s = 0 for their games), and the
embeddings are shrunk toward zero (L2), so a player needs real evidence before they get a style.

  python scripts/eval_embeddings.py --data v3 --dims 2 4 8
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import eval_odds as E  # noqa: E402  (pre-game ratings and the bootstrap)

MIN_GAMES = 30


def build(data: Path, cutoff: int | None):
    """Stream the player files once, keeping only (player, opponent, score, rating logit) for each
    training game and each player's (end time, rating after) list for pre-game ratings."""
    targets = json.loads((data / "targets.json").read_text())
    cutoff = cutoff or int(np.median([t["end"] for t in targets]))
    target_urls = {t["url"] for t in targets}
    seen: set[str] = set()
    train: list[tuple] = []
    timeline: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for f in (data / "players").glob("*.json"):
        raw = json.loads(f.read_text())
        games = E.with_pregame(raw["games"] if isinstance(raw, dict) else raw)   # v3 stores a dict, v2 a list
        if not games:
            continue
        timeline[f.stem] = (np.array([g["end"] for g in games]), np.array([g["my"] for g in games]))
        for g in games:
            if g["end"] >= cutoff or g["url"] in target_urls or g["url"] in seen:
                continue
            seen.add(g["url"])
            e = min(max(E.expected(g["my_pre"], g["opp_pre"]), 1e-4), 1 - 1e-4)
            train.append((f.stem, g["opp_name"], g["score"], math.log(e / (1 - e)), g["end"]))
    del seen

    def pregame(name: str, t: int):
        if name not in timeline:
            return None
        ends, ratings = timeline[name]
        k = int(np.searchsorted(ends, t)) - 1      # last game that ended before t
        return float(ratings[k]) if k >= 0 else None

    counts: dict[str, int] = {}
    for a, b, *_ in train:
        counts[a] = counts.get(a, 0) + 1; counts[b] = counts.get(b, 0) + 1
    players = sorted(p for p, c in counts.items() if c >= MIN_GAMES)
    index = {p: i + 1 for i, p in enumerate(players)}            # 0 = no embedding
    # test games: target games after the cutoff, with exact pre-game ratings as in eval_odds
    test = []
    for t in targets:
        if t["end"] < cutoff:
            continue
        a, b = pregame(t["focal"], t["end"]), pregame(t["opp_name"], t["end"])
        if a is None or b is None:
            continue
        e = min(max(E.expected(a, b), 1e-4), 1 - 1e-4)
        test.append((t["focal"], t["opp_name"], t["score"], math.log(e / (1 - e))))

    def tensors(rows):
        return (torch.tensor([index.get(r[0], 0) for r in rows]), torch.tensor([index.get(r[1], 0) for r in rows]),
                torch.tensor([r[2] for r in rows], dtype=torch.float32), torch.tensor([r[3] for r in rows], dtype=torch.float32))
    # validation: the last week of training games, used only to choose the model's size and strength
    week = cutoff - 7 * 86400
    fit_rows, val_rows = [r for r in train if r[4] < week], [r for r in train if r[4] >= week]
    return (cutoff, len(players), tensors(train), tensors(test), [r[0] for r in test],
            tensors(fit_rows), tensors(val_rows))


class Model(torch.nn.Module):
    """k = 0 and offsets=False is the ratings-only model. offsets adds a learned per-player
    correction to the rating (how much stronger or weaker than rated they play); k > 0 adds styles."""
    def __init__(self, n_players: int, k: int, offsets: bool = False):
        super().__init__()
        self.beta = torch.nn.Parameter(torch.tensor(1.0))
        self.bias = torch.nn.Parameter(torch.tensor(0.0))
        self.k, self.offsets = k, offsets
        if offsets:
            self.off = torch.nn.Embedding(n_players + 1, 1)
            torch.nn.init.zeros_(self.off.weight)
        if k:
            self.x = torch.nn.Embedding(n_players + 1, k)
            # start large enough that the bilinear term has gradients (three tiny factors multiply)
            torch.nn.init.normal_(self.x.weight, std=0.3)
            self.M = torch.nn.Parameter(torch.randn(k, k) * 0.3)

    def forward(self, i, j, rl):
        z = self.beta * rl + self.bias
        if self.offsets:
            z = z + (self.off(i).squeeze(-1) * (i > 0).float() - self.off(j).squeeze(-1) * (j > 0).float())
        if self.k:
            xi, xj = self.x(i), self.x(j)
            mask = ((i > 0) & (j > 0)).float()
            A = self.M - self.M.T
            z = z + mask * ((xi @ A) * xj).sum(-1)
        return torch.sigmoid(z)

    def penalty(self):
        p = torch.tensor(0.0)
        if self.k:
            p = p + (self.x.weight[1:] ** 2).sum()
        if self.offsets:
            p = p + (self.off.weight[1:] ** 2).sum()
        return p


def fit(train, n_players: int, k: int, l2: float, offsets: bool = False, epochs: int = 12,
        batch: int = 65536, seed: int = 0) -> Model:
    torch.manual_seed(seed)
    i, j, y, rl = train
    m = Model(n_players, k, offsets)
    opt = torch.optim.Adam(m.parameters(), lr=0.03)
    n = len(y)
    for _ in range(epochs):
        perm = torch.randperm(n)
        for s in range(0, n, batch):
            b = perm[s:s + batch]
            p = m(i[b], j[b], rl[b]).clamp(1e-6, 1 - 1e-6)
            loss = -(y[b] * p.log() + (1 - y[b]) * (1 - p).log()).mean() + l2 * m.penalty() / n
            opt.zero_grad(); loss.backward(); opt.step()
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="v3")
    ap.add_argument("--cutoff", type=int, default=None, help="unix time; default is the median target game's end")
    ap.add_argument("--dims", type=int, nargs="+", default=[2, 4, 8])
    ap.add_argument("--l2", type=float, nargs="+", default=[1.5, 2.5, 4.0, 6.0])
    args = ap.parse_args()
    cutoff, n_players, train, test, groups, fit_rows, val_rows = build(ROOT / "data" / "odds" / args.data, args.cutoff)
    groups = np.array(groups)
    print(f"cutoff {cutoff}: {len(train[2]):,} training games among {n_players:,} players with an embedding "
          f"({len(val_rows[2]):,} of them in the last week, used to choose settings); {len(test[2]):,} test games")

    def brier(m, rows):
        with torch.no_grad():
            return (m(rows[0], rows[1], rows[3]).numpy() - rows[2].numpy()) ** 2

    # 1. choose each model's settings on the last week before the cutoff
    print("\nValidation (last week before the cutoff), Brier:")
    v_base = brier(fit(fit_rows, n_players, 0, 0.0), val_rows).mean()
    print(f"  ratings only: {v_base:.4f}")
    best = {}
    for kind, ks in (("offsets", [0]), ("styles", args.dims), ("offsets + styles", args.dims)):
        for k in ks:
            for l2 in args.l2:
                v = brier(fit(fit_rows, n_players, k, l2, offsets=kind != "styles"), val_rows).mean()
                print(f"  {kind}, size {k}, L2 {l2:g}: {v:.4f}")
                if kind not in best or v < best[kind][0]:
                    best[kind] = (v, k, l2)

    # 2. refit the chosen settings on all training games and test once
    rng = np.random.default_rng(0)
    b0 = brier(fit(train, n_players, 0, 0.0), test)
    print(f"\nTest games after the cutoff. Ratings only: Brier {b0.mean():.4f}")
    print("| Model (settings chosen on validation) | Test Brier | Change vs ratings only, positive = better (90% interval) |")
    print("|---|---:|---|")
    for kind, (_, k, l2) in best.items():
        m = fit(train, n_players, k, l2, offsets=kind != "styles")
        d = b0 - brier(m, test)
        lo, hi = E._boot(d, groups, rng)
        print(f"| {kind} (size {k}, L2 {l2:g}) | {brier(m, test).mean():.4f} | {d.mean():+.4f} ({lo:+.4f} to {hi:+.4f}) |")


if __name__ == "__main__":
    main()
