# Plan: three technical projects

Status: not started. Order: A, then B, then C. Each phase ships as its own pull requests and its
own write-up, and each one ends in a measured result. If a phase's main result is negative, that is
still a finished phase: report it the way the odds study reports its null results.

| Phase | What | New technology | Main number |
|---|---|---|---|
| A | A Lichess data pipeline | Rust (`pgn-reader`, `shakmaty`), streaming Parquet, out-of-core DuckDB | Games per second and rows stored, with a label coverage rate |
| B | A neural model of which moves humans find | PyTorch on board tensors, quantization, in-browser inference | Log loss and calibration against the current find-rate models |
| C | The offscreen page's chess work in Rust/WebAssembly | Rust, bitboard move generation, `wasm-bindgen` | Time per position and per profile build, before and after |

## Ground rules for every phase

- **Branches and pull requests.** Work on `codex/<phase>-<topic>` branches. Keep each pull request
  reviewable (under about 800 changed lines, excluding generated files and fixtures). Commits and
  PR descriptions are written as Ashton. Do not add Co-Authored-By trailers, "Generated with"
  lines, session links or emoji footers.
- **CI stays green.** `.venv/bin/python -m pytest -q`, `cd web && npm test`, `npm run build` and
  `bash scripts/build_extension.sh` must pass on every PR. TypeScript runs with `noUnusedLocals`
  and `noUnusedParameters`.
- **The engine dataset is finished.** `data/engine/v1` (49,148,840 positions from 664,898 Chess.com
  blitz games, Stockfish 19, depth 10, two lines, depth-14 recheck; see `docs/engine-study-plan.md`)
  is read through `chesscheck.dataset` and DuckDB. Never run Stockfish over it again. New Stockfish
  runs are allowed only on new data, and only inside the budget given below.
- **Fair play.** The extension computes and shows nothing about a game until Chess.com confirms it is
  finished. Nothing in these phases may change that. Do not open Chess.com's Play page during testing,
  and test only on finished games.
- **Data and privacy.** Large data goes under `data/` (already in `.gitignore`). Never commit raw
  downloads, Parquet shards or model checkpoints. Small test fixtures are fine. Lichess data is
  released under CC0; record the source URL, file name, size and SHA-256 of every download in a
  manifest like `data/engine/v1/runs.json`. For Phase A the existing files, archives, outputs and
  temporary files together must fit within 150 GB under `data/`.
- **Write-ups.** Each phase adds a section to `docs/methods.md` and, where there is a headline
  number, a row or table to the README's Results. Follow the existing voice: first person, plain,
  specific numbers, few contractions, American spelling, no em dashes, no ellipses, and no "not X,
  but Y". Report what was measured, on what machine, how many runs, and what was not tested.
