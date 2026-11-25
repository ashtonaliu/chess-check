"""Fetch and parse games from the Lichess public API. Mirrors web/src/browser/lichess.ts."""
from __future__ import annotations

import json
import math
import re
import threading
import time
from typing import Iterable

import chess
import chess.pgn
import requests

from .fetch import HEADERS, MAX_RETRY_WAIT, TRIES, Game, _retry_delay, opening_names

LICHESS_HOST = "https://lichess.org"
LICHESS_API = "https://lichess.org/api/games/user/{user}"
RATE_LIMIT_SECONDS = 60.0

SKIPPED_STATUSES = {"created", "started", "aborted", "noStart"}
FINISHED_STATUSES = {
    "mate",
    "resign",
    "stalemate",
    "timeout",
    "draw",
    "outoftime",
    "cheat",
    "unknownFinish",
    "insufficientMaterialClaim",
    "variantEnd",
}

_LICHESS_LOCK = threading.Lock()
_rate_limited_until = 0.0


class LichessRateLimitError(RuntimeError):
    """Raised when Lichess returns 429 or during the 60-second pause that follows."""


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _format_centiseconds(cs: int | float) -> str:
    s = max(0.0, float(cs)) / 100.0
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s % 60
    if sec == int(sec):
        sec_str = str(int(sec))
    else:
        sec_str = f"{sec:.2f}".rstrip("0").rstrip(".")
    pad = "0" if sec < 10 else ""
    return f"{h}:{m:02d}:{pad}{sec_str}"


def _map_speed(speed: object) -> str:
    if not isinstance(speed, str) or not speed:
        return ""
    return "daily" if speed == "correspondence" else speed


def _map_time_control(g: dict) -> str:
    clock = g.get("clock")
    if isinstance(clock, dict) and _is_number(clock.get("initial")) and _is_number(clock.get("increment")):
        return f"{clock['initial']}+{clock['increment']}"
    days = g.get("daysPerTurn")
    if _is_number(days) and days > 0:
        return f"1/{days * 86400}"
    return ""


def _map_result(status: str, winner: object, color: str) -> tuple[float, str, str, str]:
    if winner in ("white", "black"):
        if status == "mate":
            loser_reason = "checkmated"
        elif status == "resign":
            loser_reason = "resigned"
        elif status in ("timeout", "outoftime"):
            loser_reason = "timeout"
        else:
            loser_reason = status
        pgn_result = "1-0" if winner == "white" else "0-1"
        if winner == color:
            return 1.0, "win", loser_reason, pgn_result
        return 0.0, loser_reason, "win", pgn_result
    if status == "stalemate":
        draw_code = "stalemate"
    elif status == "insufficientMaterialClaim":
        draw_code = "insufficient"
    elif status in ("timeout", "outoftime"):
        draw_code = "timevsinsufficient"
    else:
        draw_code = "agreed"
    return 0.5, draw_code, draw_code, "1/2-1/2"


def _player_name(player: object) -> str:
    if isinstance(player, dict):
        user = player.get("user")
        if isinstance(user, dict):
            name = user.get("name") or user.get("id")
            if isinstance(name, str) and name:
                return name
    return "Anonymous"


def _matches_user(player: object, user_lower: str) -> bool:
    if not isinstance(player, dict):
        return False
    user = player.get("user")
    if not isinstance(user, dict):
        return False
    uid = user.get("id")
    uname = user.get("name")
    return (isinstance(uid, str) and uid.lower() == user_lower) or (
        isinstance(uname, str) and uname.lower() == user_lower
    )


def _opening_family(name: str) -> str:
    if not name or name == "Unknown":
        return "Unknown"
    slug = re.sub(r"\s+", "-", re.sub(r"[:,'\"]", "", name).strip())
    return opening_names(slug)[1]


