use std::sync::OnceLock;

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

/// The squares strictly between two squares on a shared rank, file or diagonal, else empty.
pub(crate) fn between(a: u8, b: u8) -> u64 {
    for rays in &RAYS {
        if rays[a as usize] & bit(b) != 0 {
            return rays[a as usize] & !rays[b as usize] & !bit(b);
        }
    }
    0
}

/// The full ray from one square toward a second square on a shared line, else empty.
pub(crate) fn ray(from: u8, through: u8) -> u64 {
    RAYS.iter()
        .map(|rays| rays[from as usize])
        .find(|ray| ray & bit(through) != 0)
        .unwrap_or(0)
}

// Ray walking is the reference for the magic tables and builds them.
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

/// The squares whose occupancy can change a slider's attacks: each ray without its edge square.
const fn relevant(square: usize, first: usize) -> u64 {
    let mut mask = 0;
    let mut direction = first;
    while direction < first + 4 {
        let ray = RAYS[direction][square];
        if ray != 0 {
            let edge = if direction.is_multiple_of(2) {
                63 - ray.leading_zeros()
            } else {
                ray.trailing_zeros()
            };
            mask |= ray & !(1 << edge);
        }
        direction += 1;
    }
    mask
}

#[derive(Clone, Copy)]
struct Magic {
    mask: u64,
    magic: u64,
    shift: u32,
    offset: usize,
}

impl Magic {
    fn index(&self, occupied: u64) -> usize {
        self.offset + ((occupied & self.mask).wrapping_mul(self.magic) >> self.shift) as usize
    }
}

struct Tables {
    rook: [Magic; 64],
    bishop: [Magic; 64],
    attacks: Vec<u64>,
}

// The tables total about 860 KB, so they are built on first use rather than stored in the binary.
static TABLES: OnceLock<Tables> = OnceLock::new();

fn build(magics: &[u64; 64], first: usize, attacks: &mut Vec<u64>) -> [Magic; 64] {
    std::array::from_fn(|square| {
        let mask = relevant(square, first);
        let magic = Magic {
            mask,
            magic: magics[square],
            shift: 64 - mask.count_ones(),
            offset: attacks.len(),
        };
        attacks.resize(attacks.len() + (1 << mask.count_ones()), 0);
        // Visit every subset of the mask with the carry-rippler trick.
        let mut subset = 0u64;
        loop {
            let slot = &mut attacks[magic.index(subset)];
            let expected = sliding(square as u8, subset, first..first + 4);
            assert!(
                *slot == 0 || *slot == expected,
                "magic collision on square {square}"
            );
            *slot = expected;
            subset = subset.wrapping_sub(mask) & mask;
            if subset == 0 {
                break;
            }
        }
        magic
    })
}

fn tables() -> &'static Tables {
    TABLES.get_or_init(|| {
        let mut attacks = Vec::with_capacity(107_648);
        let rook = build(&ROOK_MAGICS, 0, &mut attacks);
        let bishop = build(&BISHOP_MAGICS, 4, &mut attacks);
        Tables {
            rook,
            bishop,
            attacks,
        }
    })
}

pub(crate) fn rook(square: u8, occupied: u64) -> u64 {
    let tables = tables();
    tables.attacks[tables.rook[square as usize].index(occupied)]
}

pub(crate) fn bishop(square: u8, occupied: u64) -> u64 {
    let tables = tables();
    tables.attacks[tables.bishop[square as usize].index(occupied)]
}

