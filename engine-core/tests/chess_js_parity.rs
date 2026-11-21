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
    let diff_bytes = diff.as_bytes();
    assert!(diff_bytes.len().is_multiple_of(2), "odd diff: {diff}");
    for chunk in diff_bytes.chunks_exact(2) {
        cells[b64_index(chunk[0])] = chunk[1];
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

/// Minimal parser for the fixture JSON (`positions: [[fen, packed_moves], ...]`).
struct JsonCursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> JsonCursor<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            bytes: text.as_bytes(),
            pos: 0,
        }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn expect(&mut self, byte: u8) {
        self.skip_ws();
        assert_eq!(
            self.bytes.get(self.pos).copied(),
            Some(byte),
            "expected '{}' at offset {}",
            char::from(byte),
            self.pos
        );
        self.pos += 1;
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.bytes.get(self.pos).copied()
    }

    fn parse_string(&mut self) -> &'a str {
        self.expect(b'"');
        let start = self.pos;
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            assert_ne!(b, b'\\', "unexpected escape in fixture string at {}", self.pos);
            if b == b'"' {
                let s = std::str::from_utf8(&self.bytes[start..self.pos]).unwrap();
                self.pos += 1;
                return s;
            }
            self.pos += 1;
        }
        panic!("unterminated JSON string");
    }

    fn parse_usize(&mut self) -> usize {
        self.skip_ws();
        let start = self.pos;
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_digit() {
            self.pos += 1;
        }
        std::str::from_utf8(&self.bytes[start..self.pos])
            .unwrap()
            .parse()
            .unwrap()
    }

    fn skip_value(&mut self) {
        match self.peek().unwrap() {
            b'"' => {
                let _ = self.parse_string();
            }
            b'[' => {
                self.pos += 1;
                if self.peek() == Some(b']') {
                    self.pos += 1;
                    return;
                }
                loop {
                    self.skip_value();
                    if self.peek() == Some(b',') {
                        self.pos += 1;
                    } else {
                        self.expect(b']');
                        return;
                    }
                }
            }
            b'{' => {
                self.pos += 1;
                if self.peek() == Some(b'}') {
                    self.pos += 1;
                    return;
                }
                loop {
                    let _ = self.parse_string();
                    self.expect(b':');
                    self.skip_value();
                    if self.peek() == Some(b',') {
                        self.pos += 1;
                    } else {
                        self.expect(b'}');
                        return;
                    }
                }
            }
            _ => {
                while self.pos < self.bytes.len()
                    && !matches!(self.bytes[self.pos], b',' | b']' | b'}')
                    && !self.bytes[self.pos].is_ascii_whitespace()
                {
                    self.pos += 1;
                }
            }
        }
    }
}

struct Fixture<'a> {
    position_count: usize,
    move_count: usize,
    positions: Vec<(&'a str, &'a str)>,
}

fn parse_fixture(text: &str) -> Fixture<'_> {
    let mut cur = JsonCursor::new(text);
    let mut position_count = 0;
    let mut move_count = 0;
    let mut positions = Vec::new();

    cur.expect(b'{');
    loop {
        let key = cur.parse_string();
        cur.expect(b':');
        match key {
            "position_count" => position_count = cur.parse_usize(),
            "move_count" => move_count = cur.parse_usize(),
            "positions" => {
                cur.expect(b'[');
                if cur.peek() != Some(b']') {
                    loop {
                        cur.expect(b'[');
                        let fen = cur.parse_string();
                        cur.expect(b',');
                        let moves = cur.parse_string();
                        cur.expect(b']');
                        positions.push((fen, moves));
                        if cur.peek() == Some(b',') {
                            cur.pos += 1;
                        } else {
                            cur.expect(b']');
                            break;
                        }
                    }
                } else {
                    cur.pos += 1;
                }
            }
            _ => cur.skip_value(),
        }
        if cur.peek() == Some(b',') {
            cur.pos += 1;
        } else {
            cur.expect(b'}');
            break;
        }
    }
    Fixture {
        position_count,
        move_count,
        positions,
    }
}

#[test]
fn parity_with_chess_js() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/chess_js_parity.json");
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("failed to read {path}: {e}"));
    let fixture = parse_fixture(&text);
    assert!(
        fixture.positions.len() >= 10_000,
        "expected at least 10,000 positions, got {}",
        fixture.positions.len()
    );
    assert_eq!(fixture.positions.len(), fixture.position_count);

    let mut checked_moves = 0usize;
    for (idx, &(fen, packed)) in fixture.positions.iter().enumerate() {
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

    assert_eq!(checked_moves, fixture.move_count);
    println!(
        "chess.js parity: {} positions, {} legal moves matched (UCI, SAN, and after-FEN)",
        fixture.positions.len(),
        checked_moves
    );
}
