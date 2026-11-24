use crate::{Color, Move, Position, ROLES, Role, attacks, bit, squares};

const TACTIC_VALUE: [i32; 6] = [1, 3, 3, 5, 9, 100];

const ORTHO_DIRS: [(i8, i8); 4] = [(0, 1), (0, -1), (1, 0), (-1, 0)];
const DIAG_DIRS: [(i8, i8); 4] = [(1, 1), (1, -1), (-1, 1), (-1, -1)];

/// Tactic motif names in alphabetical order, matching `chesscheck/tactics.py` and `web/src/browser/tactics.ts`.
pub const MOTIF_NAMES: [&str; 8] = [
    "backRankMate",
    "discoveredAttack",
    "fork",
    "hangingPiece",
    "mate",
    "pin",
    "promotion",
    "skewer",
];

const BACK_RANK_MATE: u8 = 1 << 0;
const DISCOVERED_ATTACK: u8 = 1 << 1;
const FORK: u8 = 1 << 2;
const HANGING_PIECE: u8 = 1 << 3;
const MATE: u8 = 1 << 4;
const PIN: u8 = 1 << 5;
const PROMOTION: u8 = 1 << 6;
const SKEWER: u8 = 1 << 7;

/// Bitmask of tactic motifs detected for a single move.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Motifs(u8);

impl Motifs {
    /// Return the detected motif names in sorted order.
    pub fn to_names(self) -> Vec<&'static str> {
        MOTIF_NAMES
            .iter()
            .enumerate()
            .filter_map(|(bit_idx, &name)| (self.0 & (1 << bit_idx) != 0).then_some(name))
            .collect()
    }
}

fn piece_attacks(color: Color, role: Role, sq: u8, occupied: u64) -> u64 {
    match role {
        Role::Pawn => attacks::pawn(color, sq),
        Role::Knight => attacks::KNIGHT[sq as usize],
        Role::Bishop => attacks::bishop(sq, occupied),
        Role::Rook => attacks::rook(sq, occupied),
        Role::Queen => attacks::bishop(sq, occupied) | attacks::rook(sq, occupied),
        Role::King => attacks::KING[sq as usize],
    }
}

impl Position {
    fn role_of(&self, color: Color, sq: u8) -> Option<Role> {
        let mask = bit(sq);
        ROLES
            .into_iter()
            .find(|&role| self.pieces(color, role) & mask != 0)
    }

    fn in_bad_spot(&self, sq: u8, color: Color, role: Role, occupied: u64) -> bool {
        let enemy = color.other();
        let att = self.attackers(sq, enemy, occupied);
        if att == 0 {
            return false;
        }
        if !self.is_attacked(sq, color, occupied) {
            return true;
        }
        let my_val = TACTIC_VALUE[role as usize];
        squares(att).any(|a| {
            self.role_of(enemy, a)
                .is_some_and(|r| TACTIC_VALUE[r as usize] < my_val)
        })
    }

    fn valuable_targets_count(&self, sq: u8, color: Color, role: Role, occupied: u64) -> usize {
        let enemy = color.other();
        let my_val = TACTIC_VALUE[role as usize];
        let targets = piece_attacks(color, role, sq, occupied) & self.occupied_by(enemy);
        squares(targets)
            .filter(|&t| {
                let Some(t_role) = self.role_of(enemy, t) else {
                    return false;
                };
                if t_role == Role::Pawn {
                    return false;
                }
                t_role == Role::King
                    || TACTIC_VALUE[t_role as usize] > my_val
                    || !self.is_attacked(t, enemy, occupied)
            })
            .count()
    }

    fn line_motifs(&self, sq: u8, color: Color, role: Role, occupied: u64) -> u8 {
        if !matches!(role, Role::Bishop | Role::Rook | Role::Queen) {
            return 0;
        }
        let enemy = color.other();
        let own = self.occupied_by(color);
        let my_val = TACTIC_VALUE[role as usize];
        let mut found = 0u8;
        let f0 = (sq % 8) as i8;
        let r0 = (sq / 8) as i8;

        let check_dirs = |dirs: &[(i8, i8)], found: &mut u8| {
            for &(df, dr) in dirs {
                let mut hits: [(Role, u8); 2] = [(Role::Pawn, 0); 2];
                let mut n_hits = 0usize;
                let mut f = f0 + df;
                let mut r = r0 + dr;
                while (0..8).contains(&f) && (0..8).contains(&r) && n_hits < 2 {
                    let here = (r * 8 + f) as u8;
                    let mask = bit(here);
                    if own & mask != 0 {
                        break;
                    }
                    if let Some(p_role) = self.role_of(enemy, here) {
                        hits[n_hits] = (p_role, here);
                        n_hits += 1;
                    }
                    f += df;
                    r += dr;
                }
                if n_hits == 2 {
                    let (front, _) = hits[0];
                    let (back, back_sq) = hits[1];
                    let fv = TACTIC_VALUE[front as usize];
                    let bv = TACTIC_VALUE[back as usize];
                    if matches!(back, Role::King | Role::Queen) && front != Role::Pawn && bv > fv {
                        *found |= PIN;
                    } else if matches!(front, Role::King | Role::Queen)
                        && back != Role::Pawn
                        && fv > bv
                        && (bv > my_val || !self.is_attacked(back_sq, enemy, occupied))
                    {
                        *found |= SKEWER;
                    }
                }
            }
        };

        if matches!(role, Role::Rook | Role::Queen) {
            check_dirs(&ORTHO_DIRS, &mut found);
        }
        if matches!(role, Role::Bishop | Role::Queen) {
            check_dirs(&DIAG_DIRS, &mut found);
        }
        found
    }

