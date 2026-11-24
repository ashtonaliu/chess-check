use std::fs;

use engine_core::{BOARD_PLANES, MOVE_FEATURE_COUNT, Position};

const PACKED_BYTES: usize = BOARD_PLANES * 8;
const PACKED_B64_LEN: usize = PACKED_BYTES * 4 / 3;

fn b64_val(byte: u8) -> u8 {
    match byte {
        b'A'..=b'Z' => byte - b'A',
        b'a'..=b'z' => byte - b'a' + 26,
        b'0'..=b'9' => byte - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => panic!("invalid base64 byte: {}", char::from(byte)),
    }
}

fn decode_board_planes(b64: &str) -> [u64; BOARD_PLANES] {
    let bytes = b64.as_bytes();
    assert_eq!(bytes.len(), PACKED_B64_LEN, "unexpected base64 length");
    let mut raw = [0u8; PACKED_BYTES];
    let (quads, rem) = bytes.as_chunks::<4>();
    assert!(rem.is_empty());
    for (idx, &[a, b, c, d]) in quads.iter().enumerate() {
        let v0 = b64_val(a);
        let v1 = b64_val(b);
        let v2 = b64_val(c);
        let v3 = b64_val(d);
        let out = idx * 3;
        raw[out] = (v0 << 2) | (v1 >> 4);
        raw[out + 1] = (v1 << 4) | (v2 >> 2);
        raw[out + 2] = (v2 << 6) | v3;
    }
    let (chunks, rem) = raw.as_chunks::<8>();
    assert!(rem.is_empty());
    std::array::from_fn(|plane| u64::from_le_bytes(chunks[plane]))
}

#[test]
fn find_rate_features_and_board_encoding_match_python() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/find_rate_features.json"
    );
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("failed to read {path}: {e}"));
    let fixture: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("failed to parse {path}: {e}"));

    assert_eq!(
        fixture["board_planes"].as_u64().unwrap() as usize,
        BOARD_PLANES
    );
    assert_eq!(fixture["bitorder"].as_str().unwrap(), "little");
    let position_count = fixture["position_count"].as_u64().unwrap() as usize;
    let positions = fixture["positions"].as_array().unwrap();
    assert!(
        positions.len() >= 10_000,
        "expected at least 10,000 positions, got {}",
        positions.len()
    );
    assert_eq!(positions.len(), position_count);

    for (idx, item) in positions.iter().enumerate() {
        let row = item.as_array().unwrap();
        assert_eq!(
            row.len(),
            4,
            "position {idx} expected [fen, uci, feats, b64]"
        );
        let fen = row[0].as_str().unwrap();
        let uci = row[1].as_str().unwrap();
        let expected_feats_val = row[2].as_array().unwrap();
        assert_eq!(expected_feats_val.len(), MOVE_FEATURE_COUNT);
        let expected_feats: [i32; MOVE_FEATURE_COUNT] =
            std::array::from_fn(|i| expected_feats_val[i].as_i64().unwrap() as i32);
        let expected_planes = decode_board_planes(row[3].as_str().unwrap());

        let pos: Position = fen
            .parse()
            .unwrap_or_else(|e| panic!("position {idx} failed to parse FEN {fen}: {e}"));
        let mv = pos
            .legal_moves()
            .into_iter()
            .find(|m| m.to_string() == uci)
            .unwrap_or_else(|| panic!("position {idx} ({fen}) missing legal move {uci}"));

        let actual_feats = pos.move_features(mv).to_array();
        assert_eq!(
            actual_feats, expected_feats,
            "position {idx} ({fen} {uci}) move_features mismatch"
        );

        let actual_planes = pos.encode_board_planes(mv);
        assert_eq!(
            actual_planes, expected_planes,
            "position {idx} ({fen} {uci}) board planes mismatch"
        );

        let tensor = pos.encode_board(mv);
        for (plane, &mask) in expected_planes.iter().enumerate() {
            let base = plane * 64;
            for sq in 0..64 {
                let expected_val = if (mask >> sq) & 1 != 0 {
                    1.0f32
                } else {
                    0.0f32
                };
                assert_eq!(
                    tensor[base + sq],
                    expected_val,
                    "position {idx} ({fen} {uci}) tensor[{plane}, {sq}] mismatch"
                );
            }
        }
    }

    println!(
        "find-rate feature parity: {} positions matched (16 move features and 21x8x8 board planes)",
        positions.len()
    );
}
