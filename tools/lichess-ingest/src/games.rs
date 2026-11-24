use std::ops::ControlFlow;

use chrono::NaiveDateTime;
use pgn_reader::{RawComment, RawTag, Skip, Visitor};
use shakmaty::{
    CastlingMode, Chess, Color, EnPassantMode, Outcome, Position, fen::Fen, san::SanPlus,
};
use xxhash_rust::xxh3::xxh3_64;

use lichess_ingest::parquet::table;

table! {
    Game {
        game_id: String, url: String, white: String, black: String,
        white_rating_before: i32, black_rating_before: i32,
        white_rating_after: i32, black_rating_after: i32,
        time_control: String, base_seconds: i32, increment_seconds: i32,
        time_class: String, start_ts: i64, eco: String, opening: String,
        result: String, termination: String, plies: i32, source: String,
        exclusion: String, position_sampled: bool,
    }
}

table! {
    MoveRow {
        game_id: String, ply: i32, fen: String, mover: String,
        move_uci: String, move_san: String, clock_after: i32, time_spent: i32,
        eval_cp: i32, eval_mate: i32, source: String,
        best_uci: String, second_uci: String, cp: i32, mate: i32, second_cp: i32, second_mate: i32,
    }
}

#[derive(Default)]
pub struct Tags {
    site: Option<String>,
    game_id: Option<String>,
    time_control: Option<String>,
    utc_date: Option<String>,
    utc_time: Option<String>,
    white_elo: Option<i32>,
    black_elo: Option<i32>,
    white_rating_diff: Option<i32>,
    black_rating_diff: Option<i32>,
    variant: Option<String>,
    white_title_bot: bool,
    black_title_bot: bool,
    fen: Option<String>,
    white_berserk: bool,
    black_berserk: bool,
    white: Option<String>,
    black: Option<String>,
    eco: Option<String>,
    opening: Option<String>,
    result: Option<String>,
    termination: Option<String>,
}

pub struct GameReader {
    pub modulus: u64,
    pub bucket: u64,
}

pub struct Movetext {
    game: Game,
    board: Option<Chess>,
    positions: Vec<MoveRow>,
    plies: i32,
    clock: bool,
    broken: bool,
    result: Option<Outcome>,
    berserk: [bool; 2],
}

impl Visitor for GameReader {
    type Tags = Tags;
    type Movetext = Movetext;
    type Output = (Game, Vec<MoveRow>);

    fn begin_tags(&mut self) -> ControlFlow<Self::Output, Tags> {
        ControlFlow::Continue(Tags::default())
    }

    fn tag(
        &mut self,
        tags: &mut Tags,
        name: &[u8],
        value: RawTag<'_>,
    ) -> ControlFlow<Self::Output> {
        let parse_i32 = || std::str::from_utf8(value.as_bytes()).ok()?.parse().ok();
        let decode = || value.decode_utf8_lossy().into_owned();
        match name {
            b"Site" => tags.site = Some(decode()),
            b"GameId" => tags.game_id = Some(decode()),
            b"TimeControl" => tags.time_control = Some(decode()),
            b"UTCDate" => tags.utc_date = Some(decode()),
            b"UTCTime" => tags.utc_time = Some(decode()),
            b"WhiteElo" => tags.white_elo = parse_i32(),
            b"BlackElo" => tags.black_elo = parse_i32(),
            b"WhiteRatingDiff" => tags.white_rating_diff = parse_i32(),
            b"BlackRatingDiff" => tags.black_rating_diff = parse_i32(),
            b"Variant" => tags.variant = Some(decode()),
            b"WhiteTitle" => tags.white_title_bot = value.as_bytes() == b"BOT",
            b"BlackTitle" => tags.black_title_bot = value.as_bytes() == b"BOT",
            b"FEN" => tags.fen = Some(decode()),
            b"WhiteBerserk" => tags.white_berserk = true,
            b"BlackBerserk" => tags.black_berserk = true,
            b"White" => tags.white = Some(decode()),
            b"Black" => tags.black = Some(decode()),
            b"ECO" => tags.eco = Some(decode()),
            b"Opening" => tags.opening = Some(decode()),
            b"Result" => tags.result = Some(decode()),
            b"Termination" => tags.termination = Some(decode()),
            _ => (),
        }
        ControlFlow::Continue(())
    }

