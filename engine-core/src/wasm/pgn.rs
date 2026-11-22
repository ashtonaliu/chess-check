use serde::Serialize;

use super::{Position, START, read_san};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Game {
    #[serde(skip_serializing_if = "Option::is_none")]
    eco: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    eco_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_fen: Option<String>,
    moves: Vec<String>,
}

/// Read the main line of a standard archive PGN. The caller falls back to the
/// permissive JS parser for unsupported syntax or moves.
pub(super) fn parse(pgn: &str) -> Option<Game> {
    let mut game = Game::default();
    let mut text = pgn.trim_start_matches('\u{feff}').trim_start();
    while text.starts_with('[') {
        let (line, rest) = text.split_once('\n').unwrap_or((text, ""));
        let tag = line.trim_end().strip_prefix('[')?.strip_suffix(']')?;
        let boundary = tag.find(char::is_whitespace)?;
        let name = &tag[..boundary];
        let value = tag[boundary..]
            .trim()
            .strip_prefix('"')?
            .strip_suffix('"')?;
        if value.contains(['"', '\\']) {
            return None;
        }
        match name {
            "ECO" => game.eco = Some(value.to_owned()),
            "ECOUrl" => game.eco_url = Some(value.to_owned()),
            "FEN" => game.start_fen = Some(value.to_owned()),
            _ => (),
        }
        text = rest.trim_start();
    }

    let mut board: Position = game.start_fen.as_deref().unwrap_or(START).parse().ok()?;
    let mut variation = 0u32;
    let mut finished = false;
    while !text.is_empty() {
        text = text.trim_start();
        match text.as_bytes().first() {
            None => break,
            Some(b'{') => text = text.split_once('}')?.1,
            Some(b'}') => return None,
            Some(b';') => text = text.split_once('\n').map_or("", |(_, rest)| rest),
            Some(b'(') => {
                variation += 1;
                text = &text[1..];
            }
            Some(b')') => {
                variation = variation.checked_sub(1)?;
                text = &text[1..];
            }
            Some(b'$') => {
                let end = text[1..].bytes().take_while(u8::is_ascii_digit).count() + 1;
                if end == 1 {
                    return None;
                }
                text = &text[end..];
            }
            _ => {
                let end = text
                    .find(|c: char| c.is_whitespace() || "{}();$".contains(c))
                    .unwrap_or(text.len());
                let token = &text[..end];
                text = &text[end..];
                if variation > 0 {
                    continue;
                }
                let numbers = token.bytes().take_while(u8::is_ascii_digit).count();
                let suffix = &token[numbers..];
                let token = if suffix.starts_with('.') {
                    suffix.trim_start_matches('.')
                } else {
                    token
                };
                match token {
                    "" => (),
                    "1-0" | "0-1" | "1/2-1/2" | "*" if !finished => finished = true,
                    _ if !finished => {
                        let mv = read_san(&board, &board.legal_moves(), token)?;
                        game.moves.push(board.san(mv));
                        board.apply(mv);
                    }
                    _ => return None,
                }
            }
        }
    }
    (variation == 0).then_some(game)
}
