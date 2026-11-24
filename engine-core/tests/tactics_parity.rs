use std::fs;

use engine_core::Position;

#[test]
fn tactics_motifs_match_python_on_3000_lichess_puzzles() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../web/test/fixtures/tactics.json"
    );
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("failed to read {path}: {e}"));
    let fixture: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("failed to parse {path}: {e}"));
    let positions = fixture["positions"].as_array().unwrap();
    assert!(
        positions.len() >= 3_000,
        "expected at least 3,000 puzzle positions, got {}",
        positions.len()
    );

    for (idx, item) in positions.iter().enumerate() {
        let fen = item["fen"].as_str().unwrap();
        let from = item["from"].as_str().unwrap();
        let to = item["to"].as_str().unwrap();
        let promo = item["promotion"].as_str().unwrap_or("");
        let uci = format!("{from}{to}{promo}");
        let expected: Vec<&str> = item["motifs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();

        let pos: Position = fen
            .parse()
            .unwrap_or_else(|e| panic!("puzzle {idx} failed to parse FEN {fen}: {e}"));
        let mv = pos
            .legal_moves()
            .into_iter()
            .find(|m| m.to_string() == uci)
            .unwrap_or_else(|| panic!("puzzle {idx} ({fen}) missing legal move {uci}"));
        let got = pos.motifs(mv).to_names();
        assert_eq!(
            got, expected,
            "puzzle {idx} ({fen} {uci}) motif mismatch"
        );
    }

    println!(
        "tactics parity: {} Lichess puzzle positions matched exactly",
        positions.len()
    );
}
