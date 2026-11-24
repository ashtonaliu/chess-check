use engine_core::Position;
use std::time::Instant;

const INITIAL_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KIWIPETE_FEN: &str = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";

fn perft_copy(pos: &mut Position, depth: usize) -> u64 {
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
        nodes += perft_copy(pos, depth - 1);
        pos.unmake_move(undo);
    }
    nodes
}

fn perft_incremental(pos: &mut Position, depth: usize) -> u64 {
    if depth == 0 {
        return 1;
    }
    let moves = pos.legal_moves();
    if depth == 1 {
        return moves.len() as u64;
    }
    let mut nodes = 0;
    for mv in moves {
        let undo = pos.make_move_incremental(mv);
        nodes += perft_incremental(pos, depth - 1);
        pos.unmake_move_incremental(mv, undo);
    }
    nodes
}

fn bench(
    name: &str,
    fen: &str,
    depth: usize,
    expected: u64,
    runs: usize,
    f: fn(&mut Position, usize) -> u64,
) -> (f64, f64, f64) {
    let mut pos: Position = fen.parse().unwrap();
    let original = pos;
    // One untimed warmup run so attack tables are initialized and caches are warm.
    assert_eq!(
        f(&mut pos, 3.min(depth)),
        perft_copy(&mut pos.clone(), 3.min(depth))
    );
    assert_eq!(pos, original);

    let mut times = Vec::with_capacity(runs);
    for _ in 0..runs {
        let start = Instant::now();
        let nodes = f(&mut pos, depth);
        let secs = start.elapsed().as_secs_f64();
        assert_eq!(nodes, expected, "{name} depth {depth}");
        assert_eq!(pos, original, "{name} depth {depth} changed root");
        times.push(secs);
    }
    times.sort_by(f64::total_cmp);
    let min = times[0];
    let median = times[runs / 2];
    let max = times[runs - 1];
    let mnps = (expected as f64) / median / 1e6;
    println!(
        "{name:34} median {median:.4} s ({mnps:.1} M nodes/s), range {min:.4}..{max:.4} s, runs={times:.4?}"
    );
    (median, min, max)
}

fn main() {
    const RUNS: usize = 5;
    println!(
        "size_of::<Position>() = {}, size_of::<Undo>() = {}, size_of::<IncrementalUndo>() = {}",
        std::mem::size_of::<Position>(),
        std::mem::size_of::<engine_core::Undo>(),
        std::mem::size_of::<engine_core::IncrementalUndo>(),
    );
    for (label, fen, depth, expected) in [
        ("Initial depth 6", INITIAL_FEN, 6, 119_060_324),
        ("Kiwipete depth 5", KIWIPETE_FEN, 5, 193_690_690),
    ] {
        bench(
            &format!("{label} (copy)"),
            fen,
            depth,
            expected,
            RUNS,
            perft_copy,
        );
        bench(
            &format!("{label} (incremental)"),
            fen,
            depth,
            expected,
            RUNS,
            perft_incremental,
        );
    }
}
