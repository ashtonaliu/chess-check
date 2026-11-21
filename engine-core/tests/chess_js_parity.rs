use std::fs;

use engine_core::Position;

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn b64_index(byte: u8) -> usize {
    B64.iter()
        .position(|&b| b == byte)
        .unwrap_or_else(|| panic!("invalid base64 square code: {}", char::from(byte)))
}

fn expand_board(board: &str) -> [u8; 64] {
    let mut cells = [b'.'; 64];
    let mut idx = 0;
    for byte in board.bytes() {
        if byte == b'/' {
            continue;
        }
        if (b'1'..=b'8').contains(&byte) {
            idx += (byte - b'0') as usize;
        } else {
            cells[idx] = byte;
            idx += 1;
        }
    }
    assert_eq!(idx, 64, "invalid board field: {board}");
    cells
}

fn compress_board(cells: &[u8; 64]) -> String {
    let mut out = String::with_capacity(64);
    for rank in 0..8 {
        if rank > 0 {
            out.push('/');
        }
        let mut empty = 0u8;
        for file in 0..8 {
            let ch = cells[rank * 8 + file];
            if ch == b'.' {
                empty += 1;
            } else {
                if empty > 0 {
                    out.push(char::from(b'0' + empty));
                    empty = 0;
                }
                out.push(char::from(ch));
            }
        }
        if empty > 0 {
            out.push(char::from(b'0' + empty));
        }
    }
    out
}

fn decode_after_fen(before_fen: &str, diff: &str, flags: Option<&str>) -> String {
    let mut parts = before_fen.split(' ');
    let board = parts.next().unwrap();
    let turn = parts.next().unwrap();
    let castling = parts.next().unwrap();
    let _ep = parts.next().unwrap();
    let halfmove: u32 = parts.next().unwrap().parse().unwrap();
    let fullmove: u32 = parts.next().unwrap().parse().unwrap();

    let mut cells = expand_board(board);
    let (pairs, remainder) = diff.as_bytes().as_chunks::<2>();
    assert!(remainder.is_empty(), "odd diff: {diff}");
    for &[sq, piece] in pairs {
        cells[b64_index(sq)] = piece;
    }

    let next_turn = if turn == "w" { "b" } else { "w" };
    let mut next_castling = castling;
    let mut next_ep = "-";
    let mut next_halfmove = halfmove + 1;
    let next_fullmove = fullmove + u32::from(turn == "b");

    if let Some(flags) = flags {
        for token in flags.split(',') {
            if token == "0" {
                next_halfmove = 0;
            } else if let Some(rest) = token.strip_prefix('c') {
                next_castling = rest;
            } else if let Some(rest) = token.strip_prefix('e') {
                next_ep = rest;
            } else if let Some(rest) = token.strip_prefix('h') {
                next_halfmove = rest.parse().unwrap();
            } else {
                panic!("unknown flag token: {token}");
            }
        }
    }

    format!(
        "{} {next_turn} {next_castling} {next_ep} {next_halfmove} {next_fullmove}",
        compress_board(&cells)
    )
}

#[test]
fn parity_with_chess_js() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/chess_js_parity.json");
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("failed to read {path}: {e}"));
    let fixture: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("failed to parse {path}: {e}"));
    let position_count = fixture["position_count"].as_u64().unwrap() as usize;
    let move_count = fixture["move_count"].as_u64().unwrap() as usize;
    let positions = fixture["positions"].as_array().unwrap();
    assert!(
        positions.len() >= 10_000,
        "expected at least 10,000 positions, got {}",
        positions.len()
    );
    assert_eq!(positions.len(), position_count);

    let mut checked_moves = 0usize;
    for (idx, item) in positions.iter().enumerate() {
        let pair = item.as_array().unwrap();
        assert_eq!(pair.len(), 2, "position {idx} expected [fen, packed_moves]");
        let fen = pair[0].as_str().unwrap();
        let packed = pair[1].as_str().unwrap();
        let mut pos: Position = fen
            .parse()
            .unwrap_or_else(|e| panic!("position {idx} failed to parse FEN {fen}: {e}"));
        assert_eq!(pos.to_string(), fen, "position {idx} FEN round-trip");
        let original = pos;

        let mut actual: Vec<_> = pos
            .legal_moves()
            .into_iter()
            .map(|mv| (mv.to_string(), mv))
            .collect();
        actual.sort_unstable_by(|a, b| a.0.cmp(&b.0));

        let expected_entries: Vec<&str> = if packed.is_empty() {
            Vec::new()
        } else {
            packed.split(';').collect()
        };
        assert_eq!(
            actual.len(),
            expected_entries.len(),
            "position {idx} ({fen}) move count mismatch"
        );

        for ((actual_uci, mv), entry) in actual.iter().zip(expected_entries.iter()) {
            let mut fields = entry.split(' ');
            let expected_uci = fields.next().unwrap();
            let expected_san = fields.next().unwrap();
            let diff = fields.next().unwrap();
            let flags = fields.next();
            assert!(fields.next().is_none(), "extra fields in entry: {entry}");

            assert_eq!(
                actual_uci, expected_uci,
                "position {idx} ({fen}) UCI mismatch"
            );
            let actual_san = pos.san(*mv);
            assert_eq!(
                actual_san, expected_san,
                "position {idx} ({fen}) SAN mismatch for {actual_uci}"
            );

            let expected_after = decode_after_fen(fen, diff, flags);
            let undo = pos.make_move(*mv);
            assert_eq!(
                pos.to_string(),
                expected_after,
                "position {idx} ({fen}) after-FEN mismatch for {actual_uci} ({actual_san})"
            );
            pos.unmake_move(undo);
            checked_moves += 1;
        }
        assert_eq!(pos, original, "position {idx} mutated after undo");
    }

    assert_eq!(checked_moves, move_count);
    println!(
        "chess.js parity: {} positions, {} legal moves matched (UCI, SAN, and after-FEN)",
        positions.len(),
        checked_moves
    );
}