def parse_lichess_game(obj: object, user: str) -> Game | None:
    """Map one Lichess JSON export to a Game from `user`'s view, or None if skipped."""
    if not isinstance(obj, dict):
        return None
    gid = obj.get("id")
    if not isinstance(gid, str) or not gid:
        return None
    variant = obj.get("variant")
    if isinstance(variant, str) and variant and variant.lower() != "standard":
        return None
    if obj.get("initialFen"):
        return None
    status = obj.get("status")
    if not isinstance(status, str) or status in SKIPPED_STATUSES or status not in FINISHED_STATUSES:
        return None

    players = obj.get("players")
    if not isinstance(players, dict):
        return None
    white = players.get("white")
    black = players.get("black")
    u = user.lower()
    if _matches_user(white, u):
        color, me, opp = "white", white, black
    elif _matches_user(black, u):
        color, me, opp = "black", black, white
    else:
        return None

    raw_moves = obj.get("moves")
    tokens = raw_moves.strip().split() if isinstance(raw_moves, str) else []
    clocks = obj.get("clocks") if isinstance(obj.get("clocks"), list) else []

    board = chess.Board()
    pg = chess.pgn.Game()
    node: chess.pgn.GameNode = pg
    sans: list[str] = []
    for i, tok in enumerate(tokens):
        try:
            mv = board.parse_san(tok)
        except ValueError:
            return None
        sans.append(board.san(mv))
        board.push(mv)
        node = node.add_variation(mv)
        if i < len(clocks) and _is_number(clocks[i]):
            node.comment = f"[%clk {_format_centiseconds(clocks[i])}]"

    score, my_result, opp_result, pgn_result = _map_result(status, obj.get("winner"), color)
    tc = _map_time_control(obj)
    opening_obj = obj.get("opening") if isinstance(obj.get("opening"), dict) else {}
    eco = opening_obj.get("eco") if isinstance(opening_obj.get("eco"), str) and opening_obj.get("eco") else "?"
    opening = (
        opening_obj.get("name")
        if isinstance(opening_obj.get("name"), str) and opening_obj.get("name")
        else "Unknown"
    )
    family = _opening_family(opening)

    url = f"{LICHESS_HOST}/game/{gid}"
    pg.headers["Site"] = url
    pg.headers["White"] = _player_name(white)
    pg.headers["Black"] = _player_name(black)
    pg.headers["Result"] = pgn_result
    white_rating = white.get("rating") if isinstance(white, dict) else None
    black_rating = black.get("rating") if isinstance(black, dict) else None
    if _is_number(white_rating):
        pg.headers["WhiteElo"] = str(int(white_rating))
    if _is_number(black_rating):
        pg.headers["BlackElo"] = str(int(black_rating))
    if eco != "?":
        pg.headers["ECO"] = eco
    if opening != "Unknown":
        pg.headers["Opening"] = opening
    if tc:
        pg.headers["TimeControl"] = tc

    exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=True)
    pgn_text = pg.accept(exporter)

    end_ms = obj.get("lastMoveAt")
    if not _is_number(end_ms):
        end_ms = obj.get("createdAt")
    end_time = int(end_ms // 1000) if _is_number(end_ms) else 0

    me_rating = me.get("rating") if isinstance(me, dict) else None
    opp_rating = opp.get("rating") if isinstance(opp, dict) else None

    return Game(
        url=url,
        color=color,
        my_rating=int(me_rating) if _is_number(me_rating) else 0,
        opp_rating=int(opp_rating) if _is_number(opp_rating) else 0,
        score=score,
        time_class=_map_speed(obj.get("speed")),
        eco=eco,
        opening=opening,
        family=family,
        end_time=end_time,
        time_control=tc,
        result=my_result,
        opp_result=opp_result,
        moves_san=sans,
        pgn=pgn_text,
        site="lichess",
    )


def _parse_ndjson_lines(lines: Iterable[str], user: str, limit: int | None = None) -> tuple[list[Game], int]:
    games: list[Game] = []
    skipped = 0
    for raw_line in lines:
        if isinstance(raw_line, bytes):
            raw_line = raw_line.decode("utf-8", errors="replace")
        line = raw_line.strip()
        if not line:
            continue
        try:
            parsed = parse_lichess_game(json.loads(line), user)
        except (ValueError, TypeError):
            skipped += 1
            continue
        if parsed is not None:
            games.append(parsed)
            if limit is not None and len(games) >= limit:
                break
        else:
            skipped += 1
    return games, skipped


def parse_lichess_ndjson(text: str, user: str) -> tuple[list[Game], int]:
    """Parse a Lichess NDJSON stream, skipping bad lines and filtered games."""
    return _parse_ndjson_lines(text.splitlines(), user)


def _lichess_get(session: requests.Session, url: str, params: dict[str, str | int]) -> requests.Response:
    global _rate_limited_until
    headers = {**HEADERS, "Accept": "application/x-ndjson"}
    for attempt in range(1, TRIES + 1):
        try:
            r = session.get(url, headers=headers, params=params, timeout=30, stream=True)
        except (requests.ConnectionError, requests.Timeout):
            if attempt == TRIES:
                raise
            time.sleep(float(attempt))
            continue
        if r.status_code == 429:
            _rate_limited_until = time.monotonic() + RATE_LIMIT_SECONDS
            if hasattr(r, "close"):
                r.close()
            raise LichessRateLimitError(
                "Lichess asked for a short pause; please try again in a minute."
            )
        if r.status_code >= 500 and attempt < TRIES:
            if hasattr(r, "close"):
                r.close()
            time.sleep(min(_retry_delay(r, attempt), MAX_RETRY_WAIT))
            continue
        return r
    raise AssertionError("unreachable")


def fetch_lichess_games(
    user: str,
    max_games: int = 150,
    time_class: str | None = None,
    session: requests.Session | None = None,
) -> list[Game]:
    """Fetch finished standard games for a Lichess user, one request at a time."""
    params: dict[str, str | int] = {
        "max": max_games,
        "clocks": "true",
        "opening": "true",
        "ongoing": "false",
        "finished": "true",
    }
    if time_class:
        params["perfType"] = "correspondence" if time_class == "daily" else time_class

    with _LICHESS_LOCK:
        if time.monotonic() < _rate_limited_until:
            raise LichessRateLimitError(
                "Lichess asked for a short pause; please try again in a minute."
            )
        s = session or requests.Session()
        r = _lichess_get(s, LICHESS_API.format(user=user), params)
        try:
            if r.status_code == 404:
                raise ValueError(f"No Lichess player named {user!r}")
            r.raise_for_status()
            lines = r.iter_lines(decode_unicode=True) if hasattr(r, "iter_lines") else r.text.splitlines()
            games, _ = _parse_ndjson_lines(lines, user, limit=max_games)
            return games
        finally:
            if hasattr(r, "close"):
                r.close()