    fn begin_movetext(&mut self, tags: Tags) -> ControlFlow<Self::Output, Movetext> {
        let url = tags.site;
        let game_id = tags
            .game_id
            .filter(|id| valid_id(id))
            .or_else(|| {
                let id = url.as_deref()?.rsplit('/').next()?;
                valid_id(id).then(|| id.to_owned())
            });
        let time_control = tags.time_control;
        let clock = time_control.as_deref().and_then(time_control_seconds);
        let start_ts = tags
            .utc_date
            .as_deref()
            .zip(tags.utc_time.as_deref())
            .and_then(|(date, time)| {
                NaiveDateTime::parse_from_str(&format!("{date} {time}"), "%Y.%m.%d %H:%M:%S").ok()
            })
            .map(|date| date.and_utc().timestamp());
        let white_rating_before = tags.white_elo;
        let black_rating_before = tags.black_elo;
        let white_rating_after = white_rating_before
            .zip(tags.white_rating_diff)
            .and_then(|(before, diff)| before.checked_add(diff));
        let black_rating_after = black_rating_before
            .zip(tags.black_rating_diff)
            .and_then(|(before, diff)| before.checked_add(diff));
        let exclusion = if game_id.is_none() {
            Some("missing_id")
        } else if matches!(tags.variant.as_deref(), Some(variant) if !variant.eq_ignore_ascii_case("standard"))
        {
            Some("nonstandard")
        } else if tags.white_title_bot || tags.black_title_bot {
            Some("bot")
        } else if clock.is_none() {
            Some("nonclocked")
        } else {
            None
        };
        let sampled = exclusion.is_none()
            && game_id
                .as_ref()
                .is_some_and(|id| xxh3_64(id.as_bytes()) % self.modulus == self.bucket);
        let board = sampled
            .then(|| match tags.fen.as_deref() {
                Some(fen) => fen
                    .parse::<Fen>()
                    .ok()?
                    .into_position(CastlingMode::Standard)
                    .ok(),
                None => Some(Chess::default()),
            })
            .flatten();
        let berserk = [tags.black_berserk, tags.white_berserk];
        let game = Game {
            game_id,
            url,
            start_ts,
            time_control,
            white_rating_before,
            black_rating_before,
            white_rating_after,
            black_rating_after,
            white: tags.white,
            black: tags.black,
            base_seconds: clock.map(|(base, _)| base),
            increment_seconds: clock.map(|(_, inc)| inc),
            time_class: clock.map(|(base, inc)| time_class(base, inc).into()),
            eco: tags.eco,
            opening: tags.opening,
            result: tags.result,
            termination: tags.termination,
            source: Some("lichess".into()),
            exclusion: exclusion.map(str::to_owned),
            ..Game::default()
        };
        ControlFlow::Continue(Movetext {
            game,
            broken: sampled && board.is_none(),
            board,
            positions: Vec::new(),
            plies: 0,
            clock: false,
            result: None,
            berserk,
        })
    }

    fn san(&mut self, state: &mut Movetext, san: SanPlus) -> ControlFlow<Self::Output> {
        let ply = state.plies;
        state.plies += 1;
        if let Some(board) = state.board.as_mut() {
            if let Ok(mv) = san.san.to_move(board) {
                let mut row = position_row(&state.game, board, ply);
                row.move_san = Some(SanPlus::from_move_and_play_unchecked(board, mv).to_string());
                row.move_uci = Some(mv.to_uci(CastlingMode::Standard).to_string());
                state.positions.push(row);
            } else {
                state.broken = true;
                state.board = None;
            }
        }
        ControlFlow::Continue(())
    }

    fn begin_variation(&mut self, _: &mut Movetext) -> ControlFlow<Self::Output, Skip> {
        ControlFlow::Continue(Skip(true))
    }

    fn comment(
        &mut self,
        state: &mut Movetext,
        comment: RawComment<'_>,
    ) -> ControlFlow<Self::Output> {
        if state.plies == 0 || (state.clock && state.board.is_none()) {
            return ControlFlow::Continue(());
        }
        let Ok(comment) = std::str::from_utf8(comment.as_bytes()) else {
            return ControlFlow::Continue(());
        };
        let clock = marker(comment, "[%clk ").and_then(clock_seconds);
        state.clock |= clock.is_some();
        if state.board.is_some() && !state.positions.is_empty() {
            let ply = state.positions.len() - 1;
            let previous = ply
                .checked_sub(2)
                .and_then(|i| state.positions[i].clock_after);
            let row = &mut state.positions[ply];
            if let Some(clock) = clock {
                row.clock_after = Some(clock);
                let white = row.mover.as_deref() == Some("white");
                if !state.berserk[usize::from(white)] {
                    row.time_spent = previous
                        .zip(state.game.increment_seconds)
                        .and_then(|(before, inc)| before.checked_add(inc)?.checked_sub(clock))
                        .filter(|seconds| *seconds >= 0);
                }
            }
            if let Some(eval) = marker(comment, "[%eval ") {
                if let Some(mate) = eval.strip_prefix('#') {
                    row.eval_mate = mate.parse().ok();
                } else if let Ok(pawns) = eval.parse::<f64>() {
                    let cp = (pawns * 100.0).round();
                    if cp.is_finite() && cp.abs() <= i32::MAX as f64 {
                        row.eval_cp = Some(cp as i32);
                    }
                }
            }
        }
        ControlFlow::Continue(())
    }

    fn outcome(&mut self, state: &mut Movetext, result: Outcome) -> ControlFlow<Self::Output> {
        state.result = Some(result);
        ControlFlow::Continue(())
    }

