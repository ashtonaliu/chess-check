//! Native move generation for standard chess.

mod attacks;
mod fen;

pub use fen::ParseFenError;
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Color {
    White,
    Black,
}

impl Color {
    fn other(self) -> Self {
        match self {
            Self::White => Self::Black,
            Self::Black => Self::White,
        }
    }

    fn forward(self, square: u8) -> u8 {
        match self {
            Self::White => square + 8,
            Self::Black => square - 8,
        }
    }

    fn home_rank(self) -> u8 {
        self as u8 * 56
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Pawn,
    Knight,
    Bishop,
    Rook,
    Queen,
    King,
}

const ROLES: [Role; 6] = [
    Role::Pawn,
    Role::Knight,
    Role::Bishop,
    Role::Rook,
    Role::Queen,
    Role::King,
];
const PROMOTIONS: [Role; 4] = [Role::Knight, Role::Bishop, Role::Rook, Role::Queen];
const BACK_RANKS: u64 = 0xff00_0000_0000_00ff;

// Castling rights in FEN order, with each rook's home square.
const CASTLING: [(char, Color, u8); 4] = [
    ('K', Color::White, 7),
    ('Q', Color::White, 0),
    ('k', Color::Black, 63),
    ('q', Color::Black, 56),
];

const fn rights_lost(square: u8) -> u8 {
    match square {
        7 => 0b0001,
        0 => 0b0010,
        4 => 0b0011,
        63 => 0b0100,
        56 => 0b1000,
        60 => 0b1100,
        _ => 0,
    }
}

const fn bit(square: u8) -> u64 {
    1 << square
}

fn squares(mut mask: u64) -> impl Iterator<Item = u8> {
    std::iter::from_fn(move || {
        if mask == 0 {
            return None;
        }
        let square = mask.trailing_zeros() as u8;
        mask &= mask - 1;
        Some(square)
    })
}

/// A legal move returned by [`Position::legal_moves`]. Its display form is standard UCI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Move {
    from: u8,
    to: u8,
    role: Role,
    promotion: Option<Role>,
}

impl fmt::Display for Move {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fen::write_square(f, self.from)?;
        fen::write_square(f, self.to)?;
        if let Some(role) = self.promotion {
            write!(f, "{}", fen::piece_char(Color::Black, role))?;
        }
        Ok(())
    }
}

/// A standard chess position, parsed from a six-field FEN.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    // Bit 0 is a1, bit 7 is h1, and bit 63 is h8.
    pieces: [[u64; 6]; 2],
    turn: Color,
    castling: u8,
    en_passant: Option<u8>,
    halfmove: u32,
    fullmove: u32,
}

/// The board and its metadata immediately before a move.
#[must_use]
pub struct Undo(Position);

impl Position {
    fn pieces(&self, color: Color, role: Role) -> u64 {
        self.pieces[color as usize][role as usize]
    }

    fn occupied_by(&self, color: Color) -> u64 {
        self.pieces[color as usize]
            .iter()
            .fold(0, |all, mask| all | mask)
    }

    fn king_square(&self, color: Color) -> u8 {
        self.pieces(color, Role::King).trailing_zeros() as u8
    }

    fn is_attacked(&self, square: u8, by: Color, occupied: u64) -> bool {
        let [pawns, knights, bishops, rooks, queens, king] = self.pieces[by as usize];
        let index = square as usize;
        attacks::pawn(by.other(), square) & pawns != 0
            || attacks::KNIGHT[index] & knights != 0
            || attacks::KING[index] & king != 0
            || attacks::bishop(square, occupied) & (bishops | queens) != 0
            || attacks::rook(square, occupied) & (rooks | queens) != 0
    }

