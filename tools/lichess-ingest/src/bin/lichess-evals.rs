use std::{
    fs::{self, File},
    io::{BufRead, BufReader},
    path::PathBuf,
    time::Instant,
};

use anyhow::{Result, ensure};
use clap::Parser;
use lichess_ingest::{parquet, peak_rss_bytes};
use serde::{Deserialize, Serialize};
use shakmaty::{CastlingMode, Chess, EnPassantMode, fen::Epd, uci::UciMove};
use xxhash_rust::xxh3::xxh3_64;

parquet::table! {
    Evaluation {
        fen: String, depth: i32, knodes: i32, best_uci: String, second_uci: String,
        cp: i32, mate: i32, second_cp: i32, second_mate: i32,
    }
}

#[derive(Deserialize)]
struct Entry<'a> {
    fen: &'a str,
    #[serde(borrow)]
    evals: Vec<Search<'a>>,
}

#[derive(Deserialize)]
struct Search<'a> {
    depth: i32,
    knodes: i32,
    #[serde(borrow)]
    pvs: Vec<Variation<'a>>,
}

#[derive(Deserialize)]
struct Variation<'a> {
    cp: Option<i32>,
    mate: Option<i32>,
    line: &'a str,
}

impl Variation<'_> {
    fn scored(&self) -> bool {
        match (self.cp, self.mate) {
            (Some(_), None) => true,
            (None, Some(mate)) => mate != 0,
            _ => false,
        }
    }

    fn root(&self, board: &Chess) -> Option<UciMove> {
        let uci: UciMove = self.line.split_ascii_whitespace().next()?.parse().ok()?;
        Some(uci.to_move(board).ok()?.to_uci(CastlingMode::Standard))
    }
}

fn best_search(entry: Entry<'_>) -> Option<Evaluation> {
    if !entry
        .evals
        .iter()
        .any(|search| search.depth >= 10 && search.pvs.len() >= 2)
    {
        return None;
    }
    let board: Chess = entry
        .fen
        .parse::<Epd>()
        .ok()?
        .into_position(CastlingMode::Standard)
        .ok()?;
    let (search, best, second) = entry
        .evals
        .iter()
        .filter_map(|search| {
            let [first, second, ..] = search.pvs.as_slice() else {
                return None;
            };
            if search.depth < 10 || !first.scored() || !second.scored() {
                return None;
            }
            let a = first.root(&board)?;
            let b = second.root(&board)?;
            (a != b).then_some((search, a, b))
        })
        .max_by_key(|(search, _, _)| (search.depth, search.knodes))?;
    Some(Evaluation {
        fen: Some(Epd::from_position(&board, EnPassantMode::Legal).to_string()),
        depth: Some(search.depth),
        knodes: Some(search.knodes),
        best_uci: Some(best.to_string()),
        second_uci: Some(second.to_string()),
        cp: search.pvs[0].cp,
        mate: search.pvs[0].mate,
        second_cp: search.pvs[1].cp,
        second_mate: search.pvs[1].mate,
    })
}

const BUCKETS: usize = 128;
const BATCH_ROWS: usize = 8192;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    byte_budget: u64,
    #[arg(long)]
    max_rows: Option<u64>,
}

#[derive(Default, Serialize)]
struct Stats {
    records: u64,
    eligible: u64,
    malformed_json: u64,
    staging_bytes: u64,
    seconds: f64,
    peak_rss_bytes: u64,
}

#[derive(Default)]
struct Bucket {
    rows: Vec<Evaluation>,
    shards: usize,
}

impl Bucket {
    fn flush(&mut self, id: usize, args: &Args, stats: &mut Stats) -> Result<()> {
        let bytes = parquet::encode(Evaluation::batch(&self.rows)?)?;
        stats.staging_bytes += bytes.len() as u64;
        ensure!(
            stats.staging_bytes <= args.byte_budget,
            "evaluation staging would exceed its byte budget"
        );
        let folder = args.output.join(format!("bucket-{id:03}"));
        if self.shards == 0 {
            fs::create_dir(&folder)?;
        }
        parquet::publish(
            &folder.join(format!("part-{:05}.parquet", self.shards)),
            &bytes,
        )?;
        self.shards += 1;
        self.rows.clear();
        Ok(())
    }
}

