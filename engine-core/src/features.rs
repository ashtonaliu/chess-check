use crate::{Color, Move, Position, ROLES, Role, attacks, bit, squares};

/// Number of handcrafted move features returned by [`Position::move_features`].
pub const MOVE_FEATURE_COUNT: usize = 16;

/// Number of 8x8 planes returned by [`Position::encode_board`] and [`Position::encode_board_planes`].
pub const BOARD_PLANES: usize = 21;

const PIECE_VALUES: [i32; 6] = [1, 3, 3, 5, 9, 0];

/// The 16 handcrafted find-rate move features, in the exact order of Python's `move_features`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MoveFeatures {
    pub piece: i32,
    pub is_capture: i32,
    pub captured_value: i32,
    pub gives_check: i32,
    pub is_promotion: i32,
    pub is_castle: i32,
    pub backward: i32,
    pub sideways: i32,
    pub was_attacked: i32,
    pub lands_attacked: i32,
    pub in_check: i32,
    pub legal_moves: i32,
    pub captures_available: i32,
    pub checks_available: i32,
    pub material_balance: i32,
    pub non_pawn_material: i32,
}

impl MoveFeatures {
    /// Return all 16 features in the canonical order of Python's `move_features`.
    pub fn to_array(self) -> [i32; MOVE_FEATURE_COUNT] {
        [
            self.piece,
            self.is_capture,
            self.captured_value,
            self.gives_check,
            self.is_promotion,
            self.is_castle,
            self.backward,
            self.sideways,
            self.was_attacked,
            self.lands_attacked,
            self.in_check,
            self.legal_moves,
            self.captures_available,
            self.checks_available,
            self.material_balance,
            self.non_pawn_material,
        ]
    }
}

impl Position {
    fn piece_role_at(&self, color: Color, square: u8) -> Option<Role> {
        let mask = bit(square);
        ROLES
            .into_iter()
            .find(|&role| self.pieces(color, role) & mask != 0)
    }

    fn is_capture_move(&self, mv: Move, opposing: u64) -> bool {
        opposing & bit(mv.to) != 0 || (mv.role == Role::Pawn && self.en_passant == Some(mv.to))
    }

    fn move_gives_check(&self, mv: Move) -> bool {
        let mut next = *self;
        next.apply(mv);
        let occupied = next.occupied_by(Color::White) | next.occupied_by(Color::Black);
        next.is_attacked(next.king_square(self.turn.other()), self.turn, occupied)
    }

    /// All squares attacked by `color`'s pieces, including defended pieces and pinned pieces.
    fn side_attacks(&self, color: Color, occupied: u64) -> u64 {
        let [pawns, knights, bishops, rooks, queens, king] = self.pieces[color as usize];
        let mut mask = 0u64;
        for sq in squares(pawns) {
            mask |= attacks::pawn(color, sq);
        }
        for sq in squares(knights) {
            mask |= attacks::KNIGHT[sq as usize];
        }
        for sq in squares(bishops | queens) {
            mask |= attacks::bishop(sq, occupied);
        }
        for sq in squares(rooks | queens) {
            mask |= attacks::rook(sq, occupied);
        }
        for sq in squares(king) {
            mask |= attacks::KING[sq as usize];
        }
        mask
    }

    /// Compute the 16 find-rate move features for a legal move from this position.
    /// The caller must pass a move generated for the current position.
    pub fn move_features(&self, mv: Move) -> MoveFeatures {
        let me = self.turn;
        let enemy = me.other();
        let own = self.occupied_by(me);
        let opposing = self.occupied_by(enemy);
        let occupied = own | opposing;

        let captured_role = if mv.role == Role::Pawn && self.en_passant == Some(mv.to) {
            Some(Role::Pawn)
        } else {
            self.piece_role_at(enemy, mv.to)
        };

        let from_rank = (mv.from / 8) as i32;
        let to_rank = (mv.to / 8) as i32;
        let forward = if me == Color::White {
            to_rank - from_rank
        } else {
            from_rank - to_rank
        };

        let was_attacked = self.is_attacked(mv.from, enemy, occupied);
        let in_check = self.is_attacked(self.king_square(me), enemy, occupied);

        let mut after = *self;
        after.apply(mv);
        let after_occupied = after.occupied_by(Color::White) | after.occupied_by(Color::Black);
        let gives_check = after.is_attacked(after.king_square(enemy), me, after_occupied);
        let lands_attacked = after.is_attacked(mv.to, enemy, after_occupied);

        let legal = self.legal_moves();
        let mut captures_available = 0i32;
        let mut checks_available = 0i32;
        for &m in &legal {
            if self.is_capture_move(m, opposing) {
                captures_available += 1;
            }
            if self.move_gives_check(m) {
                checks_available += 1;
            }
        }

        let mut material_balance = 0i32;
        let mut non_pawn_material = 0i32;
        for role in ROLES {
            let value = PIECE_VALUES[role as usize];
            let own_count = self.pieces(me, role).count_ones() as i32;
            let enemy_count = self.pieces(enemy, role).count_ones() as i32;
            material_balance += value * (own_count - enemy_count);
            if !matches!(role, Role::Pawn | Role::King) {
                non_pawn_material += value * (own_count + enemy_count);
            }
        }

        MoveFeatures {
            piece: mv.role as i32 + 1,
            is_capture: i32::from(captured_role.is_some()),
            captured_value: captured_role.map_or(0, |role| PIECE_VALUES[role as usize]),
            gives_check: i32::from(gives_check),
            is_promotion: i32::from(mv.promotion.is_some()),
            is_castle: i32::from(mv.role == Role::King && mv.from.abs_diff(mv.to) == 2),
            backward: i32::from(forward < 0),
            sideways: i32::from(forward == 0),
            was_attacked: i32::from(was_attacked),
            lands_attacked: i32::from(lands_attacked),
            in_check: i32::from(in_check),
            legal_moves: legal.len() as i32,
            captures_available,
            checks_available,
            material_balance,
            non_pawn_material,
        }
    }

