"""Read-only DuckDB features for the v1 engine Parquet dataset.

Register the temporary views and table macros on a DuckDB connection, or use
EngineDataset as a context manager. Cutoffs are Unix seconds in UTC and are
exclusive. A NULL player in the SQL macros selects all players.
"""
from pathlib import Path

import chess
import duckdb

from .engine import BLUNDER_DROP, OPENING_PLIES, PIECE_VALUES
from .fetch import DRAW_RESULTS

DEFAULT_ROOT = Path(__file__).resolve().parents[1] / "data" / "engine" / "v1"
WINNING_CP = 300
CRITICAL_GAP = 20
LOW_CLOCK = 0.10


def _literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _parquet(root: Path, directory: str) -> str:
    pattern = _literal(str(root / directory / "part-*.parquet"))
    return f"read_parquet({pattern}, union_by_name=true, filename='_dataset_file')"


# Each metric carries its own denominator. The second aggregation pools the
# underlying moves or games, rather than averaging per-game averages.
MOVE_METRICS = {
    "win_pct_loss": ("loss", "true"),
    **{f"{phase}_win_pct_loss": ("loss", f"phase = '{phase}'")
       for phase in ("opening", "middlegame", "endgame")},
    "critical_best_move_rate": ("found_best", "critical"),
    "easy_best_move_rate": ("found_best", "NOT critical"),
    "critical_time_spent": ("time_spent", "critical AND time_spent >= 0"),
    "easy_time_spent": ("time_spent", "NOT critical AND time_spent >= 0"),
    "low_clock_win_pct_loss": ("loss", f"clock_before >= 0 AND clock_before < {LOW_CLOCK} * base_seconds"),
    "depth10_blunder_rate": ("depth10_blunder", "loss IS NOT NULL"),
    "confirmed_blunder_rate": (f"deep_loss >= {BLUNDER_DROP}", "depth10_blunder"),
}


def _move_aggregates() -> str:
    return ",\n".join(
        f"""coalesce(sum(({value})::DOUBLE) FILTER (WHERE {condition}), 0) AS {name}_sum,
            count({value}) FILTER (WHERE {condition}) AS {name}_n"""
        for name, (value, condition) in MOVE_METRICS.items()
    )


def _rates(*, pooled: bool) -> str:
    def column(name):
        return f"sum({name})" if pooled else name

    return ",\n".join(
        f"{column(name + '_sum')} / nullif({column(name + '_n')}, 0) AS {name}, "
        f"{column(name + '_n')} AS {name}_n"
        for name in (*MOVE_METRICS, "conversion", "resilience")
    )


