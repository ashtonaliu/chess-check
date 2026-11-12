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

1. **Claude API** (`wf/coach.py`): with `ANTHROPIC_API_KEY` set. Claude Opus 5.5, medium effort, server-side refusal fallbacks.
2. **Claude Code** (`wf/coach_cli.py`): without a key, the local `claude -p` CLI runs the same prompt on a Claude subscription. The tools are served by a small MCP server (`wf/mcp_server.py`), built-in tools are disabled, and the repair turn resumes the same session.
3. **Browser** (`web/src/browser/coach.ts`): the visitor pastes their own key and the page calls the API directly. The site has no server, and the key stays in the tab's memory. The SQL tool runs on DuckDB-WASM with writes refused and external access disabled. The SDK, DuckDB and the embedding model only load when the coach runs.

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

## Cross-language parity

The TypeScript port is tested against Python output on real games (`web/test/`, run in CI before every deploy):

- Opening statistics match to 1e-9, with identical verdicts and worst branches.
- scikit-learn's GroupKFold assignment is reproduced exactly, and logistic-regression probabilities match to 1e-8.
- The coach's facts and the game summaries match character for character. This caught a rounding difference: Python rounds halves to even (36.5 becomes 36) while JavaScript rounds them up.
- BM25 matches rank_bm25 to 1e-9, and given the same embedding vectors the hybrid ranking is identical.

## Deployment

- **Live demo:** GitHub Pages. `scripts/make_snapshot.py` saves an analysis and coach report for the opening page, and `.github/workflows/pages.yml` runs the TypeScript tests, builds `web/` and deploys it. Asset URLs carry the commit hash so new deploys show up right away.
- **Full app:** the Dockerfile builds the frontend and a Python image with Stockfish and CPU-only PyTorch (needed by sentence-transformers). `docker compose up --build` runs it with MySQL. Hosting defaults cap a request at 150 games, depth 8 and 2 engine workers.
- **Why not a free server host:** the free tiers I tried were either too slow for Stockfish (Render, 0.1 CPU) or now require a paid plan (Hugging Face Docker Spaces). Running everything in the browser avoids hosting entirely. `scripts/deploy_hf.sh` still deploys the image to a Space for anyone with a paid plan.

## Ideas for later

- Compare each opening against all Lichess players at the same rating, using the open Lichess database.
- Tag blunders by tactical motif (forks, pins, back-rank) and link matching Lichess puzzles.
- Load the tables into BigQuery; the SQL is standard and only the connection changes.