    /// Generate all legal moves, including the four promotion choices.
    pub fn legal_moves(&self) -> Vec<Move> {
        let color = self.turn;
        let enemy = color.other();
        let pawn_start_rank = if color == Color::White { 1 } else { 6 };
        let own = self.occupied_by(color);
        let opposing = self.occupied_by(enemy);
        let occupied = own | opposing;
        let mut moves = Vec::with_capacity(48);
        for role in ROLES {
            for from in squares(self.pieces(color, role)) {
                let targets = match role {
                    Role::Pawn => {
                        let captures = opposing | self.en_passant.map_or(0, bit);
                        let mut targets = attacks::pawn(color, from) & captures;
                        let ahead = color.forward(from);
                        if bit(ahead) & occupied == 0 {
                            targets |= bit(ahead);
                            if from / 8 == pawn_start_rank {
                                targets |= bit(color.forward(ahead)) & !occupied;
                            }
                        }
                        targets
                    }
                    Role::Knight => attacks::KNIGHT[from as usize],
                    Role::Bishop => attacks::bishop(from, occupied),
                    Role::Rook => attacks::rook(from, occupied),
                    Role::Queen => attacks::bishop(from, occupied) | attacks::rook(from, occupied),
                    Role::King => attacks::KING[from as usize],
                };
                for to in squares(targets & !own) {
                    let mv = Move {
                        from,
                        to,
                        role,
                        promotion: None,
                    };
                    if role == Role::Pawn && bit(to) & BACK_RANKS != 0 {
                        moves.extend(PROMOTIONS.map(|role| Move {
                            promotion: Some(role),
                            ..mv
                        }));
                    } else {
                        moves.push(mv);
                    }
                }
            }
        }
        self.castles(occupied, &mut moves);
        moves.retain(|&mv| {
            let mut next = *self;
            next.apply(mv);
            !next.is_attacked(
                next.king_square(color),
                enemy,
                next.occupied_by(color) | next.occupied_by(enemy),
            )
        });
        moves
    }

    fn castles(&self, occupied: u64, moves: &mut Vec<Move>) {
        if self.castling & (0b11 << (self.turn as u8 * 2)) == 0 {
            return;
        }
        let base = self.turn.home_rank();
        let from = base + 4;
        let enemy = self.turn.other();
        if self.is_attacked(from, enemy, occupied) {
            return;
        }
        for (rook_file, transit, destination, clear) in
            [(0, 3, 2, 0b0000_1110u64), (7, 5, 6, 0b0110_0000)]
        {
            if self.castling & rights_lost(base + rook_file) != 0
                && occupied & (clear << base) == 0
                && !self.is_attacked(base + transit, enemy, occupied & !bit(from))
            {
                // The final king square is checked with the rook in its new place.
                moves.push(Move {
                    from,
                    to: base + destination,
                    role: Role::King,
                    promotion: None,
                });
            }
        }
    }

    /// Play a move from this position's legal move list and save the previous state.
    /// The caller must use a move generated for the current position.
    pub fn make_move(&mut self, mv: Move) -> Undo {
        let undo = Undo(*self);
        self.apply(mv);
        undo
    }

    /// Restore the state saved by the corresponding call to [`Self::make_move`].
    pub fn unmake_move(&mut self, undo: Undo) {
        *self = undo.0;
    }

    fn apply(&mut self, mv: Move) {
        let color = self.turn;
        let enemy = color.other();
        let capture_square = if mv.role == Role::Pawn && self.en_passant == Some(mv.to) {
            enemy.forward(mv.to)
        } else {
            mv.to
        };
        let mut captured = false;
        for mask in &mut self.pieces[enemy as usize] {
            if *mask & bit(capture_square) != 0 {
                *mask &= !bit(capture_square);
                captured = true;
                break;
            }
        }

        let own = &mut self.pieces[color as usize];
        own[mv.role as usize] &= !bit(mv.from);
        own[mv.promotion.unwrap_or(mv.role) as usize] |= bit(mv.to);
        if mv.role == Role::King && mv.from.abs_diff(mv.to) == 2 {
            let rook_from = color.home_rank() + if mv.to > mv.from { 7 } else { 0 };
            own[Role::Rook as usize] ^= bit(rook_from) | bit(mv.from.midpoint(mv.to));
        }

        self.castling &= !(rights_lost(mv.from) | rights_lost(mv.to));
        self.en_passant = (mv.role == Role::Pawn && mv.from.abs_diff(mv.to) == 16)
            .then(|| color.forward(mv.from));
        self.halfmove = if mv.role == Role::Pawn || captured {
            0
        } else {
            self.halfmove.saturating_add(1)
        };
        self.fullmove = self
            .fullmove
            .saturating_add(u32::from(color == Color::Black));
        self.turn = enemy;
    }
}
