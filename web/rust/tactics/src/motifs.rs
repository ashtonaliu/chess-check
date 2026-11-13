use crate::{attacks, DIAGONAL, ORTHOGONAL};

type Board = [u8; 64];

fn kind(piece: u8) -> u8 {
    piece.to_ascii_lowercase()
}

fn value(piece: u8) -> u8 {
    match kind(piece) {
        b'p' => 1,
        b'n' | b'b' => 3,
        b'r' => 5,
        b'q' => 9,
        b'k' => 100,
        _ => 0,
    }
}

fn belongs_to(piece: u8, white: bool) -> bool {
    piece != 0 && piece.is_ascii_uppercase() == white
}

fn attackers(board: &Board, square: usize, white: bool) -> impl Iterator<Item = u8> + '_ {
    board
        .iter()
        .copied()
        .enumerate()
        .filter_map(move |(from, piece)| {
            (belongs_to(piece, white) && attacks(board, from) & (1 << square) != 0).then_some(piece)
        })
}

fn defended(board: &Board, square: usize, white: bool) -> bool {
    attackers(board, square, white).next().is_some()
}

fn safe(board: &Board, square: usize, white: bool) -> bool {
    let mut threats = attackers(board, square, !white).peekable();
    threats.peek().is_none()
        || (defended(board, square, white) && threats.all(|p| value(p) >= value(board[square])))
}

fn targets(
    board: &Board,
    mut mask: u64,
    piece: u8,
    white: bool,
) -> impl Iterator<Item = usize> + '_ {
    std::iter::from_fn(move || {
        while mask != 0 {
            let square = mask.trailing_zeros() as usize;
            mask &= mask - 1;
            let target = board[square];
            if belongs_to(target, !white)
                && kind(target) != b'p'
                && (kind(target) == b'k'
                    || value(target) > value(piece)
                    || !defended(board, square, !white))
            {
                return Some(square);
            }
        }
        None
    })
}

const MATE: u8 = 1;
const BACK_RANK_MATE: u8 = 2;
const FORK: u8 = 4;
const PIN: u8 = 8;
const SKEWER: u8 = 16;
const DISCOVERED_ATTACK: u8 = 32;
const HANGING_PIECE: u8 = 64;
const PROMOTION: u8 = 128;

fn line_motifs(board: &Board, square: usize, white: bool) -> u8 {
    let piece = board[square];
    let directions: &[&[(i8, i8)]] = match kind(piece) {
        b'b' => &[&DIAGONAL],
        b'r' => &[&ORTHOGONAL],
        b'q' => &[&ORTHOGONAL, &DIAGONAL],
        _ => return 0,
    };
    let mut result = 0;
    for &(df, dr) in directions.iter().flat_map(|group| group.iter()) {
        let (mut file, mut rank) = ((square % 8) as i8 + df, (square / 8) as i8 + dr);
        let mut front = 0;
        while (0..8).contains(&file) && (0..8).contains(&rank) {
            let target = (file + 8 * rank) as usize;
            let back = board[target];
            if belongs_to(back, white) {
                break;
            }
            if back != 0 {
                if front != 0 {
                    if matches!(kind(back), b'k' | b'q')
                        && kind(front) != b'p'
                        && value(back) > value(front)
                    {
                        result |= PIN;
                    } else if matches!(kind(front), b'k' | b'q')
                        && kind(back) != b'p'
                        && value(front) > value(back)
                        && (value(back) > value(piece) || !defended(board, target, !white))
                    {
                        result |= SKEWER;
                    }
                    break;
                }
                front = back;
            }
            file += df;
            rank += dr;
        }
    }
    result
}

fn back_rank_mate(board: &Board, to: usize, white: bool) -> bool {
    let back_rank = if white { 7 } else { 0 };
    if to / 8 != back_rank || !matches!(kind(board[to]), b'r' | b'q') {
        return false;
    }
    let king = if white { b'k' } else { b'K' };
    let start = 8 * back_rank;
    let Some(file) = board[start..start + 8].iter().position(|&p| p == king) else {
        return false;
    };
    let pawn_rank = if white { 6 } else { 1 };
    (file.saturating_sub(1)..=(file + 1).min(7))
        .filter(|&f| belongs_to(board[8 * pawn_rank + f], !white))
        .count()
        >= 2
}

/// Classifies a legal move given its before and after boards.
/// Bits follow the order of the TypeScript MOTIFS list.
pub fn motifs(before: &Board, after: &Board, from: usize, to: usize, checkmate: bool) -> u8 {
    let mover = before[from];
    let white = mover.is_ascii_uppercase();
    let mut result = 0;
    if value(before[to]) >= 3 && !defended(before, to, !white) {
        result |= HANGING_PIECE;
    }
    if kind(mover) == b'p' && kind(after[to]) != b'p' {
        result |= PROMOTION;
    }
    if checkmate {
        return result
            | MATE
            | if back_rank_mate(after, to, white) {
                BACK_RANK_MATE
            } else {
                0
            };
    }
    if safe(after, to, white) {
        if kind(mover) != b'k'
            && targets(after, attacks(after, to), after[to], white)
                .take(2)
                .count()
                == 2
        {
            result |= FORK;
        }
        result |= line_motifs(after, to, white);
    }
    for (square, &piece) in before.iter().enumerate() {
        if square == from
            || !belongs_to(piece, white)
            || !matches!(kind(piece), b'b' | b'r' | b'q')
            || after[square] == 0
        {
            continue;
        }
        let newly_attacked = attacks(after, square) & !attacks(before, square);
        if targets(after, newly_attacked, after[square], white)
            .next()
            .is_some()
        {
            result |= DISCOVERED_ATTACK;
            break;
        }
    }
    result
}
