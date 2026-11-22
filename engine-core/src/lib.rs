//! Native move generation for standard chess.

mod attacks;
mod features;
mod fen;
mod san;
mod tactics;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub use features::{BOARD_PLANES, MOVE_FEATURE_COUNT, MoveFeatures};
pub use fen::ParseFenError;
pub use tactics::{MOTIF_NAMES, Motifs};
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

    fn attackers(&self, square: u8, by: Color, occupied: u64) -> u64 {
        let [pawns, knights, bishops, rooks, queens, king] = self.pieces[by as usize];
        let index = square as usize;
        attacks::pawn(by.other(), square) & pawns
            | attacks::KNIGHT[index] & knights
            | attacks::KING[index] & king
            | attacks::bishop(square, occupied) & (bishops | queens)
            | attacks::rook(square, occupied) & (rooks | queens)
    }

    /// The pseudo-legal targets of a non-king piece, without en passant.
    fn targets(&self, role: Role, from: u8, opposing: u64, occupied: u64) -> u64 {
        let color = self.turn;
        match role {
            Role::Pawn => {
                let mut targets = attacks::pawn(color, from) & opposing;
                let ahead = color.forward(from);
                if bit(ahead) & occupied == 0 {
                    targets |= bit(ahead);
                    let start_rank = if color == Color::White { 1 } else { 6 };
                    if from / 8 == start_rank {
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
        }
    }

    fn push_moves(moves: &mut Vec<Move>, role: Role, from: u8, targets: u64) {
        for to in squares(targets) {
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

    /// Play the move on a copy and check that it does not leave the mover's king attacked.
    fn is_legal_by_copy(&self, mv: Move) -> bool {
        let mut next = *self;
        next.apply(mv);
        let occupied = next.occupied_by(Color::White) | next.occupied_by(Color::Black);
        !next.is_attacked(next.king_square(self.turn), self.turn.other(), occupied)
    }

    /// Pawn captures onto the en passant target that do not expose the king.
    fn en_passant_moves(&self) -> impl Iterator<Item = Move> + '_ {
        let target = self.en_passant;
        let pawns = target.map_or(0, |target| {
            attacks::pawn(self.turn.other(), target) & self.pieces(self.turn, Role::Pawn)
        });
        squares(pawns).filter_map(move |from| {
            let mv = Move {
                from,
                to: target?,
                role: Role::Pawn,
                promotion: None,
            };
            self.is_legal_by_copy(mv).then_some(mv)
        })
    }

    fn has_legal_en_passant(&self) -> bool {
        self.en_passant_moves().next().is_some()
    }

    /// Generate all legal moves, including the four promotion choices.
    pub fn legal_moves(&self) -> Vec<Move> {
        let color = self.turn;
        let enemy = color.other();
        let own = self.occupied_by(color);
        let opposing = self.occupied_by(enemy);
        let occupied = own | opposing;
        let king = self.king_square(color);
        let mut moves = Vec::with_capacity(48);

        // Remove the king from the board so a slider's attack continues past its square.
        let without_king = occupied & !bit(king);
        let king_targets = squares(attacks::KING[king as usize] & !own)
            .filter(|&to| !self.is_attacked(to, enemy, without_king))
            .fold(0, |all, to| all | bit(to));
        Self::push_moves(&mut moves, Role::King, king, king_targets);

        let checkers = self.attackers(king, enemy, occupied);
        if checkers.count_ones() > 1 {
            return moves;
        }
        // In check, another piece must capture the checker or block its line.
        let evasions = if checkers == 0 {
            !0
        } else {
            checkers | attacks::between(king, checkers.trailing_zeros() as u8)
        };

        // A sniper sees the king through our own pieces. One of ours alone in between is pinned.
        let [_, _, bishops, rooks, queens, _] = self.pieces[enemy as usize];
        let snipers = attacks::rook(king, opposing) & (rooks | queens)
            | attacks::bishop(king, opposing) & (bishops | queens);
        let pinned = squares(snipers)
            .map(|sniper| attacks::between(king, sniper) & occupied)
            .filter(|blockers| blockers.count_ones() == 1 && blockers & own != 0)
            .fold(0, |all, blocker| all | blocker);

        for role in [
            Role::Pawn,
            Role::Knight,
            Role::Bishop,
            Role::Rook,
            Role::Queen,
        ] {
            for from in squares(self.pieces(color, role)) {
                let mut targets = self.targets(role, from, opposing, occupied) & !own & evasions;
                if pinned & bit(from) != 0 {
                    // A pinned piece can only move along the ray from the king through it.
                    targets &= attacks::ray(king, from);
                }
                Self::push_moves(&mut moves, role, from, targets);
            }
        }
        // En passant removes two pawns from one rank, which can expose the king along it.
        moves.extend(self.en_passant_moves());
        if checkers == 0 {
            self.castles(occupied, &mut moves);
        }
        moves
    }

    /// The previous generator: every pseudo-legal move, kept if the king is safe afterward.
    #[cfg(test)]
    fn legal_moves_by_copy(&self) -> Vec<Move> {
        let opposing = self.occupied_by(self.turn.other());
        let occupied = self.occupied_by(self.turn) | opposing;
        let mut moves = Vec::new();
        for role in ROLES {
            for from in squares(self.pieces(self.turn, role)) {
                let targets = self.targets(role, from, opposing, occupied);
                Self::push_moves(
                    &mut moves,
                    role,
                    from,
                    targets & !self.occupied_by(self.turn),
                );
            }
        }
        if let Some(target) = self.en_passant {
            for from in squares(
                attacks::pawn(self.turn.other(), target) & self.pieces(self.turn, Role::Pawn),
            ) {
                Self::push_moves(&mut moves, Role::Pawn, from, bit(target));
            }
        }
        self.castles(occupied, &mut moves);
        moves.retain(|&mv| self.is_legal_by_copy(mv));
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
            // The destination is checked on the current board. Along the back rank, the king
            // blocks its own square now and the moved rook blocks it after castling.
            if self.castling & rights_lost(base + rook_file) != 0
                && occupied & (clear << base) == 0
                && !self.is_attacked(base + transit, enemy, occupied & !bit(from))
                && !self.is_attacked(base + destination, enemy, occupied)
            {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(mut moves: Vec<Move>) -> Vec<String> {
        moves.sort_unstable_by_key(|mv| (mv.from, mv.to, mv.promotion.map(|role| role as u8)));
        moves.iter().map(Move::to_string).collect()
    }

    #[test]
    fn mask_generator_matches_copy_and_test_in_random_games() {
        let starts: Vec<Position> = include_str!("../tests/perft.txt")
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(|line| line.split(" | ").nth(1).unwrap().parse().unwrap())
            .collect();
        let mut rng = 0x2545_f491_4f6c_dd1du64;
        let mut positions = 0;
        for game in 0..2048 {
            let mut pos = starts[game % starts.len()];
            for _ in 0..256 {
                let fast = pos.legal_moves();
                assert_eq!(
                    sorted(fast.clone()),
                    sorted(pos.legal_moves_by_copy()),
                    "{pos}"
                );
                positions += 1;
                if fast.is_empty() {
                    break;
                }
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                let _ = pos.make_move(fast[(rng % fast.len() as u64) as usize]);
            }
        }
        assert!(positions > 300_000, "{positions}");
    }

    #[test]
    fn hard_cases_match_copy_and_test() {
        for fen in [
            // En passant would expose the king along the rank.
            "8/8/8/K2pP2r/8/8/8/7k w - d6 0 1",
            // Double check leaves only king moves.
            "4k3/8/8/8/1b6/8/8/r3K3 w - - 0 1",
            // A pinned rook may slide along the pin and capture the pinner.
            "4k3/4r3/8/8/8/8/4R3/4K3 w - - 0 1",
            // The checking pawn can be taken en passant.
            "8/8/8/2k5/3Pp3/8/8/4K3 b - d3 0 1",
            // Castling may not end on an attacked square.
            "4k3/8/8/8/8/8/6r1/R3K2R w KQ - 0 1",
            // An attacked b1 does not stop queenside castling.
            "1r2k3/8/8/8/8/8/8/R3K2R w KQ - 0 1",
        ] {
            let pos: Position = fen.parse().unwrap();
            assert_eq!(
                sorted(pos.legal_moves()),
                sorted(pos.legal_moves_by_copy()),
                "{fen}"
            );
        }
        let moves = |fen: &str| sorted(fen.parse::<Position>().unwrap().legal_moves());
        assert!(!moves("8/8/8/K2pP2r/8/8/8/7k w - d6 0 1").contains(&"e5d6".into()));
        assert!(
            moves("4k3/8/8/8/1b6/8/8/r3K3 w - - 0 1")
                .iter()
                .all(|mv| mv.starts_with("e1"))
        );
        assert!(moves("8/8/8/2k5/3Pp3/8/8/4K3 b - d3 0 1").contains(&"e4d3".into()));
        let castles = moves("4k3/8/8/8/8/8/6r1/R3K2R w KQ - 0 1");
        assert!(castles.contains(&"e1c1".into()) && !castles.contains(&"e1g1".into()));
        assert!(moves("1r2k3/8/8/8/8/8/8/R3K2R w KQ - 0 1").contains(&"e1c1".into()));
    }

    #[test]
    fn fen_names_en_passant_only_when_a_capture_is_legal() {
        for (input, output) in [
            // No pawn can capture.
            (
                "4k3/8/8/3p4/8/8/8/4K3 w - d6 0 1",
                "4k3/8/8/3p4/8/8/8/4K3 w - - 0 1",
            ),
            // The only capturing pawn is pinned to its king.
            (
                "k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
                "k3r3/8/8/3pP3/8/8/8/4K3 w - - 0 1",
            ),
            // A legal capture keeps the target.
            (
                "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
                "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
            ),
        ] {
            let pos: Position = input.parse().unwrap();
            assert_eq!(pos.to_string(), output);
            let reparsed: Position = output.parse().unwrap();
            assert_eq!(reparsed.to_string(), output);
            assert_eq!(sorted(reparsed.legal_moves()), sorted(pos.legal_moves()));
        }
    }
}
