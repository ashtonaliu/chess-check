// Reads a before board, after board, from/to indices and mate flag per line.
use chess_check_tactics::motifs;
use std::io::{self, BufRead, Write};

fn main() -> io::Result<()> {
    let mut output = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let line = line?;
        let fields: Vec<_> = line.split_whitespace().collect();
        let [before, after, from, to, mate] = fields.as_slice() else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "expected five fields",
            ));
        };
        let parse_board = |text: &str| -> io::Result<[u8; 64]> {
            let mut board = <[u8; 64]>::try_from(text.as_bytes())
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "expected 64 squares"))?;
            for square in &mut board {
                if *square == b'.' {
                    *square = 0;
                }
            }
            Ok(board)
        };
        let parse_square = |text: &str| {
            text.parse::<usize>()
                .ok()
                .filter(|&square| square < 64)
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid square"))
        };
        let result = motifs(
            &parse_board(before)?,
            &parse_board(after)?,
            parse_square(from)?,
            parse_square(to)?,
            *mate == "1",
        );
        writeln!(output, "{result}")?;
    }
    output.flush()
}