    fn end_game(&mut self, mut state: Movetext) -> Self::Output {
        let mut game = state.game;
        game.plies = Some(state.plies);
        let outcome = state.result.map(|result| result.to_string());
        if game.exclusion.is_none() {
            game.exclusion = if game.termination.as_deref() == Some("Abandoned")
                || outcome.as_deref() == Some("*")
            {
                Some("unfinished")
            } else if state.broken
                || outcome.is_none()
                || (game.result.is_some() && game.result != outcome)
            {
                Some("malformed")
            } else if !state.clock {
                Some("clockless")
            } else {
                None
            }
            .map(str::to_owned);
        }
        game.result = game.result.or(outcome);
        let keep = game.exclusion.is_none() && state.board.is_some();
        game.position_sampled = Some(keep);
        if keep {
            let board = state.board.as_ref().expect("sampled game has a board");
            state
                .positions
                .push(position_row(&game, board, state.plies));
        } else {
            state.positions.clear();
        }
        (game, state.positions)
    }
}

fn position_row(game: &Game, board: &Chess, ply: i32) -> MoveRow {
    MoveRow {
        game_id: game.game_id.clone(),
        ply: Some(ply),
        fen: Some(Fen::from_position(board, EnPassantMode::Legal).to_string()),
        mover: Some(
            if board.turn() == Color::White {
                "white"
            } else {
                "black"
            }
            .into(),
        ),
        source: Some("lichess".into()),
        ..MoveRow::default()
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 8 && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn time_control_seconds(value: &str) -> Option<(i32, i32)> {
    let (base, inc) = value.split_once('+')?;
    let (base, inc): (i32, i32) = (base.parse().ok()?, inc.parse().ok()?);
    (base >= 0 && inc >= 0 && (base > 0 || inc > 0)).then_some((base, inc))
}

fn time_class(base: i32, inc: i32) -> &'static str {
    match i64::from(base) + 40 * i64::from(inc) {
        ..=29 => "ultraBullet",
        30..=179 => "bullet",
        180..=479 => "blitz",
        480..=1499 => "rapid",
        _ => "classical",
    }
}

fn marker<'a>(comment: &'a str, key: &str) -> Option<&'a str> {
    Some(comment.split_once(key)?.1.split_once(']')?.0.trim())
}

fn clock_seconds(value: &str) -> Option<i32> {
    let (hours, rest) = value.split_once(':')?;
    let (minutes, seconds) = rest.split_once(':')?;
    let (hours, minutes, seconds): (i32, i32, i32) = (
        hours.parse().ok()?,
        minutes.parse().ok()?,
        seconds.parse().ok()?,
    );
    if hours < 0 || !(0..60).contains(&minutes) || !(0..60).contains(&seconds) {
        return None;
    }
    hours.checked_mul(3600)?.checked_add(minutes * 60 + seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replays_castling_en_passant_and_promotion_and_reads_annotations() {
        let pgn = r#"[Site "https://lichess.org/01234567"]
[TimeControl "480+0"]
[FEN "r3k2r/1P6/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1"]
[Result "1-0"]

1. exd6 { [%clk 0:08:00] [%eval 1.23] } O-O (1... Kf8)
2. b8=Q { [%clk 0:07:55] } Raxb8 3. O-O-O { [%eval #2] } 1-0
"#;
        let mut reader = pgn_reader::Reader::new(pgn.as_bytes());
        let (game, rows) = reader
            .read_game(&mut GameReader {
                modulus: 1,
                bucket: 0,
            })
            .unwrap()
            .unwrap();
        assert_eq!(game.time_class.as_deref(), Some("rapid"));
        assert_eq!(rows.len(), 6);
        assert_eq!(rows[0].move_uci.as_deref(), Some("e5d6"));
        assert_eq!(rows[1].move_uci.as_deref(), Some("e8g8"));
        assert_eq!(rows[2].move_uci.as_deref(), Some("b7b8q"));
        assert_eq!(rows[4].move_uci.as_deref(), Some("e1c1"));
        assert_eq!(rows[0].eval_cp, Some(123));
        assert_eq!(rows[2].eval_cp, None);
        assert_eq!(rows[4].eval_mate, Some(2));
        assert_eq!(rows[2].time_spent, Some(5));
        assert_eq!(rows[5].move_uci, None);
    }

    #[test]
    fn counts_illegal_and_clockless_games_and_keeps_their_metadata() {
        let pgn = r#"[Site "https://lichess.org/01234567"]
[TimeControl "180+2"]

1. e5 { [%clk 0:03:00] } 1-0

[Site "https://lichess.org/01234568"]
[TimeControl "180+2"]

1. e4 e5 0-1
"#;
        let games: Vec<_> = pgn_reader::Reader::new(pgn.as_bytes())
            .read_games(&mut GameReader {
                modulus: 1,
                bucket: 0,
            })
            .map(Result::unwrap)
            .collect();
        assert_eq!(games.len(), 2);
        assert_eq!(games[0].0.exclusion.as_deref(), Some("malformed"));
        assert_eq!(games[1].0.exclusion.as_deref(), Some("clockless"));
        assert!(games.iter().all(|(_, positions)| positions.is_empty()));
    }
}
