"""Fetch games from the Chess.com public API and normalize them into rows."""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field

import chess.pgn
import requests

API = "https://api.chess.com/pub/player/{user}/games/archives"
HEADERS = {"User-Agent": "weakness-finder/0.1 (portfolio project)"}

DRAW_RESULTS = {"agreed", "repetition", "stalemate", "insufficient",
                "50move", "timevsinsufficient"}

# Words that end an opening "family" name in Chess.com's ECO URLs,
# e.g. Sicilian-Defense-Najdorf-Variation -> "Sicilian Defense".
FAMILY_ENDINGS = {"Defense", "Opening", "Game", "Gambit", "Attack", "System"}

# Canonical families, so that "Closed Sicilian" and "Alapin Sicilian Defense"
# both count as the Sicilian.
CANONICAL = [
    ("Nimzo Indian", "Nimzo-Indian Defense"), ("Bogo Indian", "Bogo-Indian Defense"),
    ("Queens Indian", "Queen's Indian Defense"), ("Kings Indian Attack", "King's Indian Attack"),
    ("Kings Indian", "King's Indian Defense"), ("Sicilian", "Sicilian Defense"),
    ("French", "French Defense"), ("Caro Kann", "Caro-Kann Defense"),
    ("Semi Slav", "Semi-Slav Defense"), ("Slav", "Slav Defense"),
    ("Queens Gambit", "Queen's Gambit"), ("Kings Gambit", "King's Gambit"),
    ("Queens Pawn", "Queen's Pawn Opening"), ("Kings Pawn", "King's Pawn Opening"),
    ("English", "English Opening"), ("Reti", "Reti Opening"),
    ("Ruy Lopez", "Ruy Lopez"), ("Italian", "Italian Game"), ("Giuoco", "Italian Game"),
    ("Two Knights", "Italian Game"), ("Scotch", "Scotch Game"), ("Vienna", "Vienna Game"),
    ("Four Knights", "Four Knights Game"), ("Petrov", "Petrov's Defense"), ("Petrovs", "Petrov's Defense"),
    ("Philidor", "Philidor Defense"), ("Pirc", "Pirc Defense"), ("Modern", "Modern Defense"),
    ("Scandinavian", "Scandinavian Defense"), ("Alekhine", "Alekhine's Defense"), ("Alekhines", "Alekhine's Defense"),
    ("London", "London System"), ("Colle", "Colle System"), ("Catalan", "Catalan Opening"),
    ("Grunfeld", "Grunfeld Defense"), ("Dutch", "Dutch Defense"), ("Benoni", "Benoni Defense"),
    ("Benko", "Benko Gambit"), ("Nimzowitsch Larsen", "Nimzowitsch-Larsen Attack"),
    ("Bishops Opening", "Bishop's Opening"), ("Center Game", "Center Game"),
    ("Owens", "Owen's Defense"), ("Indian", "Indian Game"),
]


@dataclass
class Game:
    url: str
    color: str            # "white" | "black" (the user's color)
    my_rating: int
    opp_rating: int
    score: float          # 1, 0.5, 0 from the user's perspective
    time_class: str
    eco: str
    opening: str          # full opening name
    family: str           # opening family, e.g. "Sicilian Defense"
    end_time: int
    time_control: str = ""
    result: str = ""          # Chess.com result code for the user, e.g. "timeout"
    opp_result: str = ""      # ...and for the opponent ("win", "resigned", ...)
    moves_san: list[str] = field(default_factory=list)
    pgn: str = ""


def opening_names(eco_url: str) -> tuple[str, str]:
    """Return (full name, family) from a Chess.com ECO URL slug."""
    slug = eco_url.rstrip("/").rsplit("/", 1)[-1] if eco_url else ""
    tokens = []
    for tok in filter(None, slug.split("-")):
        if re.search(r"\d", tok):  # move sequence like 2...d6 starts here
            break
        tokens.append(tok)
    if not tokens:
        return "Unknown", "Unknown"
    full = " ".join(tokens)
    # The family named first wins ("Four Knights Game Scotch Variation" is a
    # Four Knights game; "Nimzowitsch Larsen Attack Modern Variation" is not a
    # Modern Defense); on a tie, the longer (more specific) name.
    hits = [(f" {full} ".find(f" {key} "), -len(key), canon) for key, canon in CANONICAL
            if f" {key} " in f" {full} "]
    if hits:
        return full, min(hits)[2]
    for i, tok in enumerate(tokens[:5]):
        if tok in FAMILY_ENDINGS:
            return full, " ".join(tokens[: i + 1])
    return full, " ".join(tokens[:2])


def _score(result: str) -> float:
    if result == "win":
        return 1.0
    if result in DRAW_RESULTS:
        return 0.5
    return 0.0


def parse_game(raw: dict, user: str) -> Game | None:
    if raw.get("rules") != "chess" or "pgn" not in raw:
        return None
    if raw["white"]["username"].lower() == user.lower():
        color, me, opp = "white", raw["white"], raw["black"]
    elif raw["black"]["username"].lower() == user.lower():
        color, me, opp = "black", raw["black"], raw["white"]
    else:
        return None
    pg = chess.pgn.read_game(io.StringIO(raw["pgn"]))
    if pg is None:
        return None
    board = pg.board()
    sans = []
    for mv in pg.mainline_moves():
        sans.append(board.san(mv))
        board.push(mv)
    full, family = opening_names(raw.get("eco") or pg.headers.get("ECOUrl", ""))
    return Game(
        url=raw["url"], color=color, my_rating=me["rating"],
        opp_rating=opp["rating"], score=_score(me["result"]),
        time_class=raw.get("time_class", ""), eco=pg.headers.get("ECO", "?"),
        opening=full, family=family, end_time=raw.get("end_time", 0),
        time_control=raw.get("time_control", ""),
        result=me.get("result", ""), opp_result=opp.get("result", ""),
        moves_san=sans, pgn=raw["pgn"],
    )


def fetch_games(user: str, max_games: int = 300,
                time_classes: set[str] | None = None,
                session: requests.Session | None = None) -> list[Game]:
    """Most recent games first, up to max_games."""
    s = session or requests.Session()
    r = s.get(API.format(user=user.lower()), headers=HEADERS, timeout=20)
    if r.status_code == 404:
        raise ValueError(f"No Chess.com player named {user!r}")
    r.raise_for_status()
    games: list[Game] = []
    for month_url in reversed(r.json().get("archives", [])):
        m = s.get(month_url, headers=HEADERS, timeout=30)
        m.raise_for_status()
        for raw in sorted(m.json().get("games", []),
                          key=lambda g: g.get("end_time", 0), reverse=True):
            g = parse_game(raw, user)
            if g and (not time_classes or g.time_class in time_classes):
                games.append(g)
                if len(games) >= max_games:
                    return games
    return games
