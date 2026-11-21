use std::{fmt, str::FromStr};

use crate::{BACK_RANKS, CASTLING, Color, Position, ROLES, Role, bit, rights_lost};

/// A malformed or inconsistent standard chess FEN.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParseFenError(&'static str);

impl fmt::Display for ParseFenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid FEN: {}", self.0)
    }
}

impl std::error::Error for ParseFenError {}

const PIECES: [u8; 6] = *b"pnbrqk";

pub(crate) fn piece_char(color: Color, role: Role) -> char {
    let piece = PIECES[role as usize];
    char::from(if color == Color::White {
        piece.to_ascii_uppercase()
    } else {
        piece
    })
}

pub(crate) fn write_square(f: &mut fmt::Formatter<'_>, square: u8) -> fmt::Result {
    write!(
        f,
        "{}{}",
        char::from(b'a' + square % 8),
        char::from(b'1' + square / 8)
    )
}

fn parse_square(text: &str) -> Option<u8> {
    match *text.as_bytes() {
        [file @ b'a'..=b'h', rank @ b'1'..=b'8'] => Some(8 * (rank - b'1') + file - b'a'),
        _ => None,
    }
}

impl FromStr for Position {
    type Err = ParseFenError;

    fn from_str(fen: &str) -> Result<Self, Self::Err> {
        let fields: Vec<_> = fen.split_ascii_whitespace().collect();
        let [board, turn, castling, ep, halfmove, fullmove] = fields.as_slice() else {
            return Err(ParseFenError("expected six fields"));
        };
        let mut pos = Self {
            pieces: [[0; 6]; 2],
            turn: match *turn {
                "w" => Color::White,
                "b" => Color::Black,
                _ => return Err(ParseFenError("side to move")),
            },
            castling: 0,
            en_passant: None,
            halfmove: halfmove
                .parse()
                .map_err(|_| ParseFenError("halfmove clock"))?,
            fullmove: fullmove
                .parse()
                .map_err(|_| ParseFenError("fullmove number"))?,
        };
        if pos.fullmove == 0 {
            return Err(ParseFenError("fullmove number must be positive"));
        }
        let ranks = board.split('/');
        if ranks.clone().count() != 8 {
            return Err(ParseFenError("expected eight ranks"));
        }
        for (rank, row) in (0..8).rev().zip(ranks) {
            let mut file = 0;
            for symbol in row.bytes() {
                if file >= 8 {
                    return Err(ParseFenError("rank exceeds eight squares"));
                }
                if (b'1'..=b'8').contains(&symbol) {
                    file += symbol - b'0';
                } else {
                    let color = if symbol.is_ascii_uppercase() {
                        Color::White
                    } else {
                        Color::Black
                    };
                    let role = PIECES
                        .iter()
                        .position(|&p| p == symbol.to_ascii_lowercase())
                        .ok_or(ParseFenError("unknown piece"))?;
                    pos.pieces[color as usize][role] |= bit(rank * 8 + file);
                    file += 1;
                }
            }
            if file != 8 {
                return Err(ParseFenError("rank must have eight squares"));
            }
        }
        for color in [Color::White, Color::Black] {
            if pos.pieces(color, Role::King).count_ones() != 1
                || pos.pieces(color, Role::Pawn) & BACK_RANKS != 0
            {
                return Err(ParseFenError(
                    "expected one king per side and no pawns on the back ranks",
                ));
            }
        }
        if *castling != "-" {
            for right in castling.chars() {
                let &(_, color, rook) = CASTLING
                    .iter()
                    .find(|&&(symbol, _, _)| symbol == right)
                    .ok_or(ParseFenError("unknown castling right"))?;
                let flag = rights_lost(rook);
                if pos.castling & flag != 0
                    || pos.king_square(color) != color.home_rank() + 4
                    || pos.pieces(color, Role::Rook) & bit(rook) == 0
                {
                    return Err(ParseFenError("inconsistent castling right"));
                }
                pos.castling |= flag;
            }
        }
        let enemy = pos.turn.other();
        let occupied = pos.occupied_by(pos.turn) | pos.occupied_by(enemy);
        if *ep != "-" {
            let target = parse_square(ep).ok_or(ParseFenError("en passant square"))?;
            let expected_rank = if pos.turn == Color::White { 5 } else { 2 };
            if target / 8 != expected_rank
                || occupied & (bit(target) | bit(pos.turn.forward(target))) != 0
                || pos.pieces(enemy, Role::Pawn) & bit(enemy.forward(target)) == 0
            {
                return Err(ParseFenError("inconsistent en passant square"));
            }
            pos.en_passant = Some(target);
        }
        if pos.is_attacked(pos.king_square(enemy), pos.turn, occupied) {
            return Err(ParseFenError("side waiting to move is in check"));
        }
        Ok(pos)
    }
}

impl fmt::Display for Position {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for rank in (0..8).rev() {
            if rank != 7 {
                write!(f, "/")?;
            }
            let mut empty = 0;
            for file in 0..8 {
                let square = bit(8 * rank + file);
                let piece = [Color::White, Color::Black].into_iter().find_map(|color| {
                    ROLES
                        .into_iter()
                        .find(|&role| self.pieces(color, role) & square != 0)
                        .map(|role| piece_char(color, role))
                });
                if let Some(piece) = piece {
                    if empty != 0 {
                        write!(f, "{empty}")?;
                        empty = 0;
                    }
                    write!(f, "{piece}")?;
                } else {
                    empty += 1;
                }
            }
            if empty != 0 {
                write!(f, "{empty}")?;
            }
        }
        write!(f, " {} ", if self.turn == Color::White { 'w' } else { 'b' })?;
        if self.castling == 0 {
            write!(f, "-")?;
        }
        for (symbol, _, rook) in CASTLING {
            if self.castling & rights_lost(rook) != 0 {
                write!(f, "{symbol}")?;
            }
        }
        write!(f, " ")?;
        if let Some(target) = self.en_passant {
            write_square(f, target)?;
        } else {
            write!(f, "-")?;
        }
        write!(f, " {} {}", self.halfmove, self.fullmove)
    }
}
