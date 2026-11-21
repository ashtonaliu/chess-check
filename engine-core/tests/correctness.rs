use engine_core::Position;
use shakmaty::{CastlingMode, Chess, EnPassantMode, Position as _, fen::Fen};

fn fixtures() -> impl Iterator<Item = [&'static str; 3]> {
    include_str!("perft.txt")
        .lines()
        .filter(|line| !line.starts_with('#'))
        .map(|line| line.split(" | ").collect::<Vec<_>>().try_into().unwrap())
}

fn perft(pos: &mut Position, depth: usize) -> u64 {
    if depth == 0 {
        return 1;
    }
    let moves = pos.legal_moves();
    if depth == 1 {
        return moves.len() as u64;
    }
    let mut nodes = 0;
    for mv in moves {
        let undo = pos.make_move(mv);
        nodes += perft(pos, depth - 1);
        pos.unmake_move(undo);
    }
    nodes
}

#[test]
fn published_perft() {
    for [name, fen, counts] in fixtures() {
        let mut pos: Position = fen.parse().unwrap();
        let original = pos;
        assert_eq!(pos.to_string(), fen);
        assert_eq!(
            counts.split_whitespace().count(),
            5,
            "{name} fixture depths"
        );
        for (depth, expected) in counts.split_whitespace().enumerate() {
            let depth = depth + 1;
            let nodes = perft(&mut pos, depth);
            assert_eq!(
                nodes,
                expected.parse::<u64>().unwrap(),
                "{name} depth {depth}"
            );
            assert_eq!(pos, original, "{name} depth {depth} changed the root");
            println!("{name} depth {depth}: {nodes}");
        }
    }
}

#[test]
fn random_games_against_shakmaty() {
    const GAMES: usize = 4096;
    const MAX_PLIES: usize = 256;
    const SEED: u64 = 0x58c8_37b2_d899_c629;
    let starts: Vec<_> = fixtures().map(|[_, fen, _]| fen).collect();
    let mut rng = SEED;
    let mut positions = 0;
    let mut legal_moves = 0;
    let mut played = 0;
    for game in 0..GAMES {
        // Half start at the initial position, the rest sample branches of the perft suite.
        let start = if game % 2 == 0 {
            0
        } else {
            1 + (game / 2) % (starts.len() - 1)
        };
        let fen = starts[start];
        let mut ours: Position = fen.parse().unwrap();
        let mut reference: Chess = fen
            .parse::<Fen>()
            .unwrap()
            .into_position(CastlingMode::Standard)
            .unwrap();
        let mut history = Vec::with_capacity(MAX_PLIES);
        for ply in 0..=MAX_PLIES {
            let fen = Fen::from_position(&reference, EnPassantMode::Always).to_string();
            assert_eq!(ours.to_string(), fen, "game {game}, ply {ply}");
            let mut actual: Vec<_> = ours
                .legal_moves()
                .into_iter()
                .map(|mv| (mv.to_string(), mv))
                .collect();
            let mut expected: Vec<_> = reference
                .legal_moves()
                .into_iter()
                .map(|mv| (mv.to_uci(CastlingMode::Standard).to_string(), mv))
                .collect();
            actual.sort_unstable_by(|a, b| a.0.cmp(&b.0));
            expected.sort_unstable_by(|a, b| a.0.cmp(&b.0));
            assert!(
                actual
                    .iter()
                    .map(|entry| &entry.0)
                    .eq(expected.iter().map(|entry| &entry.0)),
                "game {game}, ply {ply}, {fen}\ncore: {actual:?}\nshakmaty: {expected:?}"
            );
            positions += 1;
            legal_moves += actual.len();
            if expected.is_empty() || reference.is_insufficient_material() || ply == MAX_PLIES {
                break;
            }

            // Xorshift64 keeps the selected moves reproducible across runs.
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            let index = (rng % expected.len() as u64) as usize;
            let before = ours;
            let undo = ours.make_move(actual[index].1);
            history.push((before, undo));
            reference.play_unchecked(expected[index].1);
            played += 1;
        }
        while let Some((before, undo)) = history.pop() {
            ours.unmake_move(undo);
            assert_eq!(ours, before, "game {game}, undo to ply {}", history.len());
        }
    }
    println!(
        "seed {SEED:#x}: {GAMES} games, {positions} positions, {legal_moves} legal moves compared, {played} plies played and undone"
    );
}

#[test]
fn inconsistent_fens_are_rejected() {
    for fen in [
        "4k3/8/8/8/8/8/8/8 w - - 0 1",     // Missing king.
        "4k3/8/8/8/8/8/8/4K2P w - - 0 1",  // Back-rank pawn.
        "4k3/8/8/8/8/8/8/4K3 w K - 0 1",   // Missing rook.
        "4k3/8/8/8/8/8/8/4K3 w - d6 0 1",  // Missing pawn behind the target.
        "4k3/8/8/8/8/8/8/4K3 w - - 0 0",   // Invalid fullmove number.
        "4k3/8/8/8/8/8/4R3/4K3 w - - 0 1", // Wrong side in check.
    ] {
        assert!(fen.parse::<Position>().is_err(), "accepted {fen}");
    }
}
