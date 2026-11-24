use std::fmt::Write as _;

use crate::{Color, Move, Position, Role, bit, fen, squares};

fn square_str(out: &mut String, square: u8) {
    out.push(char::from(b'a' + square % 8));
    out.push(char::from(b'1' + square / 8));
}

impl Position {
    /// Format a legal move from this position in Standard Algebraic Notation (SAN).
    /// The caller must pass a move generated for the current position.
    pub fn san(&self, mv: Move) -> String {
        let mut out = String::with_capacity(8);
        let color = self.turn;
        let enemy = color.other();
        let opposing = self.occupied_by(enemy);

        if mv.role == Role::King && mv.from.abs_diff(mv.to) == 2 {
            out.push_str(if mv.to > mv.from { "O-O" } else { "O-O-O" });
        } else if mv.role == Role::Pawn {
            let is_capture = mv.from % 8 != mv.to % 8;
            if is_capture {
                out.push(char::from(b'a' + mv.from % 8));
                out.push('x');
            }
            square_str(&mut out, mv.to);
            if let Some(promo) = mv.promotion {
                let _ = write!(out, "={}", fen::piece_char(Color::White, promo));
            }
        } else {
            out.push(fen::piece_char(Color::White, mv.role));
            if mv.role != Role::King && self.pieces(color, mv.role).count_ones() > 1 {
                let occupied = self.occupied_by(color) | opposing;
                // Knight, bishop, rook and queen attacks are symmetric, so reverse lookups from
                // the destination find every other same-role piece that can pseudo-legally reach it.
                let candidates = self.targets(mv.role, mv.to, 0, occupied)
                    & self.pieces(color, mv.role)
                    & !bit(mv.from);
                let mut ambiguous = 0u64;
                for from in squares(candidates) {
                    let alt = Move {
                        from,
                        to: mv.to,
                        role: mv.role,
                        promotion: None,
                    };
                    if self.is_legal_by_copy(alt) {
                        ambiguous |= bit(from);
                    }
                }
                if ambiguous != 0 {
                    let from_file = mv.from % 8;
                    let from_rank = mv.from / 8;
                    let same_file = squares(ambiguous).any(|sq| sq % 8 == from_file);
                    let same_rank = squares(ambiguous).any(|sq| sq / 8 == from_rank);
                    if !same_file {
                        out.push(char::from(b'a' + from_file));
                    } else if !same_rank {
                        out.push(char::from(b'1' + from_rank));
                    } else {
                        square_str(&mut out, mv.from);
                    }
                }
            }
            if opposing & bit(mv.to) != 0 {
                out.push('x');
            }
            square_str(&mut out, mv.to);
        }

        let mut next = *self;
        next.apply(mv);
        let occupied = next.occupied_by(Color::White) | next.occupied_by(Color::Black);
        if next.is_attacked(next.king_square(enemy), color, occupied) {
            if !next.has_any_legal_move() {
                out.push('#');
            } else {
                out.push('+');
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn san_for_uci(fen: &str, uci: &str) -> String {
        let pos: Position = fen.parse().unwrap();
        let mv = pos
            .legal_moves()
            .into_iter()
            .find(|mv| mv.to_string() == uci)
            .unwrap_or_else(|| panic!("move {uci} not legal in {fen}"));
        pos.san(mv)
    }

    #[test]
    fn san_handles_disambiguation_pins_and_special_moves() {
        // File disambiguation: two knights can reach d2.
        assert_eq!(
            san_for_uci("4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1", "b1d2"),
            "Nbd2"
        );
        assert_eq!(
            san_for_uci("4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1", "f3d2"),
            "Nfd2"
        );
        // Rank disambiguation: two rooks on the a-file can reach a4.
        assert_eq!(
            san_for_uci("R7/7k/8/8/8/8/8/R3K3 w - - 0 1", "a1a4"),
            "R1a4"
        );
        assert_eq!(
            san_for_uci("R7/7k/8/8/8/8/8/R3K3 w - - 0 1", "a8a4"),
            "R8a4"
        );
        // Both file and rank disambiguation: three queens can reach e5.
        assert_eq!(
            san_for_uci("8/8/7k/Q7/8/8/8/Q3Q2K w - - 0 1", "a1e5"),
            "Qa1e5"
        );
        assert_eq!(
            san_for_uci("8/8/7k/Q7/8/8/8/Q3Q2K w - - 0 1", "a5e5"),
            "Q5e5"
        );
        assert_eq!(
            san_for_uci("8/8/7k/Q7/8/8/8/Q3Q2K w - - 0 1", "e1e5"),
            "Qee5"
        );
        // Pinned second knight cannot legally move, so no disambiguation is emitted.
        assert_eq!(
            san_for_uci("4k3/8/8/8/8/4r3/4N3/2N1K3 w - - 0 1", "c1d3"),
            "Nd3"
        );
        // En passant capture with check.
        assert_eq!(
            san_for_uci("8/8/8/3pP1k1/8/8/8/4K3 w - d6 0 1", "e5d6"),
            "exd6"
        );
        assert_eq!(
            san_for_uci("8/4k3/8/3pP3/8/8/8/4K3 w - d6 0 1", "e5d6"),
            "exd6+"
        );
        // Promotions and capturing promotions with check and mate.
        assert_eq!(
            san_for_uci("3r3k/4P3/8/8/8/8/8/4K3 w - - 0 1", "e7d8q"),
            "exd8=Q+"
        );
        assert_eq!(
            san_for_uci("3r3k/4P3/8/8/8/8/8/4K3 w - - 0 1", "e7e8n"),
            "e8=N"
        );
        assert_eq!(
            san_for_uci("6k1/4Pppp/8/8/8/8/8/4K3 w - - 0 1", "e7e8q"),
            "e8=Q#"
        );
        // Castling, including castling with check and mate.
        assert_eq!(
            san_for_uci("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", "e1g1"),
            "O-O"
        );
        assert_eq!(
            san_for_uci("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", "e1c1"),
            "O-O-O"
        );
        assert_eq!(
            san_for_uci("5k2/8/8/8/8/8/8/R3K2R w KQ - 0 1", "e1g1"),
            "O-O+"
        );
        assert_eq!(
            san_for_uci("3k4/2p1p3/8/8/8/8/8/R3K2R w KQ - 0 1", "e1c1"),
            "O-O-O+"
        );
        assert_eq!(
            san_for_uci("2rkr3/2p1p3/8/8/8/8/8/R3K2R w KQ - 0 1", "e1c1"),
            "O-O-O#"
        );
    }
}
