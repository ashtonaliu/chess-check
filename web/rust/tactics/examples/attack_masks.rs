// Reads one 64-byte board per line and writes 64 hexadecimal attack masks.
use chess_check_tactics::attacks;
use std::io::{self, BufRead, Write};

fn main() -> io::Result<()> {
    let mut output = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let mut board: [u8; 64] = line?
            .into_bytes()
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "expected 64 squares"))?;
        for square in &mut board {
            if *square == b'.' {
                *square = 0;
            }
        }
        for square in 0..64 {
            if square != 0 {
                write!(output, " ")?;
            }
            write!(output, "{:016x}", attacks(&board, square))?;
        }
        writeln!(output)?;
    }
    output.flush()
}