    /// Encode the position and a legal best move as 21 bitboard planes from the mover's perspective.
    /// Bit `sq` (0..64) of plane `p` matches `encode_board(fen, best)[p, sq / 8, sq % 8]` in Python.
    pub fn encode_board_planes(&self, mv: Move) -> [u64; BOARD_PLANES] {
        let me = self.turn;
        let enemy = me.other();
        let occupied = self.occupied_by(Color::White) | self.occupied_by(Color::Black);
        let flip = |mask: u64| {
            if me == Color::Black {
                mask.swap_bytes()
            } else {
                mask
            }
        };

        let mut planes = [0u64; BOARD_PLANES];
        for (side, color) in [me, enemy].into_iter().enumerate() {
            for role in ROLES {
                planes[6 * side + role as usize] = flip(self.pieces(color, role));
            }
            planes[14 + side] = flip(self.side_attacks(color, occupied));
            let shift = color as u8 * 2;
            if self.castling & (1 << shift) != 0 {
                planes[16 + 2 * side] = !0;
            }
            if self.castling & (1 << (shift + 1)) != 0 {
                planes[17 + 2 * side] = !0;
            }
        }
        planes[12] = flip(bit(mv.from));
        planes[13] = flip(bit(mv.to));
        if let Some(ep) = self.en_passant
            && self.has_legal_en_passant()
        {
            planes[20] = flip(bit(ep));
        }
        planes
    }

    /// Encode the position and a legal best move as a flat `[21, 8, 8]` float32 tensor matching Python.
    pub fn encode_board(&self, mv: Move) -> [f32; BOARD_PLANES * 64] {
        let planes = self.encode_board_planes(mv);
        let mut out = [0.0f32; BOARD_PLANES * 64];
        for (plane_idx, &mask) in planes.iter().enumerate() {
            let base = plane_idx * 64;
            for sq in squares(mask) {
                out[base + sq as usize] = 1.0;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find_move(pos: &Position, uci: &str) -> Move {
        pos.legal_moves()
            .into_iter()
            .find(|mv| mv.to_string() == uci)
            .unwrap_or_else(|| panic!("move {uci} not legal in {pos}"))
    }

    #[test]
    fn move_features_and_board_encoding_cover_special_cases() {
        // Black to move with en passant capture, castling rights, and pinned piece attack.
        let pos: Position = "r3k2r/8/8/8/3pP3/8/8/R3K2R b KQkq e3 0 1".parse().unwrap();
        let mv = find_move(&pos, "d4e3");
        let f = pos.move_features(mv);
        assert_eq!(f.piece, 1);
        assert_eq!(f.is_capture, 1);
        assert_eq!(f.captured_value, 1);
        assert_eq!(f.is_promotion, 0);
        assert_eq!(f.is_castle, 0);
        assert_eq!(f.backward, 0);
        assert_eq!(f.sideways, 0);
        assert_eq!(f.in_check, 0);
        assert_eq!(f.material_balance, 0);
        assert_eq!(f.non_pawn_material, 20);

        let planes = pos.encode_board_planes(mv);
        // Black is flipped: e3 (sq 20) -> 20 ^ 56 = 44 (e6 in mover's perspective).
        assert_eq!(planes[20], bit(20 ^ 56));
        assert_eq!(planes[12], bit(27 ^ 56)); // d4
        assert_eq!(planes[13], bit(20 ^ 56)); // e3
        assert_eq!(planes[16], !0);
        assert_eq!(planes[17], !0);
        assert_eq!(planes[18], !0);
        assert_eq!(planes[19], !0);

        let tensor = pos.encode_board(mv);
        assert_eq!(tensor[20 * 64 + (20 ^ 56) as usize], 1.0);
        assert_eq!(tensor[12 * 64 + (27 ^ 56) as usize], 1.0);
        assert_eq!(tensor[13 * 64 + (20 ^ 56) as usize], 1.0);
    }

    #[test]
    fn encode_board_includes_pinned_piece_attacks_and_excludes_illegal_ep() {
        // White pawn on e5 is pinned to king on e1 by rook on e8; d5 pawn gives EP target d6
        // which is NOT legal because capturing would expose the king on the e-file.
        // The pinned white pawn on e5 still attacks d6 and f6 in plane 14.
        let pos: Position = "4r2k/8/8/3pP3/8/8/8/4K3 w - d6 0 1".parse().unwrap();
        let mv = find_move(&pos, "e1d1");
        let planes = pos.encode_board_planes(mv);
        assert_eq!(planes[20], 0);
        // d6 = 43, f6 = 45
        assert_ne!(planes[14] & bit(43), 0);
        assert_ne!(planes[14] & bit(45), 0);
    }
}