fn main() -> Result<()> {
    let args = Args::parse();
    let started = Instant::now();
    let mut input = BufReader::with_capacity(
        256 * 1024,
        zstd::stream::read::Decoder::new(File::open(&args.input)?)?,
    );
    fs::create_dir(&args.output)?;
    let mut buckets: Vec<Bucket> = (0..BUCKETS).map(|_| Bucket::default()).collect();
    let mut stats = Stats::default();
    let mut line = Vec::new();
    while args.max_rows.is_none_or(|max| stats.records < max)
        && input.read_until(b'\n', &mut line)? != 0
    {
        stats.records += 1;
        match serde_json::from_slice(&line) {
            Ok(entry) => {
                if let Some(row) = best_search(entry) {
                    let fen = row.fen.as_ref().expect("eligible search has a FEN");
                    let id = (xxh3_64(fen.as_bytes()) % BUCKETS as u64) as usize;
                    let bucket = &mut buckets[id];
                    stats.eligible += 1;
                    bucket.rows.push(row);
                    if bucket.rows.len() >= BATCH_ROWS {
                        bucket.flush(id, &args, &mut stats)?;
                    }
                }
            }
            Err(_) => stats.malformed_json += 1,
        }
        line.clear();
        if stats.records.is_multiple_of(10_000_000) {
            eprintln!(
                "Scanned {} evaluation records, retained {}",
                stats.records, stats.eligible
            );
        }
    }
    for (id, bucket) in buckets.iter_mut().enumerate() {
        if !bucket.rows.is_empty() {
            bucket.flush(id, &args, &mut stats)?;
        }
    }
    if stats.eligible == 0 {
        buckets[0].flush(0, &args, &mut stats)?;
    }
    stats.seconds = started.elapsed().as_secs_f64();
    stats.peak_rss_bytes = peak_rss_bytes();
    println!("{}", serde_json::to_string(&stats)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_deepest_qualifying_search_and_normalizes_castling() {
        let entry = serde_json::from_str(
            r#"{
            "fen":"r3k2r/8/8/8/8/8/8/R3K2R w KQkq -",
            "evals":[
                {"depth":30,"knodes":10,"pvs":[{"cp":10,"line":"e1a1"}]},
                {"depth":9,"knodes":15,"pvs":[{"cp":99,"line":"e1h1"},{"cp":0,"line":"a1a2"}]},
                {"depth":20,"knodes":20,"pvs":[{"mate":2,"line":"e1h1"},{"cp":0,"line":"a1a2"}]},
                {"depth":21,"knodes":21,"pvs":[{"line":"e1h1"},{"cp":0,"line":"a1a2"}]}
            ]}"#,
        )
        .unwrap();
        let chosen = best_search(entry).unwrap();
        assert_eq!(chosen.depth, Some(20));
        assert_eq!(chosen.best_uci.as_deref(), Some("e1g1"));
        assert_eq!(chosen.second_uci.as_deref(), Some("a1a2"));
        assert_eq!(chosen.mate, Some(2));
    }

    #[test]
    fn keeps_legal_en_passant_but_drops_phantom_target() {
        let row = |fen, first| {
            let entry = Entry {
                fen,
                evals: vec![Search {
                    depth: 10,
                    knodes: 10,
                    pvs: vec![
                        Variation {
                            cp: Some(100),
                            mate: None,
                            line: first,
                        },
                        Variation {
                            cp: Some(0),
                            mate: None,
                            line: "e1d1",
                        },
                    ],
                }],
            };
            best_search(entry).unwrap().fen.unwrap()
        };
        assert!(row("4k3/8/8/3pP3/8/8/8/4K3 w - d6", "e5d6").ends_with("d6"));
        assert!(row("4k3/8/8/3p4/8/8/8/4K3 w - d6", "e1e2").ends_with('-'));
    }
}
