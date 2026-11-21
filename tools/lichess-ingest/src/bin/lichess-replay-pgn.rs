use std::{
    collections::HashSet,
    fs::File,
    io::{self, BufRead, BufReader, BufWriter, Write},
    path::PathBuf,
};

use anyhow::{Result, ensure};
use clap::Parser;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    input: PathBuf,
}

fn extract(
    mut input: impl BufRead,
    mut output: impl Write,
    mut wanted: HashSet<Vec<u8>>,
) -> Result<()> {
    let mut line = Vec::new();
    let mut header = Vec::new();
    let mut game_id = Vec::new();
    let mut site_id = Vec::new();
    let mut moves = false;
    let mut selected = false;
    loop {
        line.clear();
        if input.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        // The rated archive emits each game's tag section at the start of its own lines.
        if line.starts_with(b"[") {
            if moves {
                if wanted.is_empty() {
                    break;
                }
                header.clear();
                game_id.clear();
                site_id.clear();
                moves = false;
                selected = false;
            }
            header.extend_from_slice(&line);
            ensure!(header.len() <= 1_000_000, "oversized PGN header");
            if let Some(value) = line.strip_prefix(b"[GameId \"") {
                game_id = id(value).to_vec();
            } else if let Some(value) = line.strip_prefix(b"[Site \"https://lichess.org/") {
                site_id = id(value)
                    .rsplit(|&byte| byte == b'/')
                    .next()
                    .unwrap_or_default()
                    .to_vec();
            }
        } else if moves {
            if selected {
                output.write_all(&line)?;
            }
        } else if !line.iter().all(|byte| byte.is_ascii_whitespace()) {
            moves = true;
            selected = wanted.remove(if game_id.is_empty() {
                &site_id
            } else {
                &game_id
            });
            if selected {
                output.write_all(&header)?;
                output.write_all(b"\n")?;
                output.write_all(&line)?;
            }
        }
    }
    output.flush()?;
    ensure!(
        wanted.is_empty(),
        "archive ended with {} selected games missing",
        wanted.len()
    );
    Ok(())
}

fn id(value: &[u8]) -> &[u8] {
    value.split(|&byte| byte == b'"').next().unwrap_or_default()
}

fn main() -> Result<()> {
    let args = Args::parse();
    let wanted: HashSet<Vec<u8>> = io::stdin()
        .lock()
        .lines()
        .map(|line| line.map(String::into_bytes))
        .collect::<io::Result<_>>()?;
    ensure!(!wanted.is_empty(), "pass the selected game IDs on stdin");
    let input = zstd::stream::read::Decoder::new(File::open(args.input)?)?;
    extract(
        BufReader::with_capacity(1024 * 1024, input),
        BufWriter::new(io::stdout().lock()),
        wanted,
    )
}
