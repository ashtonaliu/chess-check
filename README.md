# Chess Check

Chess Check works on Chess.com and Lichess. Type in a username and find out what that player is actually bad at.

**[Try the live demo](https://ashtonaliu.github.io/chess-check/)**. It runs entirely in your browser, so there is nothing to install and no account needed.

**[Get the Chrome extension](https://chromewebstore.google.com/detail/chess-check-post-game-rec/eikbpmlbeigjdfmpocihioahdjkfgcgk)** for a recap after each game you finish on Chess.com or Lichess.

![Chess Check showing key findings, tactic comparisons and annotated example positions](docs/img/screenshot.png)

## What it does

1. Downloads your recent games from the site you play on.
2. Runs the Stockfish chess engine on every move to find your mistakes, then double-checks each mistake with a deeper search.
3. Names the tactic behind each blunder (a fork you walked into, a discovered attack you missed, a free piece you left) and which piece you moved.
   Each finding opens every position behind it, worst first. You can step through what happened after your move or the line Stockfish preferred, and open the exact move on the game's site.
4. Checks each opening against what your rating predicted, so a bad result against stronger players does not count against you.
5. Estimates whether you blunder more than similar players would in the same positions, and whether time pressure is the cause.
6. Has an AI coach write a short report, then checks every number and move in it against the real data before showing it.
7. Shows a short recap after each game you finish, in the Chrome extension or on the website, and asks you to find the move you missed.

Everything is compared with your opponents in the same games. A typical result, from my own games: *"You miss discovered attacks: 18 times in positions where you blundered, against 4 for your opponents."*

## Try it

1. Open the [demo](https://ashtonaliu.github.io/chess-check/). It starts with an analysis of my own 300 blitz games.
2. Choose Chess.com or Lichess, enter any username and press Analyze. The score and opening table appear within a few seconds, and the full analysis of 150 games took about 48 seconds on Chess.com in my tests. On Lichess the table took about 7 seconds, since Lichess sends about 20 games a second, and the full analysis took about 16 seconds.
3. For the AI coaching report, paste your own [Anthropic API key](https://console.anthropic.com/settings/keys). The key only goes from your browser to Anthropic, and a report costs under one cent.

**The Chrome extension** puts a small cube on Chess.com and Lichess that you can drag anywhere, so you can study between games without leaving the site. It knows who you are from your signed-in account and needs no setup. When a game ends, the cube turns green and the recap fills in as each part is ready: the result and the upset meter at once, the turning point a few seconds later, then your patterns and your opponent's openings.

The turning point is a question. The recap says which move cost you the most and asks you to find the better one. "Find it on the board" opens the game at that move on the site's own board, where you can try moves, and "Reveal the move" shows the answer. Missed moves go into a review queue that brings each one back after 1, 3, 7 and 21 days until you find it, from the same cube, between games. Both sites forbid engine help when you play another person, so the extension computes and shows nothing about a game until it is over. [Chess.com fair play](https://www.chess.com/legal/fair-play) · [Lichess fair play](https://lichess.org/page/fair-play)

Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/chess-check-post-game-rec/eikbpmlbeigjdfmpocihioahdjkfgcgk). To run your own build instead:

1. Install the Rust target with `rustup target add wasm32-unknown-unknown` and the matching CLI with
   `cargo install --locked --version 0.2.130 wasm-bindgen-cli`.
2. Run `scripts/build_extension.sh`.
3. Open `chrome://extensions` and turn on Developer mode.
4. Click Load unpacked and choose the `extension` folder.

## Results

**Blunder model.** Predicting which moves will be blunders, tested on 14,217 moves the models never saw (AUC: 0.5 is guessing, 1.0 is perfect).

| Model | AUC |
|---|---:|
| Logistic regression | 0.82 |
| Gradient boosting | 0.84 |
| Neural network (PyTorch) | 0.85 |

The biggest predictor of a blunder is how little time is left on the clock. The site uses logistic regression because its predictions were the most accurate in the time-pressure range.

**Tactic detector.** I tested it on 20,000 Lichess puzzles, using Lichess's own theme tags as the answers.

| Tactic | Precision | Recall |
|---|---:|---:|
| Fork | 0.83 | 0.70 |
| Skewer | 0.68 | 0.51 |
| Discovered attack | 0.63 | 0.55 |
| Free piece | 0.58 | 1.00 |

Pins and back-rank mates scored too low (precision 0.49 and 0.27), so the app leaves them out.

**AI coach accuracy.** The share of numbers and moves in the coach's reports that the data could not back up, across 5 players.

| Setup | Unsupported claims |
|---|---:|
| Claude reading raw game files | 14% |
| Claude with computed facts and tools | 2% |
| Same, plus the checker and one fix | 0% |

Giving the coach computed facts makes every claim checkable, and the checker catches the rest.

**Which model writes the report.** The same coach, three Claude models, the same 5 players.

| Model | Unsupported claims, first draft | Cost per report |
|---|---:|---:|
| Opus 5.5 | 12% | $0.15 |
| Sonnet 5.5 | 12% | $0.06 |
| **Haiku 5.5** | **4%** | **$0.005** |

The smallest model was the most accurate and about 30 times cheaper than Opus, so the coach uses Haiku.

**Game search.** The coach can search your games by meaning, such as "games where I threw away a winning position". On 13 questions with known answers (share of the top 5 results that are correct):

| Search method | Precision@5 |
|---|---:|
| Keyword matching | 0.41 |
| AI embeddings | 0.35 |
| Both combined | 0.45 |

Embeddings understand rewording but confuse who did what, and keywords cover that case, so the coach uses both.

**Can anything beat the rating at predicting a game?** I tested this on the blitz histories of 12,233 players, fitting on 4.4 million player-games from before November 1 and testing on 1.5 million from after November 7 (Brier score: lower is better, 0.25 is a coin flip).

| Model | Brier score |
|---|---:|
| Elo formula | 0.23765 |
| Elo recalibrated, plus color | 0.23683 |
| Recalibrated, plus color and recent history | 0.23667 |

Most of the gain comes from fixing the formula. In matched games a rating gap matters about half as much as Elo assumes, and White scores 51.7% while Elo ignores color. History adds a little: players far below their recent average beat their rating by 2.4 points, and players score worse right after a loss. Openings, clock habits, session length, playstyles learned from 6.5 million games, and Stockfish profiles of both players' last 50 games added nothing measurable. The extension's upset meter and the report's opening tables now use the recalibrated formula.

**How hard was the move you missed?** In 803,299 positions from the engine dataset where only one move works, blitz players found it 79.3% of the time. Tested on 11,868 players the model never saw:

| Model | AUC |
|---|---:|
| Rating | 0.51 |
| Rating and clock | 0.56 |
| Plus what kind of move it is (logistic) | 0.76 |
| Gradient boosting | 0.80 |

The rating barely matters in this range; the kind of move matters a lot. Captures are easy to find, quiet moves to attacked squares are hard, and players who are already ahead find the only move less often. The extension uses the neural model below to estimate how often players near your rating find moves like it and to order the review queue.

**Neural find rate, offline.** On 157,583 held-out Chess.com blitz positions, training on Chess.com
and Lichess gave **0.40366** mean log loss for the neural model with board, context and move
features, and **0.40835** for gradient boosting with context and move features. The same neural
architecture trained on Chess.com alone scored **0.40663**. Each of those means covers three seeds.
The Chess.com-only logistic and boosting baselines scored 0.44100 and 0.40956. All fits excluded
Stockfish's numerical evaluations. [Neural training methods](docs/methods.md#training-and-evaluation)

**Engine dataset.** To make later questions cheap, I analyzed 664,898 games (49.1 million positions) once with Stockfish 19, keeping the two best moves, win/draw/loss chances and clock time for every position. It took 33 hours on my laptop, and profiles for all 171,126 players in it now take 12 seconds to compute. On all 14,739 test games, none of the engine profiles (accuracy, blunders, conversion, time trouble, form, a rating implied by move quality) improved on the odds formula. The test was precise enough to rule out effects bigger than about 2 points of expected score.

**Lichess pipeline.** I scanned every rated standard game in the October 2026 archive and wrote
board rows for a 1-in-20 game-ID bucket. The cached evaluations covered 20.92% of played moves
in that bucket and supplied 930,160 comparison labels. Classical and UltraBullet fell below
the row target. In an independent Stockfish pilot, the cache covered 1 of 57 critical positions.
Opening moves made up 86.84% of the cloud labels, and players found the best move in 87.88% of
those labels. Local Stockfish supplied 532,086 training rows, with at least 100,000 per speed
and a 73.95% overall find rate. [Lichess methods](docs/methods.md#lichess-dataset)

| Run | Rows | Parquet size | Wall time |
|---|---:|---:|---:|
| October ingest | 95,395,628 games and 315,894,636 boards | 9.05 GB | 714.3 s |
| Evaluation conversion | 193,996,647 normalized FENs | 5.46 GB | 423.4 s |

**Offscreen WebAssembly.** I used the same finished games for three cold builds per size and
backend in Chrome. Stockfish still takes most of the build time. [WebAssembly methods](docs/methods.md#webassembly-bindings)

| Bullet games | Chess.js median | WebAssembly median | Wall-time reduction |
|---|---:|---:|---:|
| 50 | 4.36 s | 3.78 s | 13.3% |
| 150 | 12.96 s | 11.50 s | 11.3% |

**Extension recap timings.** I used the same instrumented unpacked build in visible Chrome on
both sites, with three runs per case. The clock starts when the extension asks whether the game
is finished. Times are in seconds, with the median followed by the range.

| Site and case | Game confirmed | Result | Turning point | Opponent note | Full recap |
|---|---:|---:|---:|---:|---:|
| Chess.com, new install | 0.228 (0.228 to 0.259) | 0.282 (0.261 to 0.292) | 1.292 (1.265 to 1.320) | None shown | 7.354 (6.335 to 8.282) |
| Chess.com, saved profile, new game | 0.304 (0.272 to 0.424) | 0.315 (0.297 to 0.432) | 1.321 (1.310 to 1.434) | 1.321 (1.310 to 2.440) | 1.321 (1.310 to 2.440) |
| Chess.com, reopen recap | 0.349 (0.341 to 0.359) | 0.358 (0.350 to 0.368) | 0.358 (0.350 to 0.368) | 0.358 (0.350 to 0.368) | 0.358 (0.350 to 0.368) |
| Lichess, new install | 0.023 (0.023 to 0.161) | 0.090 (0.086 to 0.244) | 1.095 (1.091 to 1.247) | 5.114 (5.106 to 5.269) | 11.149 (11.122 to 11.287) |
| Lichess, saved profile, new game | 0.072 (0.069 to 0.085) | 0.100 (0.085 to 0.107) | 1.110 (1.087 to 1.121) | 5.173 (5.101 to 5.201) | 5.173 (5.101 to 5.201) |
| Lichess, reopen recap | 0.002 (0.002 to 0.003) | 0.014 (0.012 to 0.014) | 0.014 (0.012 to 0.014) | 0.014 (0.012 to 0.014) | 0.014 (0.012 to 0.014) |

I used two finished Chess.com bullet games and three finished Lichess blitz games. The saved
profile held 150 games, and reopening reused the finished recap. [Timing methods](docs/methods.md#where-the-time-goes)

In the demo, 150 Lichess blitz games with nothing cached showed the score and opening table after
7.11 and 7.26 s in two runs, and the full analysis after 15.97 and 16.27 s. The first number is
mostly the download, since Lichess sends anonymous history at about 20 games a second.
[Lichess methods](docs/methods.md#lichess)

## How it works

The analysis runs twice from the same design: in Python (`chesscheck/`) as the reference, and in TypeScript in the browser for the demo and the extension, with tests checking that both give the same answers. [docs/methods.md](docs/methods.md) has the full write-up: the statistical model, every eval and how it was scored, the extension's design, the odds studies with their leak checks, and the engine dataset.

## What I learned

- **Small samples lie.** My Scotch Game as Black looked terrible at 21% over 12 games. The model only marked it "worth watching" because with 34 openings, one bad result is expected by luck. Sixteen games later it was 38%, which is normal.
- **Check where the numbers come from.** My first odds test said a fitted model beat the Elo formula by a wide margin. Chess.com stores each player's rating after the game, so the winner's rating already included the points they won. Using the rating from their previous game removed the gap.
- **A result that looks too good probably is.** A later run said gradient boosting beat ratings clearly, but no single feature helped on its own. Two features measured time from when the game ended, so they included how long the game lasted, which gives away how it ended. Measured from the previous game instead, the gain disappeared.
- **"No effect" depends on the sample size.** Fifteen thousand games said history does not beat ratings. Six million said it does, by about a point per game. Both were true for what each could see.
- **The biggest model is not always the best one.** Haiku beat Opus on accuracy at a thirtieth of the price, and measuring it took an hour.
- **Check the checker.** My claim checker had three bugs of its own, and one made the coach delete correct information to satisfy it.
- **Two versions keep each other honest.** Testing that the Python and TypeScript versions agree caught a rounding difference and a solver that stopped too early.

## Tech used

| Area | Tools |
|---|---|
| Languages | Python, TypeScript |
| Machine learning | scikit-learn, PyTorch, a hierarchical Bayesian model, calibration, sentence embeddings |
| AI | Claude API, tool use, MCP, retrieval (embeddings plus BM25), evals |
| Data | DuckDB (also in the browser), Parquet, MySQL, pandas |
| Chess | Stockfish (native and WebAssembly), python-chess, chess.js |
| App | Chrome extension (Manifest V3), FastAPI, Docker, GitHub Pages, GitHub Actions CI |

## Run it locally

You need Python 3.11+, Node 22.15+, and Stockfish (`brew install stockfish`).

```bash
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
(cd web && npm install && npm run build)
.venv/bin/uvicorn server:app --port 8765
```

Then open http://localhost:8765. To enable the AI coach on that loopback-only server, set `CHESS_CHECK_LOCAL_COACH=1` and either log in to [Claude Code](https://claude.com/claude-code) or put `ANTHROPIC_API_KEY=...` in `.env` (see `.env.example`).

For Docker or a hosted instance, set a strong `CHESS_CHECK_COACH_TOKEN` in the server environment and enter that token in the web app. Use HTTPS when accessing the server remotely. The server admits one coaching request at a time by default. To run with MySQL, set the database passwords in `.env` and run `docker compose up --build`.

Tests: `.venv/bin/python -m pytest -q` and `cd web && npm test`. GitHub Actions runs both, plus the site and extension builds, on every pull request.

## License note

The browser demo and the extension serve [Stockfish.js](https://github.com/nmrugg/stockfish.js) (GPL-3.0) as a separate file, with one line changed at build time so its pauses during a search do not wait for the browser's 4 ms timer minimum (`web/scripts/patchStockfish.mjs`, which documents the change). The WebAssembly file is unmodified.
