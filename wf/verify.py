"""Check every claim in the coach's text against the facts it was given.

Three checks:
1. citations: every [F#] must exist;
2. moves: every chess move (e.g. 4.Qxd4, Nf3, O-O) must appear in a fact;
3. numbers: every number must match a number in a fact cited in the same
   sentence (or, failing that, in any fact, reported as uncited).
Anything else counts as unsupported: a hallucination we can measure.
"""
from __future__ import annotations

import re

CITE = re.compile(r"\[(F\d+)\]")
URL = re.compile(r"https?://\S+")
MOVE = re.compile(
    r"(?<![\w.])(?:\d+\.(?:\.\.)?\s?)?"
    r"(?:O-O(?:-O)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8]|"
    r"[a-h][1-8](?:=[QRBN])?)[+#]?(?![\w])")
NUM = re.compile(r"(?<![\w.])[-+−]?\d+(?:\.\d+)?")
LIST_MARK = re.compile(r"^\s*(?:\d+[.)]|[-*])\s+", re.M)


def _numbers(text: str) -> set[float]:
    text = URL.sub(" ", text)
    text = MOVE.sub(" ", text)
    return {abs(float(n.replace("−", "-"))) for n in NUM.findall(text)}


def _moves(text: str) -> set[str]:
    return {re.sub(r"^\d+\.(?:\.\.)?\s?", "", m) for m in MOVE.findall(URL.sub(" ", text))}


def _sentences(text: str) -> list[str]:
    text = LIST_MARK.sub("", text)
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z*_#\[])|\n+", text)
    return [p.strip() for p in parts if p.strip()]


def verify(output: str, facts: list[dict]) -> dict:
    by_id = {f["id"]: f["text"] for f in facts}
    all_text = " ".join(by_id.values())
    all_nums = _numbers(all_text)
    all_moves = _moves(all_text)
    fact_urls = set(URL.findall(all_text))

    bad_cites, unsupported, uncited, checked = [], [], [], 0
    pending_cites: list[str] = []
    for sent in _sentences(output):
        cites = CITE.findall(sent)
        bad_cites += [c for c in cites if c not in by_id]
        # a citation at the start of the next line often belongs to this one
        scope = " ".join(by_id[c] for c in cites + pending_cites if c in by_id)
        pending_cites = []
        body = CITE.sub(" ", sent)

        for u in URL.findall(body):
            checked += 1
            if u.rstrip(").,") not in fact_urls:
                unsupported.append({"type": "url", "claim": u, "sentence": sent})
        for mv in _moves(body):
            checked += 1
            if mv not in all_moves:
                unsupported.append({"type": "move", "claim": mv, "sentence": sent})
        for n in _numbers(body):
            checked += 1
            if scope and n in _numbers(scope):
                continue
            if n in all_nums:
                uncited.append({"claim": n, "sentence": sent})
            else:
                unsupported.append({"type": "number", "claim": n, "sentence": sent})

    n_bad = len(unsupported) + len(bad_cites)
    return {
        "checked": checked,
        "unsupported": unsupported,
        "uncited": uncited,
        "bad_citations": sorted(set(bad_cites)),
        "unsupported_rate": n_bad / checked if checked else 0.0,
        "ok": n_bad == 0,
    }


def feedback(report: dict) -> str:
    lines = []
    for u in report["unsupported"]:
        lines.append(f"- {u['type']} {u['claim']!r} is not in the facts "
                     f"(sentence: {u['sentence'][:120]!r})")
    for c in report["bad_citations"]:
        lines.append(f"- citation [{c}] does not exist")
    return "\n".join(lines)
