# Methods and design notes

The detailed write-up behind the [README](../README.md). It covers the pipeline, each model, how the evals were scored, the SQL backends, the three ways the coach runs, and the decisions I made along the way.

## Pipeline

```
Chess.com API -> parse games (python-chess) -> DuckDB tables: games, moves
                                                   |
        Stockfish on every position (parallel, cached) -> per-move features:
        clock, time spent, legal moves, material, eval, phase
                                                   |
  openings:  Elo expected score -> hierarchical Bayesian shrinkage -> verdicts
  blunders:  moves table -> blunder-risk model -> actual vs expected blunders
                                                   |
                         numbered facts [F1..Fn]
                                                   |
  Claude agent with tools: run_sql, search_games, example_games, engine_eval
  (each tool result becomes a citable fact [T#])
                                                   |
  checker: citations, moves, numbers, links -> one repair turn if needed
```

The same pipeline exists twice: in Python (`wf/`), which is the reference, and in TypeScript (`web/src/browser/`), which runs it in the browser for the live demo. Tests in `web/test/` check that both give the same answers.

## Openings

Each game's result is compared with its Elo-expected score, so the residual (actual minus expected) removes the effect of opponent strength. Per-opening averages of the residual go into a normal-normal hierarchical model:

- Each opening's true effect is drawn from a normal distribution around the player's average.
- The spread between openings (tau) gets a half-normal prior with scale 10 points, and the posterior averages over a grid of 80 tau values.
- Every opening gets a shrunk estimate, a 90% interval and the probability that it is below zero.

**Why I integrate over tau.** My first version plugged in one estimate of tau (empirical Bayes). On my 300 games and 34 openings, both method of moments and maximum likelihood put tau near zero, which shrank a 12-game, -25 point result to -2 with a falsely narrow interval. Values of tau from 0 to 10 points fit the data almost equally well (within one log-likelihood unit), so picking one of them overstated the certainty.

**Verdicts.** "Weakness" needs the 90% interval below zero and at least 90% probability of being below zero. "Worth watching" is for openings with 8 or more games and an unadjusted z-score of -1.645 or lower that still do not pass the hierarchical test. With about 30 openings checked, one result that extreme is expected by chance.

**Worst branch.** For a flagged opening, the code looks at every move prefix from 4 to 12 plies and reports the longest, worst-scoring one with at least 3 games.

**Opening families.** Chess.com names like "Four Knights Game Scotch Variation" are mapped to families. The family named first in the name wins, with ties going to the longer name. An earlier version checked a fixed list in order and filed that game under the Scotch.

## Engine analysis

Stockfish evaluates every position at depth 8 to 10. Mistakes are measured as lost win probability using the Lichess mapping from centipawns, so a drop from +9 to +6 hardly counts while +1 to -2 does. A blunder is a move that loses 20 or more percentage points. Phases: the first 12 moves are the opening; after that, the endgame starts when non-pawn material is 26 points or less.

"Eval after move 12" uses the median across games, so a single -7 blowout does not define an opening.

In the browser, the lite build of Stockfish 19 runs as WebAssembly in one worker per CPU core (up to 8). Its smaller network finds somewhat fewer blunders than full Stockfish (5.1% vs 6.5% of middlegame moves on the same 150 games), so numbers should be compared within one version.

## Tactics and pieces

**Deep re-check.** The fast pass (depth 8 to 10) flags blunders. Every flagged position is then searched again at depth 16 (depth 14 in the browser, where the engine is slower): once before the move, for the best move, and once after it, for the opponent's best reply. A blunder only counts if the deeper search still shows a loss of 20 percentage points or more. On my 300 games, 974 of 1,118 flagged moves were confirmed (87%), and the re-check took 54 seconds for both players. This is about 4% of all positions, so it adds little compute.

**Tactic detection** (`wf/tactics.py`, ported to `web/src/browser/tactics.ts`). For each confirmed blunder, two moves are classified from the board geometry:

- **Allowed:** the opponent's best reply after your blunder.
- **Missed:** the engine's best move before your blunder.

| Tactic | Rule |
|---|---|
| Fork | The moved piece (not the king) attacks two or more non-pawn targets that are the king, worth more than it, or undefended, and it cannot simply be taken |
| Skewer | A slider attacks a king or queen with a less valuable piece behind it that is worth winning |
| Discovered attack | Moving a piece opens a line from another of your pieces onto a worthwhile target |
| Free piece | Capturing an undefended knight, bishop, rook or queen |
| Forced mate | From the engine score: the position after the move is a forced mate |
| Promotion | The move promotes a pawn |

