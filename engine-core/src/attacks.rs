use crate::{Color, bit};

// Even directions increase the square index, and odd directions decrease it.
// Orthogonal directions come first, followed by the diagonals.
const DIRECTIONS: [(i8, i8); 8] = [
    (1, 0),
    (-1, 0),
    (0, 1),
    (0, -1),
    (1, 1),
    (-1, -1),
    (-1, 1),
    (1, -1),
];

pub(crate) static KING: [u64; 64] = attack_table(&DIRECTIONS, 1);
pub(crate) static KNIGHT: [u64; 64] = attack_table(
    &[
        (1, 2),
        (2, 1),
        (2, -1),
        (1, -2),
        (-1, -2),
        (-2, -1),
        (-2, 1),
        (-1, 2),
    ],
    1,
);
static PAWN: [[u64; 64]; 2] = [
    attack_table(&[(-1, 1), (1, 1)], 1),
    attack_table(&[(-1, -1), (1, -1)], 1),
];
static RAYS: [[u64; 64]; 8] = ray_tables();

const fn attack_table(offsets: &[(i8, i8)], steps: u8) -> [u64; 64] {
    let mut table = [0; 64];
    let mut square = 0;
    while square < 64 {
        let mut direction = 0;
        while direction < offsets.len() {
            let (df, dr) = offsets[direction];
            let mut file = square as i8 % 8 + df;
            let mut rank = square as i8 / 8 + dr;
            let mut left = steps;
            while left > 0 && file >= 0 && file < 8 && rank >= 0 && rank < 8 {
                table[square] |= bit((8 * rank + file) as u8);
                file += df;
                rank += dr;
                left -= 1;
            }
            direction += 1;
        }
        square += 1;
    }
    table
}

const fn ray_tables() -> [[u64; 64]; 8] {
    let mut tables = [[0; 64]; 8];
    let mut direction = 0;
    while direction < 8 {
        tables[direction] = attack_table(&[DIRECTIONS[direction]], 7);
        direction += 1;
    }
    tables
}

pub(crate) fn pawn(color: Color, square: u8) -> u64 {
    PAWN[color as usize][square as usize]
}

pub(crate) fn rook(square: u8, occupied: u64) -> u64 {
    sliding(square, occupied, 0..4)
}

pub(crate) fn bishop(square: u8, occupied: u64) -> u64 {
    sliding(square, occupied, 4..8)
}

fn sliding(square: u8, occupied: u64, directions: std::ops::Range<usize>) -> u64 {
    let mut attacks = 0;
    for direction in directions {
        let rays = &RAYS[direction];
        let ray = rays[square as usize];
        let blockers = ray & occupied;
        // Keep the nearest blocker and remove the rest of its ray.
        attacks |= if blockers == 0 {
            ray
        } else {
            let first = if direction % 2 == 0 {
                blockers.trailing_zeros()
            } else {
                63 - blockers.leading_zeros()
            };
            ray ^ rays[first as usize]
        };
    }
    attacks
}