    /// Detect tactic motifs for a legal move from this position, matching `chesscheck/tactics.py`.
    pub fn motifs(&self, mv: Move) -> Motifs {
        let color = self.turn;
        let enemy = color.other();
        let own = self.occupied_by(color);
        let opposing = self.occupied_by(enemy);
        let occupied = own | opposing;
        let mut out = 0u8;

        let captured = if mv.role == Role::Pawn && self.en_passant == Some(mv.to) {
            Some(Role::Pawn)
        } else {
            self.role_of(enemy, mv.to)
        };
        if let Some(cap_role) = captured
            && cap_role != Role::Pawn
            && TACTIC_VALUE[cap_role as usize] >= 3
            && !self.is_attacked(mv.to, enemy, occupied)
        {
            out |= HANGING_PIECE;
        }
        if mv.promotion.is_some() {
            out |= PROMOTION;
        }

        // Record attacks by other friendly sliders before the move for discovered attacks.
        let mut before_sliders: [(u8, Role, u64); 16] = [(0, Role::Bishop, 0); 16];
        let mut n_sliders = 0usize;
        for role in [Role::Bishop, Role::Rook, Role::Queen] {
            for s in squares(self.pieces(color, role) & !bit(mv.from)) {
                if n_sliders < before_sliders.len() {
                    before_sliders[n_sliders] = (s, role, piece_attacks(color, role, s, occupied));
                    n_sliders += 1;
                }
            }
        }

        let mut after = *self;
        after.apply(mv);
        let after_own = after.occupied_by(color);
        let after_opposing = after.occupied_by(enemy);
        let after_occupied = after_own | after_opposing;
        let moved_role = mv.promotion.unwrap_or(mv.role);

        if after.is_attacked(after.king_square(enemy), color, after_occupied)
            && after.legal_moves().is_empty()
        {
            out |= MATE;
            let king = after.king_square(enemy);
            let back_rank: u8 = if enemy == Color::White { 0 } else { 7 };
            if king / 8 == back_rank
                && matches!(moved_role, Role::Rook | Role::Queen)
                && mv.to / 8 == back_rank
            {
                let front_rank = if back_rank == 0 { 1 } else { 6 };
                let kf = (king % 8) as i8;
                let blocked = (-1..=1i8)
                    .filter(|&df| {
                        let f = kf + df;
                        (0..8).contains(&f) && after_opposing & bit(front_rank * 8 + f as u8) != 0
                    })
                    .count();
                if blocked >= 2 {
                    out |= BACK_RANK_MATE;
                }
            }
            return Motifs(out);
        }

        let safe = !after.in_bad_spot(mv.to, color, moved_role, after_occupied);
        if mv.role != Role::King
            && safe
            && after.valuable_targets_count(mv.to, color, moved_role, after_occupied) >= 2
        {
            out |= FORK;
        }
        if safe {
            out |= after.line_motifs(mv.to, color, moved_role, after_occupied);
        }

        'disc: for &(s, role, prev) in &before_sliders[..n_sliders] {
            let new_targets =
                (piece_attacks(color, role, s, after_occupied) & !prev) & after_opposing;
            let slider_val = TACTIC_VALUE[role as usize];
            for t in squares(new_targets) {
                let Some(p_role) = after.role_of(enemy, t) else {
                    continue;
                };
                if p_role != Role::Pawn
                    && (p_role == Role::King
                        || TACTIC_VALUE[p_role as usize] > slider_val
                        || !after.is_attacked(t, enemy, after_occupied))
                {
                    out |= DISCOVERED_ATTACK;
                    break 'disc;
                }
            }
        }

        Motifs(out)
    }
}