**Validation** (`scripts/eval_tactics.py`). Each Lichess puzzle has a position, the solution and theme tags from Lichess's own tagger. The app tags a single move, so the main score runs the detector on the first solution move only. Lichess tags are not exhaustive, so precision is a lower bound.

| Tactic | Puzzles with the theme | Precision | Recall |
|---|---:|---:|---:|
| Fork | 2525 | 0.83 | 0.70 |
| Skewer | 417 | 0.68 | 0.51 |
| Discovered attack | 999 | 0.63 | 0.55 |
| Free piece | 768 | 0.58 | 1.00 |
| Pin (left out) | 1177 | 0.49 | 0.15 |
| Back-rank mate (left out) | 682 | 0.27 | 0.19 |

The first version had high recall but poor precision (fork 0.42, free piece 0.08), mostly because it was missing standard conditions: a forking piece that can simply be captured is not a fork, and capturing a defended piece is a trade. Pins in Lichess puzzles are mostly existing pins being exploited, which a check of one move cannot see, so the app leaves pins out.

**Pieces.** Blunders are also counted by the piece moved (the share of your moves with each piece that were blunders), the piece lost to the reply, and the piece that delivered a fork.

**Verdicts.** Each count is compared with your opponents' count in the same games, adjusted for the number of moves, using a Wilson interval on your share of the events. With 12 tactic comparisons and 6 piece comparisons, one borderline result is expected by chance, so a result is a "pattern" only if it passes after a Bonferroni correction for all of them (z = 2.77 for 18 comparisons) and "worth watching" if it only passes the plain 90% interval. On my games, missed discovered attacks (17 against 4) are a pattern; missed free pieces (28 against 16) are worth watching.

## Blunder-risk model

The model predicts whether a move will be a blunder from 19 features: move number, legal moves, check, captures available, material balance and total, engine eval, clock fraction and seconds left, time spent, game phase, and indicator features for clock bands (under 10%, 10 to 30%) and lopsided positions (eval over 3 and over 7 pawns).

**It learns only from opponents.** Training on the player's own moves would pull their actual-to-expected ratio toward 1 by construction. The model trains on opponents' moves in 4 of 5 game-grouped folds and predicts the player's moves in the fifth.

**Benchmark** (14,217 moves from 150 games, held-out split grouped by game, blunder rate 1.3%):

| Model | AUC | Log loss | Brier |
|---|---:|---:|---:|
| Base rate | 0.500 | 0.073 | 0.014 |
| Logistic regression with band features | 0.824 | 0.064 | 0.014 |
| Gradient boosting | 0.835 | 0.064 | 0.013 |
| MLP (PyTorch) | 0.848 | 0.062 | 0.014 |

The top features by permutation importance are clock fraction, then the engine eval before the move.

**Calibration over ranking.** The site reports actual divided by expected blunders within clock bands, so predicted totals need to be right inside each band. A plain logistic model ranked well (AUC 0.840) but disagreed with gradient boosting by up to 0.75 in the low-clock ratio, because blunder risk jumps as the clock runs out. Indicator features for the bands fix this: a logistic model with an indicator feature matches observed and predicted totals within that band on its training data. On held-out opponent moves pooled over 5 players (actual divided by predicted):

| Model | Under 10% clock | 10 to 30% | Over 30% |
|---|---:|---:|---:|
| Logistic regression with band features | 0.96 | 0.99 | 0.99 |
| Gradient boosting | 1.12 | 0.95 | 0.99 |

