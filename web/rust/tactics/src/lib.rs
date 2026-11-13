const ORTHOGONAL: [(i8, i8); 4] = [(0, 1), (0, -1), (1, 0), (-1, 0)];
const DIAGONAL: [(i8, i8); 4] = [(1, 1), (1, -1), (-1, 1), (-1, -1)];
const KNIGHT: [(i8, i8); 8] = [
    (1, 2),
    (2, 1),
    (2, -1),
    (1, -2),
    (-1, -2),
    (-2, -1),
    (-2, 1),
    (-1, 2),
];

/// Returns attacked squares as a bitboard, with a1 at bit 0.
/// The board uses ASCII piece letters (uppercase for White) and zero for empty.
/// Sliding attacks include the first occupied square, regardless of its color.
pub fn attacks(board: &[u8; 64], square: usize) -> u64 {
    let Some(&piece) = board.get(square) else {
        return 0;
    };
    let kind = piece.to_ascii_lowercase();
    let file = (square % 8) as i8;
    let rank = (square / 8) as i8;
    let pawn_step = if piece.is_ascii_uppercase() { 1 } else { -1 };
    let pawns = [(-1, pawn_step), (1, pawn_step)];
    let directions: &[&[(i8, i8)]] = match kind {
        b'p' => &[&pawns],
        b'n' => &[&KNIGHT],
        b'b' => &[&DIAGONAL],
        b'r' => &[&ORTHOGONAL],
        b'k' | b'q' => &[&ORTHOGONAL, &DIAGONAL],
        _ => return 0,
    };
    let sliding = matches!(kind, b'b' | b'r' | b'q');

    let mut attacked = 0;
    for &(df, dr) in directions.iter().flat_map(|group| group.iter()) {
        let (mut f, mut r) = (file + df, rank + dr);
        while (0..8).contains(&f) && (0..8).contains(&r) {
            let target = (f + 8 * r) as usize;
            attacked |= 1 << target;
            if !sliding || board[target] != 0 {
                break;
            }
            f += df;
            r += dr;
        }
    }
    attacked
}

mod motifs;
pub use motifs::motifs;

#[cfg(test)]
mod tests {
    use super::attacks;

    fn mask(squares: &[usize]) -> u64 {
        squares.iter().fold(0, |bits, &square| bits | (1 << square))
    }

    #[test]
    fn rook_includes_first_blocker_of_either_color() {
        let mut board = [0; 64];
        board[27] = b'R';
        board[43] = b'P';
        board[25] = b'n';
        assert_eq!(
            attacks(&board, 27),
            mask(&[3, 11, 19, 25, 26, 28, 29, 30, 31, 35, 43])
        );
    }

    #[test]
    fn pawns_attack_in_their_own_direction() {
        let mut board = [0; 64];
        board[24] = b'P';
        board[31] = b'p';
        assert_eq!(attacks(&board, 24), mask(&[33]));
        assert_eq!(attacks(&board, 31), mask(&[22]));
    }

    #[test]
    fn corner_pieces_do_not_wrap() {
        let mut board = [0; 64];
        for (piece, expected) in [
            (b'N', mask(&[10, 17])),
            (b'K', mask(&[1, 8, 9])),
            (b'B', mask(&[9, 18, 27, 36, 45, 54, 63])),
            (
                b'Q',
                mask(&[
                    1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 18, 24, 27, 32, 36, 40, 45, 48, 54, 56, 63,
                ]),
            ),
        ] {
            board[0] = piece;
            assert_eq!(attacks(&board, 0), expected);
        }
    }

    #[test]
    fn empty_and_out_of_range_squares_have_no_attacks() {
        let board = [0; 64];
        assert_eq!(attacks(&board, 0), 0);
        assert_eq!(attacks(&board, 64), 0);
    }
}

// The browser writes a batch into this module's linear memory. Each record
// consists of two 64-byte boards, from/to square indices and a mate flag.
#[cfg(target_arch = "wasm32")]
mod wasm {
    use crate::motifs;
    use std::cell::RefCell;

    const RECORD_SIZE: usize = 131;
    thread_local! {
        static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    }

    #[no_mangle]
    pub extern "C" fn reserve_records(count: usize) -> *mut u8 {
        INPUT.with_borrow_mut(|input| {
            input.resize(count * RECORD_SIZE, 0);
            input.as_mut_ptr()
        })
    }

    /// Overwrites the start of the input buffer with one mask per record.
    #[no_mangle]
    pub extern "C" fn classify_records() {
        INPUT.with_borrow_mut(|input| {
            for index in 0..input.len() / RECORD_SIZE {
                let start = index * RECORD_SIZE;
                let record = &input[start..start + RECORD_SIZE];
                let (from, to) = (record[128] as usize, record[129] as usize);
                input[index] = if from < 64 && to < 64 {
                    motifs(
                        record[..64].try_into().unwrap(),
                        record[64..128].try_into().unwrap(),
                        from,
                        to,
                        record[130] != 0,
                    )
                } else {
                    0
                };
            }
        });
    }
}