def register_views(connection: duckdb.DuckDBPyConnection, root: str | Path = DEFAULT_ROOT) -> None:
    """Install temporary readers and cutoff-aware SQL functions on a connection."""
    root = Path(root).resolve()
    draws = ", ".join(_literal(result) for result in sorted(DRAW_RESULTS))
    material = " + ".join(
        f"{PIECE_VALUES[piece]} * (length(p.placement) - length(translate(p.placement, '{symbols}', '')))"
        for piece, symbols in ((chess.KNIGHT, "Nn"), (chess.BISHOP, "Bb"), (chess.ROOK, "Rr"), (chess.QUEEN, "Qq"))
    )
    connection.execute(f"""
        CREATE OR REPLACE TEMP VIEW _dataset_games AS
        SELECT *, parse_filename(_dataset_file) AS shard FROM {_parquet(root, "games")};

        CREATE OR REPLACE TEMP VIEW _dataset_positions AS
        SELECT *, parse_filename(_dataset_file) AS shard FROM {_parquet(root, "positions")};

        CREATE OR REPLACE TEMP VIEW _dataset_player_index AS
        SELECT shard, game_id, run_id, start_ts, end_ts, time_class, time_control,
               base_seconds, side.color, lower(side.username) AS player,
               lower(side.opponent) AS opponent, side.rating_after, side.result,
               CASE WHEN side.result = 'win' THEN 1.0
                    WHEN side.result IN ({draws}) THEN 0.5
                    WHEN side.result IS NOT NULL THEN 0.0 END::DOUBLE AS score
        FROM _dataset_games
        CROSS JOIN LATERAL (VALUES
            ('white', white, black, white_rating_after, white_result),
            ('black', black, white, black_rating_after, black_result)
        ) AS side(color, username, opponent, rating_after, result);

        -- Native SQL form of chesscheck.engine.win_pct for columnar execution.
        CREATE OR REPLACE TEMP MACRO _dataset_win_pct(cp) AS
            (50.0 + 50.0 * (2.0 / (1.0 + exp(-0.00368208 * cp)) - 1.0));

        CREATE OR REPLACE TEMP MACRO _dataset_score(cp, mate, terminal, mover) AS
            CASE WHEN terminal = 'checkmate' THEN CASE WHEN mover = 'white' THEN -3000 ELSE 3000 END
                 WHEN terminal IS NOT NULL THEN 0
                 WHEN mate IS NOT NULL THEN CASE WHEN mate > 0 THEN 3000 ELSE -3000 END
                 ELSE cp END;

        CREATE OR REPLACE TEMP MACRO dataset_pregame_rating(username, cutoff_ts, game_class := 'blitz') AS TABLE
            SELECT player, game_id AS previous_game_id, end_ts AS previous_end_ts, rating_after AS pregame_rating
            FROM _dataset_player_index
            WHERE player = lower(username) AND time_class = game_class AND end_ts > 0 AND end_ts < cutoff_ts
            ORDER BY end_ts DESC, game_id DESC LIMIT 1;

        CREATE OR REPLACE TEMP MACRO _dataset_move_stats(username, cutoff_ts, game_class) AS TABLE
        WITH eligible AS (
            SELECT * FROM _dataset_player_index
            WHERE (username IS NULL OR player = lower(username))
              AND (game_class IS NULL OR time_class = game_class)
              AND end_ts > 0 AND end_ts < cutoff_ts
        ), scored AS (
            SELECT p.shard, p.game_id, p.run_id, p.ply, p.mover, p.move_uci, p.best_uci, p.second_uci,
                   p.clock_after, p.time_spent, split_part(p.fen, ' ', 1) AS placement,
                   _dataset_score(p.cp, p.mate, p.terminal, p.mover) AS cp,
                   _dataset_score(p.second_cp, p.second_mate, NULL, p.mover) AS second,
                   _dataset_score(p.deep_cp, p.deep_mate, p.terminal, p.mover) AS deep_cp
            FROM _dataset_positions p
            SEMI JOIN eligible e USING (shard, game_id, run_id)
        ), positions AS (
            SELECT *, lead(ply) OVER game_order AS next_ply,
                   lead(cp) OVER game_order AS next_cp,
                   lead(deep_cp) OVER game_order AS next_deep_cp,
                   lag(clock_after) OVER (
                       PARTITION BY shard, game_id, run_id, mover ORDER BY ply
                   ) AS previous_clock
            FROM scored
            WINDOW game_order AS (PARTITION BY shard, game_id, run_id ORDER BY ply)
        ), move_context AS (
            SELECT e.*, p.ply, p.move_uci, p.best_uci, p.second_uci, p.time_spent,
                   CASE WHEN p.ply < {OPENING_PLIES} THEN 'opening'
                        WHEN {material} <= 26
                        THEN 'endgame' ELSE 'middlegame' END AS phase,
                   CASE WHEN p.ply < 2 THEN nullif(e.base_seconds, 0) ELSE p.previous_clock END AS clock_before,
                   CASE WHEN e.color = 'white' THEN 1 ELSE -1 END AS sign,
                   p.cp * sign AS before_cp, p.next_cp * sign AS after_cp,
                   p.deep_cp * sign AS deep_before_cp, p.next_deep_cp * sign AS deep_after_cp,
                   p.second * sign AS second_cp
            FROM positions p
            JOIN eligible e ON (p.shard, p.game_id, p.run_id, p.mover) =
                               (e.shard, e.game_id, e.run_id, e.color)
            WHERE p.move_uci IS NOT NULL AND p.next_ply = p.ply + 1
        ), moves AS (
            SELECT *,
                   _dataset_win_pct(before_cp) - _dataset_win_pct(after_cp) AS raw_loss,
                   CASE WHEN raw_loss IS NOT NULL THEN greatest(raw_loss, 0) END AS loss,
                   _dataset_win_pct(deep_before_cp) - _dataset_win_pct(deep_after_cp) AS deep_loss,
                   CASE WHEN best_uci IS NOT NULL AND second_uci IS NOT NULL
                        THEN _dataset_win_pct(before_cp) - _dataset_win_pct(second_cp) >= {CRITICAL_GAP}
                   END AS critical,
                   move_uci = best_uci AS found_best,
                   raw_loss >= {BLUNDER_DROP} AS depth10_blunder
            FROM move_context
        ), totals AS (
            SELECT shard, game_id, run_id, color, count(*) AS moves,
                   {_move_aggregates()},
                   count(*) FILTER (WHERE depth10_blunder AND deep_loss < {BLUNDER_DROP}) AS shallow_only_blunders,
                   count(*) FILTER (WHERE depth10_blunder AND deep_loss IS NULL) AS unchecked_blunders,
                   bool_or(greatest(before_cp, after_cp) >= {WINNING_CP}) AS reached_winning,
                   bool_or(least(before_cp, after_cp) <= -{WINNING_CP}) AS reached_losing
            FROM moves GROUP BY shard, game_id, run_id, color
        ), game_features AS (
            SELECT e.*, coalesce(t.moves, 0) AS moves,
                   {", ".join(f"coalesce(t.{name}_{suffix}, 0) AS {name}_{suffix}"
                              for name in MOVE_METRICS for suffix in ("sum", "n"))},
                   coalesce(t.shallow_only_blunders, 0) AS shallow_only_blunders,
                   coalesce(t.unchecked_blunders, 0) AS unchecked_blunders,
                   t.reached_winning, t.reached_losing,
                   coalesce((t.reached_winning IS TRUE AND e.score = 1)::INTEGER, 0) AS conversion_sum,
                   (t.reached_winning IS TRUE AND e.score IS NOT NULL)::INTEGER AS conversion_n,
                   coalesce((t.reached_losing IS TRUE AND e.score > 0)::INTEGER, 0) AS resilience_sum,
                   (t.reached_losing IS TRUE AND e.score IS NOT NULL)::INTEGER AS resilience_n
            FROM eligible e LEFT JOIN totals t USING (shard, game_id, run_id, color)
        ), prior_ratings AS (
            SELECT player, time_class, end_ts, rating_after, game_id
            FROM _dataset_player_index
            WHERE end_ts > 0 AND end_ts < cutoff_ts
              AND (username IS NULL OR player = lower(username))
              AND (game_class IS NULL OR time_class = game_class)
            QUALIFY row_number() OVER (PARTITION BY player, time_class, end_ts ORDER BY game_id DESC) = 1
        )
        SELECT g.*, p.rating_after AS pregame_rating, p.game_id AS previous_game_id
        FROM game_features g ASOF LEFT JOIN prior_ratings p
          ON g.player = p.player AND g.time_class IS NOT DISTINCT FROM p.time_class AND g.start_ts > p.end_ts;

        CREATE OR REPLACE TEMP MACRO dataset_player_games(username, cutoff_ts, game_class := 'blitz') AS TABLE
            SELECT game_id, run_id, player, opponent, color, start_ts, end_ts, time_class, time_control,
                   score, pregame_rating, previous_game_id, moves, reached_winning, reached_losing,
                   depth10_blunder_rate_sum::BIGINT AS depth10_blunders,
                   confirmed_blunder_rate_sum::BIGINT AS confirmed_blunders,
                   shallow_only_blunders, unchecked_blunders, {_rates(pooled=False)}
            FROM _dataset_move_stats(username, cutoff_ts, game_class);

        CREATE OR REPLACE TEMP MACRO dataset_player_features(username, cutoff_ts, game_class := 'blitz') AS TABLE
            SELECT player, time_class, count(*) AS games, sum(moves) AS moves,
                   first(rating_after ORDER BY end_ts DESC, game_id DESC) AS pregame_rating,
                   sum(depth10_blunder_rate_sum)::BIGINT AS depth10_blunders,
                   sum(confirmed_blunder_rate_sum)::BIGINT AS confirmed_blunders,
                   sum(shallow_only_blunders) AS shallow_only_blunders,
                   sum(unchecked_blunders) AS unchecked_blunders, {_rates(pooled=True)}
            FROM _dataset_move_stats(username, cutoff_ts, game_class)
            GROUP BY player, time_class;
    """)


class EngineDataset:
    """Open an in-memory DuckDB connection backed by the read-only shards."""

    def __init__(self, root: str | Path = DEFAULT_ROOT, *, threads: int = 1):
        self.connection = duckdb.connect(config={"threads": threads})
        try:
            register_views(self.connection, root)
        except Exception:
            self.connection.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.connection.close()

    def player_games(self, player: str | None, cutoff: int, *, time_class: str | None = "blitz"):
        return self.connection.sql("SELECT * FROM dataset_player_games(?, ?, ?)",
                                   params=[player, cutoff, time_class])

    def player_features(self, player: str | None, cutoff: int, *, time_class: str | None = "blitz"):
        return self.connection.sql("SELECT * FROM dataset_player_features(?, ?, ?)",
                                   params=[player, cutoff, time_class])

    def pregame_rating(self, player: str, cutoff: int, *, time_class: str = "blitz") -> int | None:
        rows = self.connection.execute(
            "SELECT pregame_rating FROM dataset_pregame_rating(?, ?, ?)",
            [player, cutoff, time_class],
        ).fetchall()
        return rows[0][0] if rows else None