Every ratio carries a 90% Poisson interval (Byar's approximation), and the page only highlights a band when its interval excludes 1. Opponents make only about 15 to 30 low-clock blunders per player, so those intervals are wide.

**Solver.** scikit-learn's default lbfgs solver stopped up to 0.7% short in probability, and even at tol=1e-8 it left gaps of 1e-6. Python now uses scikit-learn's Newton solver (`newton-cholesky`), the same algorithm as the browser version, and the two agree to 1e-8.

## AI coach

The coach never sees raw game files. It gets a numbered list of computed facts and four tools:

| Tool | What it does |
|---|---|
| `run_sql` | Read-only SQL over the `games` and `moves` tables (DuckDB, or MySQL when enabled) |
| `search_games` | Search game summaries by meaning (embeddings plus BM25) |
| `example_games` | The player's worst games in one opening |
| `engine_eval` | Stockfish evaluation of a position |

Every tool result becomes a citable fact. The prompt requires every number, move and link to come from a cited fact.

**Checker.** `wf/verify.py` (and its TypeScript port) extracts every number, chess move and URL from the report. A move or link must appear in some fact. A number must appear in the fact its sentence cites, so a correct number cited to the wrong fact still fails. If anything fails, the checker's findings go back to the coach for one rewrite. Reading real reports turned up three bugs in the checker itself: it ignored tool-result citations, it accepted "15 minutes a day" because an unrelated interval ended at +15, and it rejected real game links followed by a colon. All three now have regression tests.

**Three ways to run it.**

1. **Claude API** (`wf/coach.py`): with `ANTHROPIC_API_KEY` set. Claude Haiku 5.5 by default (see "Choosing the model"), medium effort; server-side refusal fallbacks when the model supports them.
2. **Claude Code** (`wf/coach_cli.py`): without a key, the local `claude -p` CLI runs the same prompt on a Claude subscription. The tools are served by a small MCP server (`wf/mcp_server.py`), built-in tools are disabled, and the repair turn resumes the same session.
3. **Browser** (`web/src/browser/coach.ts`): the visitor pastes their own key and the page calls the API directly. The site has no server, and the key stays in the tab's memory. The SQL tool runs on DuckDB-WASM with writes refused and external access disabled. The SDK, DuckDB and the embedding model only load when the coach runs.

### Choosing the model

`scripts/eval_models.py` runs the same coach (facts, tools, checker, one repair turn) with each model on the same 5 players and 120 blitz games each, through Claude Code. Besides accuracy it measures:

- **Key findings cited:** the share of key facts the report cites, meaning every tactic or opening fact with a verdict plus the overall blunder-model fact. A model can be perfectly accurate by saying nothing; this catches it.
- **Leads with the strongest finding:** whether the first fact cited under "Biggest weaknesses" has the strongest verdict available ("pattern" or "weakness" ahead of "possible weakness" or "worth watching"). Rates below the opponents' are strengths and are skipped.
- **Cost:** computed from token counts at list prices, ignoring cache discounts, so it is an upper bound. Claude Code's own cost figure matched this for Opus but charged Haiku 5.5 as if it were a much more expensive model ($0.19 against a real $0.005), because that CLI version did not know the model's price yet.

First run (all three models, original prompt):

| Model | Unsupported, first draft | Clean after repair | Key findings cited | Cost per report | Time |
|---|---:|---:|---:|---:|---:|
| Opus 5.5 | 24 / 243 (9.9%) | 5 / 5 | 80% | $0.15 | 29 s |
| Sonnet 5.5 | 27 / 232 (11.6%) | 1 / 5 | 88% | $0.06 | 20 s |
| Haiku 5.5 | 7 / 210 (3.3%) | 5 / 5 | 76% | $0.005 | 23 s |

Sonnet's four unclean reports all had correct numbers but put the citation on the next sentence, and it repeated this after the repair turn told it what to fix. Reading the reports also showed that Haiku led my own report with three small-sample openings ahead of the one finding that held after correction, which the coverage metric did not catch. I added a prompt rule to order weaknesses by strength of evidence and the "leads with the strongest finding" metric, then reran Haiku and Opus:

| Model | Unsupported, first draft | Clean after repair | Key findings cited | Leads with strongest | Cost per report | Time |
|---|---:|---:|---:|---:|---:|---:|
| Opus 5.5 | 30 / 256 (11.7%) | 5 / 5 | 84% | 4 / 4 | $0.15 | 29 s |
| Haiku 5.5 | 8 / 231 (3.5%) | 4 / 5 | 84% | 4 / 4 | $0.0045 | 24 s |

The one unclean Haiku report repeated a clock band label ("the 10-30% band") in an advice sentence without a citation, which the strict checker counts. The coach now uses Haiku 5.5 by default (`WF_COACH_MODEL` overrides it). Haiku 5.5 has no server-side refusal fallback, so that parameter is only sent for models that support it. With 5 players, differences of a few points in coverage are within noise; the accuracy and cost gaps are not.

### Hallucination eval

`scripts/eval_coach.py`: 5 players (me plus four similar-rated recent opponents), 120 blitz games each, Claude Opus 5.5.

| Setup | Unsupported (lenient) | Clean reports | Unsupported (strict) | Clean reports |
|---|---:|---:|---:|---:|
| Raw game files | 46 / 323 (14.2%) | 0 / 5 | n/a | n/a |
| Facts and tools, first draft | 4 / 214 (1.9%) | 2 / 5 | 19 / 214 (8.9%) | 0 / 5 |
| Facts and tools after one repair | 0 / 202 (0%) | 5 / 5 | 0 / 202 (0%) | 5 / 5 |

Lenient: a claim counts as supported if it appears anywhere in the analysis or in the games the model was shown, which is fair to the raw setup since it was never asked to cite. Strict: it must appear in the fact its sentence cites.

I checked one raw report by hand. All 7 move sequences it cited were real and its record as Black (6-9-1) was right, but its record as White ("10-4") was wrong; the truth was 9-5. Most of its other flagged numbers were training advice. So the raw setup is not 14% wrong. Its claims cannot be checked automatically, and the wrong ones slip through.

### Game search eval

`search_games` turns each game into a plain-English summary (result and how it ended, opening, rating gap, eval after the opening, worst mistake with phase and clock, blunder count). Retrieval uses all-MiniLM-L6-v2 sentence embeddings, BM25 keyword scores, and reciprocal-rank fusion of the two.

`scripts/eval_search.py` scores 13 queries over 5 players and 150 games each. The right answers come from the structured data, never from the summary text, and the queries avoid the summaries' wording ("got flagged" instead of "lost on time").

| Method | Precision@5 | Recall@10 |
|---|---:|---:|
| Random | 0.17 | n/a |
| BM25 | 0.41 | 0.19 |
| Embeddings | 0.35 | 0.16 |
| Hybrid | 0.45 | 0.23 |

Embeddings did well on rewording ("got flagged": 0.48 vs 0.00 for BM25) and badly on who-did-what and negation ("my king got mated": 0.04; "games without big errors": 0.00). The hybrid is the default, and the tool description points exact filters to SQL. In the browser, transformers.js runs an 8-bit copy of the same model; its embeddings match Python's with cosine similarity 0.99, and 19 of 20 top-5 results agree.

## SQL backends

DuckDB is embedded and columnar. It runs the statistics in-process and is the only SQL engine here that also runs in the browser, so the live demo uses it.

MySQL is the persistent store for the full app when `WF_SQL_BACKEND=mysql` is set:

- Each analysis is written to its own schema (`wf_<hash>`) with `games` and `moves` tables.
- The coach connects as `wf_reader`, which MySQL itself limits to `SELECT` on `wf_%` schemas (`deploy/mysql/init.sh`). The session also uses read-only transactions and a 5-second statement timeout.
- `tests/test_mysql.py` checks that DuckDB and MySQL give the same answers on typical coach queries, that `INSERT`, `DROP`, `CREATE DATABASE` and `SELECT ... INTO OUTFILE` fail even when the tool's own check is bypassed, and that a runaway query is stopped.
- The `run_sql` description names the dialect. On MySQL, the coach wrote MySQL-specific SQL such as `SUM(wp_loss >= 20)` and `FIELD()` correctly.
- Limit: schemas are isolated by unguessable names rather than permissions. A multi-tenant production setup would give each tenant its own database user.

## Post-game recaps (follow mode)

`web/src/browser/follow.ts` and `recap.ts`. After a player's history is analyzed, the page checks the Chess.com public API every 45 seconds for new finished games. The monthly archive has a 5-second cache, and a game I had just played showed up within a minute. Each new game is analyzed on its own (depth 8, blunders re-checked deeper, tactics classified) and read against the player's history:

| Part | Source |
|---|---|
| Result and how it ended | The game record |
| Upset meter | Pre-game Elo expected score from both ratings, shown only afterwards |
| Turning point | The player's largest confirmed loss, on a board, with its tactic tags and clock |
| Pattern match | If the turning point's tactic is one the player shows more often than their opponents, with the running count |
| Opening | The player's earlier record in that opening family and color (this game excluded) |
| Opponent note | The opponent's record in the opening as their color, from their last 100 games |

**Fair play.** Chess.com forbids outside assistance during a game, and in live chess the clock starts at pairing, so there is no safe "before the game" moment. Recaps use only finished games, which is all the public API returns, and the opponent note and win probability appear only after the game.

**Chrome extension** (`extension/`, built from `web/src/extension/` by `scripts/build_extension.sh`). A Manifest V3 extension whose side panel runs the same browser code as the website: game fetching, Stockfish (bundled, not loaded from a CDN, since the Chrome Web Store forbids remote code), tactics and the recap card. It asks only for the side panel and storage, and for access to `www.chess.com` (to read the active tab's address) and `api.chess.com`.

The fair-play guard (`web/src/extension/guard.ts`, tested in `web/test/guard.test.ts`): the active tab's address is turned into a canonical game URL, and a recap is shown only if that URL appears in the player's games from the public API, which lists finished games only. A game still being played never appears there, so it never gets a recap; the panel shows only "Your recap will appear when this game ends" and checks again every 20 seconds. Pages that are not games, including the page where games are played, show no data. Tested in a development harness with three cases: a game finished 6 minutes earlier (recap), an unfinished game (waiting message, no data anywhere in the panel), and the play page (hint only).

Browser notifications are optional (the "Notify me" button asks for permission), and the tab title shows a count of unread recaps.

## Cross-language parity

The TypeScript port is tested against Python output on real games (`web/test/`, run in CI before every deploy):

- Opening statistics match to 1e-9, with identical verdicts and worst branches.
- scikit-learn's GroupKFold assignment is reproduced exactly, and logistic-regression probabilities match to 1e-8.
- The coach's facts and the game summaries match character for character. This caught a rounding difference: Python rounds halves to even (36.5 becomes 36) while JavaScript rounds them up.
- BM25 matches rank_bm25 to 1e-9, and given the same embedding vectors the hybrid ranking is identical.
- The tactic detector gives the same labels as the Python one on 3,000 Lichess puzzle positions, and the tactic summary, verdicts and coach facts match on real games. This caught a second rounding problem: multiplying 2.675 by 100 gives exactly 267.5 in floating point, so a check for exact halves has to read the number's real decimal digits.

## Deployment

- **Live demo:** GitHub Pages. `scripts/make_snapshot.py` saves an analysis and coach report for the opening page, and `.github/workflows/pages.yml` runs the TypeScript tests, builds `web/` and deploys it. Asset URLs carry the commit hash so new deploys show up right away.
- **Full app:** the Dockerfile builds the frontend and a Python image with Stockfish and CPU-only PyTorch (needed by sentence-transformers). `docker compose up --build` runs it with MySQL. Hosting defaults cap a request at 150 games, depth 8 and 2 engine workers.
- **Why not a free server host:** the free tiers I tried were either too slow for Stockfish (Render, 0.1 CPU) or now require a paid plan (Hugging Face Docker Spaces). Running everything in the browser avoids hosting entirely. `scripts/deploy_hf.sh` still deploys the image to a Space for anyone with a paid plan.

## Ideas for later

- Compare each opening against all Lichess players at the same rating, using the open Lichess database.
- Tag blunders by tactical motif (forks, pins, back-rank) and link matching Lichess puzzles.
- Load the tables into BigQuery; the SQL is standard and only the connection changes.

## Experimental Rust tactic classifier

The default builds use the TypeScript classifier. To try the Rust classifier,
install Cargo and the `wasm32-unknown-unknown` Rust target, then run from the
repository root:

```sh
CHESS_CHECK_RUST_TACTICS=1 npm --prefix web run build
bash scripts/build_static.sh
CHESS_CHECK_RUST_TACTICS=1 bash scripts/build_extension.sh
```

Both browser entry points fall back to TypeScript if the Wasm file fails to
load or execute. Move legality, PGN replay, and checkmate detection use
chess.js in both paths.

```sh
node web/test/rust-tactics.mjs
(cd web && node --import tsx test/rust-reports.mts --benchmark)
```

The benchmark repeats the 25 saved games six times and measures the complete
tactic summary with a warm Wasm instance, including move replay and data
conversion. The initial Node run on Apple Silicon measured median times of
692 ms for TypeScript and 689 ms for Wasm. It excludes Stockfish and Wasm
initialization.

The opening model can also use Rust. Set `CHESS_CHECK_RUST_OPENINGS=1`
when building the site or extension. Rust computes the posterior estimates
and intervals. TypeScript handles game grouping, verdicts, and branch labels.
With the Wasm target installed and Cargo on PATH, run:

```sh
cargo build --locked --manifest-path web/rust/openings/Cargo.toml --release --target wasm32-unknown-unknown
(cd web && node --import tsx test/rust-openings.mts)
```

The initial warm Node run over 150 saved games measured 11.2 ms for the full
TypeScript opening table and 10.8 ms with Wasm, including conversion. The
opening model stays opt-in given the similar timings.

Set `CHESS_CHECK_RUST_RISK=1` to use the Rust logistic regression fitter.
TypeScript still prepares the features and folds and summarizes the
predictions. Build and check the model with:

```sh
cargo build --locked --manifest-path web/rust/risk/Cargo.toml --release --target wasm32-unknown-unknown
(cd web && node --import tsx test/rust-risk.mts)
```

The full risk stage took a median of 90.4 ms with TypeScript and 38.0 ms
with warm Wasm in Node. This includes conversion and uses the 25 saved
games repeated six times with distinct game IDs. Keep all three modules
opt-in for now. The risk fitter is the strongest candidate for default
enablement if cold browser timings confirm that its savings outweigh
the extra download and initialization.
