mod games;
mod parquet;

use std::{
    collections::BTreeMap,
    fs::{self, File},
    path::PathBuf,
    time::Instant,
};

use anyhow::{Context, Result, ensure};
use clap::Parser;
use games::{Game, GameReader, MoveRow};
use serde::Serialize;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    position_mod: u64,
    #[arg(long, default_value_t = 0)]
    bucket: u64,
    #[arg(long)]
    byte_budget: u64,
    #[arg(long)]
    max_games: Option<u64>,
    #[arg(long)]
    measure_only: bool,
}

#[derive(Default, Serialize)]
struct Stats {
    games: u64,
    sampled_games: u64,
    positions: u64,
    game_bytes: u64,
    position_bytes: u64,
    exclusions: BTreeMap<String, u64>,
    seconds: f64,
    peak_rss_bytes: u64,
}

fn flush(
    index: u64,
    args: &Args,
    stats: &mut Stats,
    games: &mut Vec<Game>,
    positions: &mut Vec<MoveRow>,
) -> Result<()> {
    let game_bytes = parquet::encode(Game::batch(games)?)?;
    let position_bytes = parquet::encode(MoveRow::batch(positions)?)?;
    stats.game_bytes += game_bytes.len() as u64;
    stats.position_bytes += position_bytes.len() as u64;
    ensure!(
        stats.game_bytes + stats.position_bytes <= args.byte_budget,
        "output would exceed the {}-byte budget at shard {index}",
        args.byte_budget
    );
    if !args.measure_only {
        let name = format!("part-{index:05}.parquet");
        parquet::publish(&args.output.join("positions").join(&name), &position_bytes)?;
        parquet::publish(&args.output.join("games").join(&name), &game_bytes)?;
    }
    games.clear();
    positions.clear();
    Ok(())
}

fn peak_rss_bytes() -> u64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
        return 0;
    }
    let units = if cfg!(target_os = "macos") { 1 } else { 1024 };
    usage.ru_maxrss as u64 * units
}

fn ingest(args: Args) -> Result<()> {
    ensure!(
        args.bucket < args.position_mod,
        "bucket must be less than position modulus"
    );
    let started = Instant::now();
    let input =
        File::open(&args.input).with_context(|| format!("open {}", args.input.display()))?;
    let mut reader = pgn_reader::Reader::new(zstd::stream::read::Decoder::new(input)?);
    let mut visitor = GameReader {
        modulus: args.position_mod,
        bucket: args.bucket,
    };
    if !args.measure_only {
        fs::create_dir(&args.output)?;
        fs::create_dir(args.output.join("games"))?;
        fs::create_dir(args.output.join("positions"))?;
    }
    let mut stats = Stats::default();
    let mut games = Vec::new();
    let mut positions = Vec::new();
    let mut index = 0;
    while args.max_games.is_none_or(|max| stats.games < max) {
        let Some((game, board_rows)) = reader.read_game(&mut visitor)? else {
            break;
        };
        stats.games += 1;
        stats.sampled_games += u64::from(!board_rows.is_empty());
        stats.positions += board_rows.len() as u64;
        if let Some(exclusion) = &game.exclusion {
            *stats.exclusions.entry(exclusion.clone()).or_default() += 1;
        }
        games.push(game);
        positions.extend(board_rows);
        if games.len() >= 65_536 || positions.len() >= 262_144 {
            flush(index, &args, &mut stats, &mut games, &mut positions)?;
            index += 1;
        }
        if stats.games.is_multiple_of(5_000_000) {
            eprintln!(
                "Scanned {} games, wrote {} position rows",
                stats.games, stats.positions
            );
        }
    }
    if !games.is_empty() || index == 0 {
        flush(index, &args, &mut stats, &mut games, &mut positions)?;
    }
    stats.seconds = started.elapsed().as_secs_f64();
    stats.peak_rss_bytes = peak_rss_bytes();
    println!("{}", serde_json::to_string(&stats)?);
    Ok(())
}

fn main() -> Result<()> {
    ingest(Args::parse())
}