// Found by `search_magics` below with a fixed seed.
static ROOK_MAGICS: [u64; 64] = [
    0x2080002080400010,
    0x00c0002001401000,
    0x2100110008402002,
    0x0880080081041000,
    0x0200020020041008,
    0x2300040008010012,
    0x0c00283004008201,
    0x0180010000407a80,
    0x0168800080400020,
    0x0010400040201000,
    0x1001002001001048,
    0x1001002408100100,
    0x0801000408010012,
    0x4001000209000400,
    0x08a20004c8020001,
    0x2002801145002280,
    0x0080860021004200,
    0x001000c009402002,
    0x00b0002004002800,
    0x100a808010020800,
    0x8101010008000410,
    0x0244008002000480,
    0x0000040010810208,
    0x2000020000448534,
    0x4104400480008033,
    0x0000810100204000,
    0x0440430900200010,
    0x4600240900100100,
    0x0060080080040080,
    0x0001000300080400,
    0x0004084400011002,
    0x0023040200008041,
    0x0580050043002080,
    0x0400804002802008,
    0x0001002001004010,
    0x1000200901001000,
    0x4410800801800c00,
    0xa012003806001004,
    0x0020100104008802,
    0x0004808402000041,
    0x0010400170898000,
    0x0080500020004004,
    0x1040408012020020,
    0x8010040008004040,
    0x2001080100110004,
    0x0000020004008080,
    0x0021010810040002,
    0x0800008c43020024,
    0x0000800021005100,
    0x0070201040008080,
    0x0000d04282006a00,
    0x0010014400080240,
    0x0001080110050100,
    0x0012000810240600,
    0x0402000801040200,
    0x028100108a004100,
    0x0050800300102045,
    0x8208210040120882,
    0x8010600101183441,
    0x020b000910006045,
    0x0241001002480005,
    0x0081000400880241,
    0x0000009008024124,
    0x0048122980410402,
];
static BISHOP_MAGICS: [u64; 64] = [
    0x0848020822040013,
    0x8010a40085821200,
    0x0008008430840822,
    0x0808048108040000,
    0x1304042100008104,
    0x5001012010204023,
    0x81048801b8200420,
    0x200a008084012000,
    0x0040102001042084,
    0x840a505042428020,
    0x0000700102202920,
    0x44101c0c10800002,
    0x0040040422000000,
    0x0180020802090202,
    0x4020020811041202,
    0x000104308c042000,
    0x4140661002424400,
    0x0028012008010460,
    0x0188062102002a00,
    0x0014004840102008,
    0x0105000290400002,
    0x8001022200410400,
    0x104a041918013446,
    0x008a000082008238,
    0x04a0060008100430,
    0x0008220008820801,
    0x2508041208005010,
    0x4008080200202020,
    0x2441001013004000,
    0x0030008060407000,
    0x4008108000420800,
    0x0012021050290100,
    0x0210080482200500,
    0xcc01112048100480,
    0x0020402806500440,
    0x00048e0080580080,
    0x0040102020020080,
    0x0028010440080807,
    0x4601041108008800,
    0x8040810e04104200,
    0x901210110400088a,
    0xa003080212081050,
    0x00c1004048401004,
    0x900000a014400800,
    0x0008021040405401,
    0x4020008206002090,
    0x0004190424030100,
    0x0424008a02026250,
    0x8004088250900040,
    0x1c00430088a04200,
    0x0001020094040001,
    0x8040210020880061,
    0x2010040450442032,
    0x0800840850044001,
    0x0004040802140004,
    0x0004080a04222020,
    0x8088802110022000,
    0x1081a10416114400,
    0x0205010a24060820,
    0x0000000720411080,
    0x1008000208430400,
    0x580c026028810840,
    0x802020441020a110,
    0x12c0022401020018,
];

#[cfg(test)]
mod tests {
    use super::*;

    fn subsets(mask: u64) -> impl Iterator<Item = u64> {
        let mut subset = 0u64;
        let mut done = false;
        std::iter::from_fn(move || {
            if done {
                return None;
            }
            let current = subset;
            subset = subset.wrapping_sub(mask) & mask;
            done = subset == 0;
            Some(current)
        })
    }

    #[test]
    fn magic_lookups_match_ray_walking_on_every_relevant_occupancy() {
        let mut checked = 0;
        for square in 0..64u8 {
            for (first, lookup) in [(0, rook as fn(u8, u64) -> u64), (4, bishop)] {
                let mask = relevant(square as usize, first);
                for subset in subsets(mask) {
                    let expected = sliding(square, subset, first..first + 4);
                    assert_eq!(lookup(square, subset), expected, "square {square}");
                    // Squares outside the mask must not change the result.
                    assert_eq!(lookup(square, subset | !mask), expected, "square {square}");
                    checked += 1;
                }
            }
        }
        assert_eq!(checked, 102_400 + 5_248);
        assert_eq!(tables().attacks.len(), 102_400 + 5_248);
    }

    #[test]
    fn between_covers_lines_only() {
        assert_eq!(between(0, 7), 0b0111_1110);
        assert_eq!(between(7, 0), 0b0111_1110);
        assert_eq!(between(0, 63), sliding(0, bit(63), 4..5) & !bit(63));
        assert_eq!(between(0, 17), 0); // A knight's jump shares no line.
        assert_eq!(between(0, 1), 0);
    }

    /// Print new magic numbers: cargo test --release -- --ignored search_magics --nocapture
    #[test]
    #[ignore]
    fn search_magics() {
        let mut rng = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            rng
        };
        for (name, first) in [("ROOK", 0), ("BISHOP", 4)] {
            let mut found = Vec::new();
            for square in 0..64usize {
                let mask = relevant(square, first);
                let bits = mask.count_ones();
                let occupancies: Vec<_> = subsets(mask).collect();
                let attacks: Vec<_> = occupancies
                    .iter()
                    .map(|&occupied| sliding(square as u8, occupied, first..first + 4))
                    .collect();
                let mut table = vec![0u64; 1 << bits];
                let mut used = vec![0u32; 1 << bits];
                for attempt in 1u32.. {
                    // Sparse candidates find working magics much sooner.
                    let magic = next() & next() & next();
                    if (mask.wrapping_mul(magic) >> 56).count_ones() < 6 {
                        continue;
                    }
                    let works = occupancies
                        .iter()
                        .zip(&attacks)
                        .all(|(&occupied, &attack)| {
                            let index = (occupied.wrapping_mul(magic) >> (64 - bits)) as usize;
                            if used[index] != attempt {
                                used[index] = attempt;
                                table[index] = attack;
                                true
                            } else {
                                table[index] == attack
                            }
                        });
                    if works {
                        found.push(magic);
                        break;
                    }
                }
            }
            println!("static {name}_MAGICS: [u64; 64] = [");
            for magic in found {
                println!("    {magic:#018x},");
            }
            println!("];");
        }
    }
}
