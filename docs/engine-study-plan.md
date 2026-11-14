# Plan: the big engine study

Status: being run as a dataset, not as a prediction study. Both gates failed on 2026-11-14: a
player's 50-game tactic profile did not predict their own next-game tactical mistakes
(`scripts/eval_tactic_gate.py`), and their 50-game accuracy profile barely predicted next-game
accuracy (correlation 0.10) or who outplayed whom (0.04; `scripts/eval_accuracy_gate.py`). The run
still goes ahead to store every raw result once, so future questions (only moves, criticality,
time use, opening preparation) are queries instead of new engine runs.

## Goal

Analyze the games once, store every raw engine result, and never run Stockfish on them again.
Every future feature (accuracy, tactics by motif, only moves, criticality, time use, conversion,
draw tendency, opening preparation, style) should be a query on the stored data.

## Games

- All 60 recent blitz target games of the 250 focal players in `data/odds/v3` (15,000 targets),
  not the 995-game sample. 995 games can only detect effects of about 10 points per game; 15,000
  should reach about 2 to 2.5.
- Each focal player's history reused across their targets (consecutive windows overlap, so about
  110 games per player), and each opponent's 50 blitz games that ended before the target's PGN
  start time. Store 50, not 20: shorter histories can be cut from longer ones later.
- About 780,000 games and 26 million positions. Codex's existing cache cannot be reused: it kept
  summary numbers, not lines, second-best moves or win/draw/loss.
- Download histories on this Mac first (Chess.com API, at most 2 requests at a time, back off on
  429). Blitz only, to match the rest of the odds work.

## Engine

- Stockfish 19 (official release, 2026-09-05), Homebrew build for Apple Silicon, default network
  `nn-1a298aa575a0.nnue`. Not a development build: results must be reproducible.
- Depth 10, MultiPV 2, `UCI_ShowWDL` on, Threads 1 per process, fixed Hash, new game (clear hash)
  per game so results are reproducible.
- Re-check positions with a big drop (win-% loss >= 20, about 5% of moves) at depth 14, the same
  as the app's own blunder check.
- Before the run, a 5-minute timing pass on a few hundred games: depth 8 vs 10, a fixed node
  budget (e.g. 100,000 nodes) vs depth 10, and 6 / 12 / 17 / 18 workers. Pick by speed and by how
  steady the per-player numbers are.
- Workers: 17 on this 18-core Mac (6 performance + 12 efficiency cores), one Stockfish process
  per worker; 18 measured no faster. About 12 if the Mac is in use.

## Measured time

`scripts/engine_dataset.py benchmark` on 170 games (short batches slightly understate speed):

| Setting | Games per second | About 780,000 games |
|---|---:|---:|
| Depth 10, MultiPV 2, 17 workers (chosen) | 4.9 | 40 to 44 h |
| Depth 8, MultiPV 2, 17 workers | 8.5 | 25 h |
| Depth 10, MultiPV 1, 17 workers | 7.4 | 29 h |
| Depth 10, MultiPV 2, 12 workers | 3.7 | 58 h |
| Depth 10, MultiPV 2, 18 workers | 4.7 | 46 h |

One worker took about 2 seconds per game with the depth-14 re-check. The earlier 28-hour estimate
was too low: MultiPV 2 and the re-check cost more than assumed. The run is resumable, so it is
spread over three or four nights.

GPU: not useful for Stockfish. Leela (lc0) on the Apple GPU could do value-only evaluations faster
but misses short tactics; not used here. Cloud (AWS c7a.24xlarge spot, about $1.30 to $2.30/h)
would take 2.5 to 3 h for under $10; decided to use the Mac.

## Storage

Parquet shards written and queried with DuckDB (no pyarrow needed), under `data/engine/v1/` (gitignored). The script is `scripts/engine_dataset.py` (`select`, `benchmark`, `analyze`). Chosen over JSON per
game (too many files, slow), SQLite (slow scans), MySQL/Postgres (server, slower scans) and a
single DuckDB file (one writer only). Parquet also loads straight into BigQuery if wanted (the
BigQuery sandbox's free 10 GB would hold it).

- `games.parquet`, one row per game: game_id, url, white, black, stored (post-game) ratings,
  derived pre-game ratings and rating changes, result, each side's end reason, plies,
  time_class, base_seconds, increment_seconds, start_ts, end_ts, eco, opening_url, Chess.com
  accuracies when present, full PGN.
- `positions/part-NNNN.parquet`, one row per position (ply 0 = start): game_id, ply, fen,
  move_uci, move_san, mover, clock_after, time_spent, cp and mate (White's view, mate kept
  separate), wdl_w / wdl_d / wdl_l, best_uci, pv (up to 6 moves), second_uci, second_cp,
  second_mate, depth, nodes, run_id, and deep_cp / deep_mate / deep_best / deep_pv for re-checked
  positions. The evaluation after a move is the next row's.
- `players.parquet`: username, joined, account status, fetched_at.
- `runs.json`: Stockfish version, binary SHA-256, network, depth, MultiPV, hash, threads, script
  git commit, start and end. A different setting gets a new run_id; nothing is overwritten.
- Study design (which games are targets, which histories belong to which target) lives
  separately under `samples/`, so later studies can choose different targets or history lengths.

## Surviving a crash or power loss

- Each worker writes batches of about 200 games to a temporary file and renames it into place
  when complete (atomic on macOS), so a sudden power-off never leaves a half-written file.
- On restart, the script lists finished batch files, checks that each opens, deletes leftover
  temporary files and analyzes only what is missing. It refuses to resume with different
  settings.
- Run under `caffeinate` so the Mac does not sleep. A power loss costs at most the batches in
  progress.

## Evaluation (same rules as the odds experiment)

- Baseline to beat: Elo recalibrated plus colour (`scripts/fit_expected_score.py`), not raw Elo.
- Features only from games that ended before the target's start; pre-game ratings from the
  previous game; nothing from the target game except as a label.
- Nested C inside grouped folds by focal player, paired bootstrap over focal players, and the
  smallest detectable effect reported. Report nulls.
- First test predicting each player's tactical mistakes in their next game, then win/draw/loss,
  then the accuracy gap.

## What would need a new run

Other players, time controls or newer games (can be appended), more depth, MultiPV 3 or more,
lines longer than 6 moves, or a different engine. `runs.json` records exactly what the stored
data can answer.

## Background

- Guid & Bratko (2006 to 2011): relative player rankings by move quality were stable across
  engines and depths around 12; critics say shallow search misses standard moves.
- Regan & Haworth (2011 onward): Rybka 3 at depth 13; later work uses multiple candidate lines
  to value every reasonable option, which is why MultiPV 2 is stored.
- Lichess server analysis uses a node budget (reportedly 1.5 to 2.25 million nodes per move),
  far more per position than is affordable for 26 million positions.
