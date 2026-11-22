//! Batch boundaries for the browser. A replay advances one board and keeps its
//! positions in Rust so the later Stockfish responses can be formatted together.
mod pgn;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::{Color, MOVE_FEATURE_COUNT, Move, Position, Role, attacks, fen::parse_square};

const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

fn unpack<'a, T: Deserialize<'a>>(batch: &'a str) -> Result<T, JsError> {
    serde_json::from_str(batch).map_err(|err| JsError::new(&err.to_string()))
}

fn pack(value: &impl Serialize) -> Result<String, JsError> {
    serde_json::to_string(value).map_err(|err| JsError::new(&err.to_string()))
}

fn read_uci(moves: &[Move], uci: &str) -> Option<Move> {
    if !uci.is_ascii() || !(4..=5).contains(&uci.len()) {
        return None;
    }
    let from = parse_square(&uci[..2])?;
    let to = parse_square(&uci[2..4])?;
    let promotion = match uci.as_bytes().get(4) {
        None => None,
        Some(b'n') => Some(Role::Knight),
        Some(b'b') => Some(Role::Bishop),
        Some(b'r') => Some(Role::Rook),
        Some(b'q') => Some(Role::Queen),
        _ => return None,
    };
    moves
        .iter()
        .copied()
        .find(|m| m.from == from && m.to == to && m.promotion == promotion)
}

fn read_san(pos: &Position, moves: &[Move], san: &str) -> Option<Move> {
    let san = san.trim_end_matches(['#', '+', '!', '?']);
    let castle = match san {
        "O-O" | "0-0" => Some(2i16),
        "O-O-O" | "0-0-0" => Some(-2),
        _ => None,
    };
    if let Some(delta) = castle {
        return moves
            .iter()
            .copied()
            .find(|m| m.role == Role::King && i16::from(m.to) - i16::from(m.from) == delta);
    }
    if !san.is_ascii() {
        return None;
    }
    let (role, san) = match san.as_bytes().first()? {
        b'N' => (Role::Knight, &san[1..]),
        b'B' => (Role::Bishop, &san[1..]),
        b'R' => (Role::Rook, &san[1..]),
        b'Q' => (Role::Queen, &san[1..]),
        b'K' => (Role::King, &san[1..]),
        _ => (Role::Pawn, san),
    };
    let (san, promotion) = match san.as_bytes().last()? {
        letter @ (b'N' | b'B' | b'R' | b'Q') if role == Role::Pawn => {
            let promo = match letter {
                b'N' => Role::Knight,
                b'B' => Role::Bishop,
                b'R' => Role::Rook,
                _ => Role::Queen,
            };
            (san[..san.len() - 1].trim_end_matches('='), Some(promo))
        }
        _ => (san, None),
    };
    let (prefix, to) = san.split_at_checked(san.len().checked_sub(2)?)?;
    let to = parse_square(to)?;
    let capture = prefix.ends_with('x');
    let origin = prefix.strip_suffix('x').unwrap_or(prefix);
    let (file, rank) = match *origin.as_bytes() {
        [] => (None, None),
        [file @ b'a'..=b'h'] => (Some(file - b'a'), None),
        [rank @ b'1'..=b'8'] => (None, Some(rank - b'1')),
        [file @ b'a'..=b'h', rank @ b'1'..=b'8'] => (Some(file - b'a'), Some(rank - b'1')),
        _ => return None,
    };
    if role == Role::Pawn && ((capture && file.is_none()) || (!capture && !origin.is_empty())) {
        return None;
    }
    let opposing = pos.occupied_by(pos.turn.other());
    let mut found = moves.iter().copied().filter(|&m| {
        m.role == role
            && m.to == to
            && m.promotion == promotion
            && file.is_none_or(|file| m.from % 8 == file)
            && rank.is_none_or(|rank| m.from / 8 == rank)
            && pos.is_capture_move(m, opposing) == capture
    });
    let m = found.next()?;
    found.next().is_none().then_some(m)
}