- **Measure before claiming.** Every number in a write-up comes from a script in `scripts/` that can
  be rerun. State the hardware (Ashton's M5 Pro Mac: 18 cores, 6 super and 12 performance).
- **Resume bullet.** End each phase's PR description with one draft resume bullet that uses only
  numbers from that phase's write-up.

---

## Phase A: Lichess data pipeline

### Goal

Build a pipeline that streams Lichess's public game exports into partitioned Parquet with
per-move rows at a scale that does not fit in memory. Aim for labeled training data for phase B
across all five clocked Lichess speeds and a wide rating range. The current find-rate model only
covers Chess.com blitz from 1200 to 2000, because that is all `data/engine/v1` has.

### Sources

I checked the Lichess documentation, HTTP sizes and a small prefix of each compressed export on
November 20, 2026. Record the exact inputs used for the runs in the write-up.
[Lichess open database](https://database.lichess.org/)

1. **Rated standard games.** The October 2026 `.pgn.zst` is 31.0 GB compressed with 95,395,628 games
   listed. PGN headers include pregame Glicko-2 ratings, UTC start time, time control, opening and
   result. Lichess documents whole-second `[%clk]` comments since April 2017 and White-perspective
   `[%eval]` comments in about 6% of games. [Game export](https://database.lichess.org/#standard_games)
2. **Evaluations.** `lichess_db_eval.jsonl.zst` was 22.5 GB compressed. Each record has a four-field
   FEN and evaluations from different Stockfish searches. Some have a single principal variation.
   An eligible search supplies at least two lines with centipawn or mate scores and UCI_Chess960 moves.
   Stream this export once into Parquet keyed by normalized FEN, keeping only the deepest eligible
   search at depth 10 or higher per position. Report row count, Parquet bytes and conversion time.
   The export has depth and node counts. Engine version and WDL are absent from its schema.
   [Evaluation export](https://database.lichess.org/#evals)
3. **Puzzles.** `lichess_db_puzzle.csv.zst` was 310 MB compressed. Apply the first UCI move to the
   exported FEN to reach the position shown to the solver. The solution starts with the second move.
   The rating reflects Glicko-2 results of solving attempts. `data/puzzles_50k.csv` is a sample.
   [Puzzle export](https://database.lichess.org/#puzzles)

### Labels: the main design question

A find-rate row needs a position where one move clearly beats the others, the move the player
chose, and Stockfish's best move. The game PGNs lack a consistent pair of scored lines. Try the
evaluation join first and use the local engine if the join leaves too few usable labels.

1. **Join game positions to the evaluations export by position.** Normalize FENs the same way on both
   sides (piece placement, side to move, castling and en passant only). Measure the share of
   eligible move rows with at least two lines from the same search at depth 10 or more, plus the
   critical rows yielded by the join. Use the deepest qualifying search and normalize castling
   moves before comparing them. Report coverage and yield by ply, phase, time control and rating.
   Unmatched moves have unknown criticality. Estimate coverage among critical positions only with
   a reference sample drawn independently of the join, using the budget in option 2 if needed.
2. **Run Stockfish on a sample of new Lichess positions** with the same settings as v1
   (`data/engine/v1/runs.json`: Stockfish 19, depth 10, two lines, win/draw/loss on, 32 MB hash,
   one thread per worker). Budget: at most 12 hours of wall time on Ashton's Mac. Before the full
   run, time 1,000 positions and project the total. Sample by a hash of the game ID so the sample is
   reproducible, and stratify so each time control and each 200-point rating band has at least
   20,000 critical positions where possible. Store results in a new dataset, `data/engine/lichess-v1`,
   with the same position columns as v1, so `chesscheck.dataset` can read both.
3. **Puzzles as a separate difficulty signal.** Lichess selects puzzles from real games and rates
   them from solve attempts. Keep these ratings as a separate input or evaluation in phase B.

### Pipeline design

- **Ingest in Rust.** Write a small command-line tool (for example `tools/lichess-ingest/`, a Cargo
  workspace) using the `pgn-reader` and `shakmaty` crates to parse PGN and replay moves, `zstd` to
  read the compressed file as a stream, and the `arrow` and `parquet` crates to write shards. It
  reads one month file and writes `games/part-*.parquet` and `positions/part-*.parquet`, each shard
  under about 256 MB. Never hold a whole month in memory. Python with python-chess is too slow at this
  scale; if you think otherwise, time both on the same 100,000 games and put the numbers in the
  write-up.
- **Sampling while streaming.** Scan the whole archive and write every game to the games table.
  Choose a game-ID hash bucket for position rows and print the size projection before writing.
  The 1% comparison keeps the same games table and uses a smaller position bucket.
- **Filters.** Rated standard games only. Exclude games where either player is flagged as a computer
  account (the `BOT` title), unfinished games, and games without clock comments from position rows.
  Store the reason on the game row and report counts. Illegal moves are detected on replay.
- **Schema.** Match v1 where it can, so one reader works for both: `game_id`, `url`, `white`,
  `black`, ratings before the game (Lichess headers give these directly, unlike Chess.com), the time
  control as base and increment seconds, a source-native `time_class`, `start_ts`, `eco`, the opening
  name, the result, and `source = 'lichess'`. Per position: `ply`, `fen`, `mover`, `move_uci`,
  `move_san`, `clock_after`, `time_spent`, and `eval_cp` and `eval_mate` from `[%eval]` where present.
  Leave Stockfish columns null until a labeling step fills them. Lichess includes UltraBullet and
  Classical in its clocked speeds and starts Rapid at eight minutes of estimated time. Chess.com
  starts Rapid at ten minutes and has Daily separate from its three live rating classes. Count
  correspondence and other non-clocked games separately from the clocked sample.
  [Lichess speeds](https://lichess.org/faq)
  [Chess.com time classes](https://support.chess.com/en/articles/8705367-why-are-there-different-ratings-in-live-chess)
- **Python side.** Extend `chesscheck.dataset` (or add `chesscheck/lichess_dataset.py`) with DuckDB
  views over the new Parquet, using the same conventions: shards read in place, a games shard is the
  completion marker, temporary files ignored.
- **Rating scales.** Lichess and Chess.com ratings are not on the same scale. Never compare them as if
  they were. Keep `source` on every row, and if you need a conversion for a figure, fit it from data
  and say how.

Build with `cargo build --locked --release --manifest-path tools/lichess-ingest/Cargo.toml`.
Run `python scripts/lichess_data.py fetch games evals`, then
`python scripts/lichess_data.py ingest`. The ingest prints its projection and saves its counters in
`data/lichess/2026-10/run.json`. Add `--one-percent` for the comparison run.

### Tests

- Rust unit tests on a handful of PGNs, including promotions, castling, en passant, games with and
  without `[%eval]`, and a malformed game that must be skipped and counted rather than stop the run.
- A Python test that reads a small fixture written by the Rust tool through the DuckDB views and
  checks row counts and a few known values.
- A parity check: for 1,000 sampled games, the FEN after every move matches python-chess.

### What to measure and report

- Throughput in games scanned and kept per second and positions written per second on the same
  month for the 1% and budgeted position buckets, with wall time, peak memory and output size.
- How many games each filter removed.
- Label coverage and critical-row yield from option 1 by ply, phase, time control and rating, and
  the decision they led to.
- If option 2 runs: positions searched, wall time, and the stratified counts per time control and
  rating band.
- The final training table for phase B: rows, players, and counts by source, time control and rating
  band.

### Done when

A rerunnable script produces the Parquet dataset and the labeled table from a downloaded month; the
DuckDB views read it; tests pass; and `docs/methods.md` has a "Lichess dataset" section with the
numbers above.

---

## Phase B: a neural find-rate model

### Goal

Predict whether a player at a given rating and time control finds the best move in a critical
position (best move at least 20 win-chance points better than the second), well enough to beat the
current models, and run it in the extension. Today's numbers on Chess.com blitz, held-out players
(`scripts/eval_find_rate.py`, `docs/methods.md`, "How often players find the only good move"):

| Model | Log loss | Brier | AUC |
|---|---:|---:|---:|
| Rating, clock and the move's features (logistic, shipped) | 0.4410 | 0.1428 | 0.758 |
| All features, gradient boosting | 0.4011 | 0.1306 | 0.811 |

### Data and splits

- **Chess.com:** the existing table from `scripts/eval_find_rate.py build` (803,299 critical blitz
  positions from 59,720 players). Keep its split exactly: players whose username hash is 0 mod 5
  are held out. This held-out set is the primary benchmark, because the extension serves Chess.com
  players.
- **Lichess:** phase A's labeled table, split by a hash of the username the same way.
- Never let a player appear in both training and test data. Use a separate validation split, also by
  player, for early stopping and tuning.

### Inputs

- **Board:** an 8×8 tensor from the mover's point of view (flip the board for Black): 12 piece planes,
  plus planes for the best move's from-square and to-square, squares attacked by each side, castling
  rights and en passant. Document the exact encoding in one place and test it.
- **Scalars:** rating (standardized within each source), time control (one-hot), clock fraction, and a
  source flag. Optionally the existing hand-made move features, so the comparison shows what the
  network adds beyond them.
- Do not use Stockfish's numbers (gap, win chance) in the shipped model unless the extension has them
  at review time. It does have them for queued positions, so test both with and without, as the
  current study does.

### Model

- Start small: a few convolutional layers or residual blocks with 32 to 64 channels, then concatenate
  the scalars and add a small dense head ending in a sigmoid. Aim for under 500,000 parameters, so
  the quantized model stays under about 1 MB.
- Train with PyTorch, using binary cross-entropy, AdamW, early stopping on validation log loss and a
  fixed seed. Log every run's settings and scores to a file under `eval_results/`.
- Calibrate on the validation set if needed (temperature scaling is enough), and report calibration
  curves.

### Evaluation

- Primary: log loss, Brier and AUC on held-out Chess.com players, against the logistic and
  gradient-boosting rows above on the same rows. Bootstrap the difference by player (90% intervals,
  2,000 resamples), as the existing studies do.
- Calibration by 200-point rating band and by time control, on each source.
- Does adding Lichess data help on Chess.com? Train with and without it and compare on the Chess.com
  held-out set. Report the answer either way.
- Ablations: board tensor only; scalars and hand-made features only; both.

### In the browser

- Export to ONNX and quantize to int8. Check that the quantized model's probabilities match the float
  model within 0.005 on the held-out set.
- Pick the inference runtime by measuring two options in the offscreen page: ONNX Runtime Web (WASM
  backend) and a hand-written forward pass in TypeScript reading the exported weights. Budgets: the
  extension ZIP grows by at most 3 MB, and one prediction takes under 2 ms at the median and under
  10 ms at the 95th percentile. If ONNX Runtime Web is over budget, the hand-written pass is the
  default.
- Keep the interface of `web/src/browser/findRate.ts` (`findRate(fen, best, rating)`) so callers do
  not change. Add the time control and source as inputs where the review item has them.
- Add a parity test like `web/test/findRate.test.ts`: on 300 held-out positions, the encoding matches
  Python exactly and the probabilities match within 0.001.
- Only widen `RATE_RANGE` in `web/src/browser/rateRange.ts`, or show the rate for bullet and rapid,
  where the calibration tables show the model is calibrated within 3 points for that band and time
  control. Say in the write-up which bands are shown and why.
- Fair play does not change: the model scores positions from finished games in the review queue only.

### Done when

The model beats the shipped logistic model on held-out Chess.com players with an interval that
excludes zero (or the write-up says it did not); the extension uses it within the budgets; the parity
test passes; and `docs/methods.md` has a section with the tables above, calibration by band, the
Lichess ablation, and the browser timings.

---

## Phase C: the offscreen page's chess work in Rust and WebAssembly

### Goal

Speed up the extension's analysis by moving its chess logic from chess.js to a Rust move generator
compiled to WebAssembly, and measure the effect on profile builds.

### Profile first

`docs/methods.md` found that the offscreen page's own thread limited profile builds, and fixed the
largest cost: `moves({ verbose: true })` took 0.80 ms of about 1.0 ms per position, and the plain SAN
list now gives the same counts in 0.06 ms. So the old bottleneck is gone, and this phase starts by
finding the current one.

- Profile a 50-game and a 150-game profile build in the development harness (`extension/dev.html`)
  with phase B's model in place, using the Chrome performance panel, plus timers around each stage:
  game parsing (`web/src/browser/games.ts`), the engine pass and recheck (`engine.ts`), tactics
  (`tactics.ts`, `tacticsWorker.ts`), find-rate features and model input, and the recap.
- Report the share of offscreen main-thread time in chess.js calls, by caller.
- **Decision gate:** if chess.js work is under 20% of a build's wall time, a Rust rewrite cannot speed
  up builds by much. In that case, write up the profile, rewrite only the largest chess.js consumer,
  and report its own speedup rather than claiming a faster build. Do not stretch the claim.

### Build

- A Rust crate (for example `engine-core/`) with its own bitboard move generator: magic bitboards or
  another standard approach for sliding pieces, and make and unmake. Writing the generator is the
  point of this phase, so do not wrap `shakmaty` here. Phase A's tool can keep using `shakmaty`.
- **Correctness:** perft tests against the standard published positions (the initial position,
  "Kiwipete" and the usual set) to depth 5 or more in native tests, and fuzzing against `shakmaty`:
  random games, comparing legal move lists at every position.
- Expose only what the hot paths need through `wasm-bindgen`: load a FEN, list legal moves (UCI and
  SAN), make a move, export a FEN, counts of captures and checks, the attack maps used by the tactics
  detector, and phase B's input tensor. Pass batches of positions per call to keep the cost of
  crossing between JavaScript and WebAssembly low, and measure that cost.
- Build with `wasm-pack` or `cargo build --target wasm32-unknown-unknown` plus `wasm-bindgen`, from
  `scripts/build_extension.sh` and `npm run build`. CI needs the Rust toolchain and the wasm target.
- Keep chess.js wherever it is not on a hot path (the website's board UI, for example). Replace it
  only where the profile shows time.

### Tests

- Parity with chess.js on at least 10,000 positions from real games in the test fixtures: legal moves,
  SAN, FENs after each move, and the counts the find-rate features use.
- Tactic labels unchanged on the 3,000 Lichess puzzle positions the existing parity tests already
  check (see "Cross-language parity" in `docs/methods.md`).
- Phase B's model input identical to Python's on the same 300 positions.

### What to measure and report

- Microbenchmarks per operation (move generation, SAN, the full per-position work), chess.js against
  WASM, in Node and in Chrome.
- Whole profile builds, 50 and 150 games, at least three runs each, with fresh caches, the median and
  range, before and after. Use the same machine and the same games.
- The throttled runs from the slow-CPU test (4× and 6× CPU throttling), before and after, since slow
  machines are where offscreen work matters most.
- The size of the WebAssembly file, compressed and uncompressed, and the ZIP's growth (budget: 1 MB).

### Done when

Perft and parity pass in CI; the extension uses the WASM path for every hot call site the profile
named; the measurements above are in `docs/methods.md`; and the README's Results has the before and
after numbers.

---

## Order of work and rough size

| Phase | Pull requests | Rough effort |
|---|---|---|
| A | Rust ingest tool; DuckDB views and tests; labeling (evaluation join, then Stockfish if needed); write-up | 4 to 6 days, plus up to 12 hours of Stockfish time |
| B | Training and evaluation scripts; export and parity; browser runtime and integration; write-up | 4 to 6 days |
| C | Profile and decision write-up; Rust core with perft and fuzzing; WASM bindings and integration; benchmarks and write-up | 5 to 8 days |

Before starting each phase, post a short plan as the first PR's description: the steps, what will be
measured, and anything in this document that turned out to be wrong.
