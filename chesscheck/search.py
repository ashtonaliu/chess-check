"""Search a player's games by meaning: each game becomes a short plain-English
summary, and queries like "threw away a winning position" are matched against
those summaries.

Three retrievers, compared by scripts/eval_search.py:
  embed  - all-MiniLM-L6-v2 sentence embeddings, cosine similarity
  bm25   - keyword matching (Okapi BM25), the classic baseline
  hybrid - reciprocal-rank fusion of the two

The same model runs in the browser through transformers.js (web/src/browser/search.ts).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from .engine import BLUNDER_DROP, OPENING_PLIES
from .fetch import Game

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

HOW_LOST = {"timeout": "lost on time", "checkmated": "got checkmated", "resigned": "resigned",
            "abandoned": "abandoned the game", "timevsinsufficient": "drew on time"}
HOW_WON = {"timeout": "won on time", "checkmated": "won by checkmate", "resigned": "won by resignation",
           "abandoned": "won when the opponent abandoned"}
HOW_DREW = {"agreed": "drew by agreement", "repetition": "drew by repetition", "stalemate": "drew by stalemate",
            "insufficient": "drew with insufficient material", "50move": "drew by the 50-move rule",
            "timevsinsufficient": "drew on time against insufficient material"}


def _move_label(m: dict) -> str:
    return f"{m['move_no']}.{m['san']}" if m["ply"] % 2 == 0 else f"{m['move_no']}...{m['san']}"


def outcome_text(g: Game) -> str:
    if g.score == 1:
        return HOW_WON.get(g.opp_result, "won")
    if g.score == 0:
        return HOW_LOST.get(g.result, "lost")
    return HOW_DREW.get(g.result, "drew")


def summarize(g: Game, a: dict | None) -> str:
    """One deterministic paragraph per game, in the player's second person."""
    side = "White" if g.color == "white" else "Black"
    diff = g.opp_rating - g.my_rating
    opp = ("a much stronger" if diff >= 150 else "a stronger" if diff >= 50 else
           "a much weaker" if diff <= -150 else "a weaker" if diff <= -50 else "an evenly matched")
    plies = len(g.moves_san)
    parts = [f"You {outcome_text(g)} as {side} against {opp} opponent ({g.my_rating} vs {g.opp_rating}) "
             f"in the {g.opening} ({g.family}), {(plies + 1) // 2} moves."]
    if a:
        mine = [m for m in a["moves"] if m["is_me"]]
        oe = a.get("opening_eval")
        if oe is not None:
            parts.append("You were worse out of the opening" if oe <= -100 else
                         "You were better out of the opening" if oe >= 100 else
                         "The opening went about equal")
            parts[-1] += f" ({oe / 100:+.1f} after move 12)."
        evals = [m["cp_after"] for m in mine]
        if evals:
            hi, lo = max(evals), min(evals)
            if hi >= 300 and g.score < 1:
                parts.append(f"You had a winning position (up to {hi / 100:+.1f}) but did not convert it.")
            if lo <= -300 and g.score >= 0.5:
                parts.append(f"You recovered from a losing position (down to {lo / 100:+.1f}).")
        worst = max(mine, key=lambda m: m["wp_loss"], default=None)
        if worst and worst["wp_loss"] >= BLUNDER_DROP:
            frac = worst.get("clock_frac")
            clock = ("in time trouble" if frac is not None and frac <= 0.1 else
                     "with little time left" if frac is not None and frac <= 0.3 else "with time on the clock")
            best = f"; {worst['best']} was better" if worst.get("best") else ""
            parts.append(f"Your worst mistake was {_move_label(worst)} in the {worst['phase']}, {clock}, "
                         f"losing {worst['wp_loss']:.0f}% winning chances{best}.")
            n = sum(m["wp_loss"] >= BLUNDER_DROP for m in mine)
            if n > 1:
                parts.append(f"You made {n} blunders in this game.")
        else:
            parts.append("You made no serious blunders.")
        if plies > OPENING_PLIES and mine:
            parts.append(f"The game reached the {mine[-1]['phase']}.")
    return " ".join(parts)


# ---------- retrievers ----------

_TOKEN = re.compile(r"[a-z0-9']+")
_model = None


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(text.lower())


def embedder():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(MODEL_NAME, device="cpu")
    return _model


@dataclass
class GameIndex:
    urls: list[str]
    texts: list[str]
    vectors: np.ndarray | None = None
    bm25: object = None

    @classmethod
    def from_texts(cls, urls: list[str], texts: list[str], methods=("embed", "bm25")) -> "GameIndex":
        idx = cls(list(urls), list(texts))
        if "embed" in methods:
            idx.vectors = embedder().encode(idx.texts, normalize_embeddings=True, batch_size=64)
        if "bm25" in methods:
            from rank_bm25 import BM25Okapi
            idx.bm25 = BM25Okapi([_tokens(t) for t in idx.texts])
        return idx

    @classmethod
    def build(cls, games: list[Game], analyses: list[dict] | None, methods=("embed", "bm25")) -> "GameIndex":
        by_url = {a["url"]: a for a in analyses or []}
        return cls.from_texts([g.url for g in games],
                              [summarize(g, by_url.get(g.url)) for g in games], methods)

    def scores(self, query: str, method: str) -> np.ndarray:
        if method == "embed":
            q = embedder().encode([query], normalize_embeddings=True)[0]
            return self.vectors @ q
        if method == "bm25":
            return np.asarray(self.bm25.get_scores(_tokens(query)))
        if method == "hybrid":   # reciprocal-rank fusion
            out = np.zeros(len(self.urls))
            for m in ("embed", "bm25"):
                # stable sorts: ties keep game order, so the TypeScript port can match
                ranks = np.argsort(np.argsort(-self.scores(query, m), kind="stable"), kind="stable")
                out += 1.0 / (60 + ranks)
            return out
        raise ValueError(method)

    def search(self, query: str, k: int = 5, method: str = "embed") -> list[tuple[int, float]]:
        s = self.scores(query, method)
        top = np.argsort(-s, kind="stable")[:k]
        return [(int(i), float(s[i])) for i in top]