fn format_uci(pos: &Position, uci: &str) -> Option<String> {
    read_uci(&pos.legal_moves(), uci).map(|m| pos.san(m))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PositionInfo {
    fen: String,
    turn: char,
    legal: usize,
    captures: usize,
    check: bool,
    balance: i32,
    non_pawn: i32,
    mate: bool,
    over: bool,
}

fn position_info(pos: &Position, moves: &[Move], repetitions: usize) -> PositionInfo {
    let enemy = pos.turn.other();
    let opposing = pos.occupied_by(enemy);
    let occupied = opposing | pos.occupied_by(pos.turn);
    let check = pos.is_attacked(pos.king_square(pos.turn), enemy, occupied);
    let (balance, non_pawn) = pos.material();
    let bishops = pos.pieces(Color::White, Role::Bishop) | pos.pieces(Color::Black, Role::Bishop);
    let knights = pos.pieces(Color::White, Role::Knight) | pos.pieces(Color::Black, Role::Knight);
    const LIGHT: u64 = 0x55aa55aa55aa55aa;
    let pieces = occupied.count_ones();
    let insufficient = pieces == 2
        || (pieces == 3 && (bishops | knights) != 0)
        || (pieces == bishops.count_ones() + 2 && (bishops & LIGHT == 0 || bishops & !LIGHT == 0));
    PositionInfo {
        fen: pos.to_string(),
        turn: if pos.turn == Color::White { 'w' } else { 'b' },
        legal: moves.len(),
        captures: moves
            .iter()
            .filter(|&&mv| pos.is_capture_move(mv, opposing))
            .count(),
        check,
        balance,
        non_pawn,
        mate: check && moves.is_empty(),
        over: moves.is_empty() || insufficient || pos.halfmove >= 100 || repetitions >= 3,
    }
}

#[derive(Serialize)]
struct Ply {
    #[serde(flatten)]
    info: PositionInfo,
    capture: bool,
}

#[wasm_bindgen]
pub struct GameReplay {
    positions: Vec<Position>,
    plies: Vec<Ply>,
}

#[wasm_bindgen]
impl GameReplay {
    #[wasm_bindgen(constructor)]
    pub fn new(fen: Option<String>, history: &str) -> Result<GameReplay, JsError> {
        Self::replay(fen.as_deref().unwrap_or(START), history)
            .ok_or_else(|| JsError::new("Unsupported FEN or SAN history"))
    }

    pub fn positions(&self) -> Result<String, JsError> {
        pack(&self.plies)
    }

    #[wasm_bindgen(js_name = "formatUci")]
    pub fn format_uci(&self, batch: &str) -> Result<String, JsError> {
        let ucis: Vec<Option<String>> = unpack(batch)?;
        if ucis.len() > self.positions.len() {
            return Err(JsError::new("More moves than positions in replay"));
        }
        pack(
            &ucis
                .into_iter()
                .zip(&self.positions)
                .map(|(uci, pos)| uci.and_then(|uci| format_uci(pos, &uci)))
                .collect::<Vec<_>>(),
        )
    }
}

impl GameReplay {
    fn replay(fen: &str, history: &str) -> Option<Self> {
        let mut pos: Position = fen.parse().ok()?;
        let mut positions = Vec::new();
        let mut plies = Vec::new();
        let mut counts = HashMap::new();
        let mut history = history.lines();
        loop {
            let ep = pos.en_passant.filter(|&sq| {
                positions.is_empty()
                    || attacks::pawn(pos.turn.other(), sq) & pos.pieces(pos.turn, Role::Pawn) != 0
            });
            let count = counts
                .entry((pos.pieces, pos.turn as u8, pos.castling, ep))
                .or_insert(0);
            *count += 1;
            let legal = pos.legal_moves();
            let mv = match history.next() {
                Some(san) => Some(read_san(&pos, &legal, san)?),
                None => None,
            };
            let capture =
                mv.is_some_and(|m| pos.is_capture_move(m, pos.occupied_by(pos.turn.other())));
            plies.push(Ply {
                info: position_info(&pos, &legal, *count),
                capture,
            });
            positions.push(pos);
            if let Some(m) = mv {
                pos.apply(m);
            } else {
                return Some(Self { positions, plies });
            }
        }
    }
}

#[derive(Deserialize)]
struct MoveAt {
    fen: String,
    #[serde(rename = "move")]
    chess_move: String,
}

#[wasm_bindgen(js_name = "positionBatch")]
pub fn position_batch(batch: &str) -> Result<String, JsError> {
    let fens: Vec<String> = unpack(batch)?;
    pack(
        &fens
            .into_iter()
            .map(|fen| {
                let pos: Position = fen.parse().ok()?;
                Some(position_info(&pos, &pos.legal_moves(), 1))
            })
            .collect::<Vec<_>>(),
    )
}

#[wasm_bindgen(js_name = "formatUciBatch")]
pub fn format_uci_batch(batch: &str) -> Result<String, JsError> {
    let moves: Vec<MoveAt> = unpack(batch)?;
    pack(
        &moves
            .into_iter()
            .map(|m| format_uci(&m.fen.parse().ok()?, &m.chess_move))
            .collect::<Vec<_>>(),
    )
}

#[wasm_bindgen(js_name = "advanceBatch")]
pub fn advance_batch(batch: &str) -> Result<String, JsError> {
    let moves: Vec<MoveAt> = unpack(batch)?;
    pack(
        &moves
            .into_iter()
            .map(|m| {
                let mut pos: Position = m.fen.parse().ok()?;
                let mv = read_san(&pos, &pos.legal_moves(), &m.chess_move)?;
                pos.apply(mv);
                Some(position_info(&pos, &pos.legal_moves(), 1))
            })
            .collect::<Vec<_>>(),
    )
}

#[wasm_bindgen(js_name = "moveFeaturesBatch")]
pub fn move_features_batch(batch: &str) -> Result<String, JsError> {
    let moves: Vec<MoveAt> = unpack(batch)?;
    let rows: Vec<Option<[i32; MOVE_FEATURE_COUNT]>> = moves
        .into_iter()
        .map(|m| {
            let pos: Position = m.fen.parse().ok()?;
            let legal = pos.legal_moves();
            let mv = read_uci(&legal, &m.chess_move)
                .or_else(|| read_san(&pos, &legal, &m.chess_move))?;
            Some(pos.move_features(mv).to_array())
        })
        .collect();
    pack(&rows)
}

#[wasm_bindgen(js_name = "parsePgnBatch")]
pub fn parse_pgn_batch(batch: &str) -> Result<String, JsError> {
    let games: Vec<String> = unpack(batch)?;
    pack(&games.iter().map(|pgn| pgn::parse(pgn)).collect::<Vec<_>>())
}
