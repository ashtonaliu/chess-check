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

The same pipeline exists twice: in Python (`chesscheck/`), which is the reference, and in TypeScript (`web/src/browser/`), which runs it in the browser for the live demo. Tests in `web/test/` check that both give the same answers.

## Openings

Each game's result is compared with its expected score (the Elo formula recalibrated per time class, with White's edge; see "The upset meter's formula"), so the residual (actual minus expected) removes the effect of opponent strength. Per-opening averages of the residual go into a normal-normal hierarchical model:

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

**Tactic detection** (`chesscheck/tactics.py`, ported to `web/src/browser/tactics.ts`). For each confirmed blunder, two moves are classified from the board geometry:

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

**Checker.** `chesscheck/verify.py` (and its TypeScript port) extracts every number, chess move and URL from the report. A move or link must appear in some fact. A number must appear in the fact its sentence cites, so a correct number cited to the wrong fact still fails. If anything fails, the checker's findings go back to the coach for one rewrite. Reading real reports turned up three bugs in the checker itself: it ignored tool-result citations, it accepted "15 minutes a day" because an unrelated interval ended at +15, and it rejected real game links followed by a colon. All three now have regression tests.

**Three ways to run it.**

1. **Claude API** (`chesscheck/coach.py`): with `ANTHROPIC_API_KEY` set. Claude Haiku 5.5 by default (see "Choosing the model"), medium effort; server-side refusal fallbacks when the model supports them.
2. **Claude Code** (`chesscheck/coach_cli.py`): without a key, the local `claude -p` CLI runs the same prompt on a Claude subscription. The tools are served by a small MCP server (`chesscheck/mcp_server.py`), built-in tools are disabled, and the repair turn resumes the same session.
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

The one unclean Haiku report repeated a clock band label ("the 10-30% band") in an advice sentence without a citation, which the strict checker counts. The coach now uses Haiku 5.5 by default (`CHESS_CHECK_COACH_MODEL` overrides it). Haiku 5.5 has no server-side refusal fallback, so that parameter is only sent for models that support it. With 5 players, differences of a few points in coverage are within noise; the accuracy and cost gaps are not.

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

MySQL is the persistent store for the full app when `CHESS_CHECK_SQL_BACKEND=mysql` is set:

- Each analysis is written to its own schema (`chesscheck_<hash>`) with `games` and `moves` tables.
- The coach connects as `chesscheck_reader`, which MySQL itself limits to `SELECT` on `chesscheck_%` schemas (`deploy/mysql/init.sh`). The session also uses read-only transactions and a 5-second statement timeout.
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

**Chrome extension** (`extension/`, built from `web/src/extension/` by `scripts/build_extension.sh`). A Manifest V3 extension with three parts. A content script (`content.ts`) draws a 44 pixel draggable cube inside a closed Shadow DOM on Chess.com pages, so Chess.com's styles and the extension's cannot affect each other. It needs no setup. It takes the game ID from the address and gets both usernames from `/callback/live/game/<id>` (or `/callback/daily/game/<id>`), the same endpoint the game page loads. It reads the signed-in username from the user settings Chess.com embeds in every page as JSON, with the sidebar link to your profile as a fallback, and reads nothing else from the page. Signed out, it shows both players as buttons and remembers the one you pick. The callback returns 404 for a game that is still being played (I checked one game that went from 404 to a finished resignation a minute later), and the cube treats that as "your recap will appear when this game ends". It remembers its position in `chrome.storage`. An offscreen document (`offscreen.ts`) does the heavy work with the same browser code as the website: game fetching, the profile build, Stockfish (bundled, not loaded from a CDN, since the Chrome Web Store forbids remote code), tactics and the recap. When the engine runs: the cube asks the offscreen page to build ("warm") the profile only from pages that are not a game or the play page, for the time class the player played most in their last 40 games. Opening the play page or a game in progress sends "stop", which aborts the build through an AbortController between games or blunder checks (in testing, a build at game 64 of 150 restarted from scratch afterwards). Version 0.2 started the build as soon as any game page opened, including a game in progress.

The recap does not wait for the public archive. On a game page the cube asks `/callback/live/game/<id>` every 5 seconds; it answers 404 until a live game is over. The finished game's moves come in Chess.com's two-characters-per-move encoding, which `web/src/browser/tcn.ts` decodes (tested against the archive's PGN on three real games, including an underpromotion and a capturing promotion). `callbackGame.ts` rebuilds the PGN with clock times from the endpoint's move timestamps, takes pre-game ratings as the endpoint's rating minus its rating change, and names the opening from the past game that shares the longest run of opening moves, because the endpoint's ECO code does not always match the archive's (A84 against A40 for one game). Profiles are saved in IndexedDB (`profileStore.ts`) and reused after a restart, then refreshed in the background once per session; with the engine cache the refresh only analyzes new games. A first-ever build uses the last 50 games, and a 150-game build follows in the background; the recap says so while it is based on 50. The extension has the `unlimitedStorage` permission and the website asks for persistent storage, so the browser does not evict the caches when disk space runs low.

Measured in Chromium on chess.com (150 bullet games, no cache): engine pass 14.7 s, blunder re-check 5.4 s, fetching 0.7 s, patterns 0.6 s. A recap was ready 12.7 s after opening a finished game on a new install (50-game build), 1.5 s once the profile was full, and 3.2 s after restarting the browser. Raising the worker cap from 8 to 17 on an 18-core Mac only took a cold build from 21.0 to 19.7 s (two runs each), so the cap stays at 8. Since 2026-11-18 neither page waits for all of that. The recap shows the result as soon as the game is over and adds the turning point and then the history as each is ready (in the development harness: result 0.06 s, full recap 3.3 s with a saved profile and 35 s on a new install). The website shows the overall score and opening table as soon as the games are downloaded (2.4 s for 150 of my blitz games with nothing cached, against 23.1 s for the full analysis), and Cancel stops the engines mid-search. Profile builds wait until the finished game is analyzed so they do not compete with it, and an engine that crashes or stops answering for 60 seconds fails its pending searches instead of leaving them waiting. Caching positions across games was not worth adding: only 6.1% of 12,830 positions in 150 games repeated. Since 2026-11-18 a recap rechecks only the player's own blunders at depth 14, since the turning point needs no others, and each flagged position is its own task shared across up to 4 workers, so one game's blunders are checked in parallel. The deep results are cached position by position, and the profile build later checks only the opponent's, without repeating work. Each write merges into the stored entry in the same IndexedDB transaction that reads it, so a recap's recheck and a profile build's that overlap keep each other's positions (the first version wrote the whole entry, so the later writer could drop the other's). On three of my games, with old and new runs interleaved in the same page, the recheck went from 0.25, 0.15 and 0.51 seconds to 0.11, 0.15 and 0.19 (the middle game had one blunder, mine, so nothing changed). The extension's Chess.com script no longer loads chess.js: the find rate is worked out on the offscreen page, and board drawing moved to `web/src/ui/board.ts`, which only the website uses. With minification the script went from 155 KB to 44 KB (37 KB to 14 KB compressed), and the website's first load from 65 KB to 52 KB compressed. I also checked whether a background profile build makes Chess.com stutter, since it uses every core but one, up to 8. On my Mac (18 cores: 6 performance, 12 efficiency), a probe on a visible Chess.com tab in Chrome counted frames over 10 seconds and timed a fixed piece of JavaScript work every frame. With nothing else running it drew 1,203 frames with none longer than 50 ms. With 8 and then 17 Stockfish workers searching in another app (about 7.5 and 15 cores busy) it drew 1,201 frames each time, again none over 50 ms. During a real 50-game bullet build in the extension (up to about 8 cores), the busy probe drew 718 and 734 frames against 718 without it, and its work took 10.7 and 10.6 ms at the median against 10.5 ms. So the worker count stays as it is. This only covers a Mac with many cores, and I did not find out why the page was unaffected; a laptop with 4 cores is untested. A test that ran the workers in an ordinary Chrome tab was discarded, because they barely ran there (no search finished in 4 seconds, and Chrome used about one core).

**Adaptive worker count** (`web/src/browser/pace.ts`, tested in `web/test/pace.test.ts`; the stutter counting is `StallWatch` in `panelModel.ts`). Builds for different time controls can run at once, so they share one budget (`SharedPace`): each gets the count divided by the builds running, at least one, and a stutter lowers the count for all of them. A review pointed out that the first version gave each build its own count, so two builds could use twice the limit, and only the newest heard about stutter. Since the measurement above only covers my Mac, background profile builds now adapt to the device. The cube watches the Chess.com page it is on for long frames (Chrome's long-animation-frame entries; only their timing is read), ignoring the first 5 seconds of a page load and any time the tab is hidden. Two frames of 100 ms or more within 5 seconds send one report to the offscreen page, which drops one worker for the rest of that build. Workers above the current count wait between tasks instead of being shut down. The lower count is remembered on the device, a build that finishes without a report raises it by one, and a build starts at the remembered count or, the first time, at the usual count (every core but one, up to 8), so nobody's build is slower than before unless their page stutters. Builds the player is waiting on keep their fixed count. In the development harness, with fresh caches each time, a 50-game build took 40.6 s at the usual 8 workers; with reports sent at 5, 10 and 15 seconds it went from 8 to 7, 6 and 5 workers, took 49.1 s and remembered 5; the next build without reports started at 5, took 41.4 s and remembered 6. On a visible Chess.com tab in Chrome, two 300 ms freezes were reported as long frames of 331 and 307 ms. I did not see a report travel from the cube on a real Chess.com page to a real build, because the offscreen page cannot be inspected from outside.

I first also tuned the count by how fast the build went: every 4 seconds, add a worker if the last one made the build at least 10% faster, else step back. Starting from 2 workers it stopped at 2 (86.7 s against 40.6 s at 8), counting finished games. Counting individual searches and lowering the bar to 3% it still stopped at 4 (66.5 s). The speed over a few seconds depends on which positions happen to be searched more than on one worker more or less, so I dropped that part. The calm build above also shows why the count matters less than expected: 5 workers built as fast as 8, and the offscreen process used only 2 to 3 cores with 5 workers, which suggests the offscreen page's own thread (chess.js work for every position, between searches) limits the build, not the number of Stockfish workers.

**The offscreen page's own work.** Following that up: timing the chess.js work the offscreen page does for each position in the depth-8 pass (in Node, on 6,312 positions from 30 games) gave about 1.0 ms per position, 82% of it one call, `moves({ verbose: true })`, used only to count legal moves and captures. In chess.js 1.x the verbose form builds the position before and after every legal move. The plain SAN list gives the same two counts (identical on all 6,312 positions, captures being the moves with an "x") in 0.06 ms instead of 0.80. With that change, in the development harness with fresh caches, the depth-8 pass of a 50-game build took 6.5 and 7.6 seconds against 15.2 and 16.9 before. The whole build did not shrink as clearly, because the deep recheck that follows took 25 to 34 seconds and varied that much between identical runs; during it the process used 2 to 5 cores out of 8 workers, and in one run nearly none for its last 8 seconds, which I have not explained. The website's analysis uses the same code, so it gains the same.

**Why the deep recheck left cores idle.** Timing every deep search in a build (an instrumented page, 50 games, 8 workers, in a visible Chrome tab) ruled out the offscreen page: the gaps between one search answering and the same engine's next search added up to 0.18 seconds, and 8 searches were in flight for most of the stage. But the searches were wildly uneven, half under 100 ms and the slowest 26 seconds, and the slow ones barely used the CPU. Stockfish's own output gave the reason. On one endgame it reached depth 12 in 0.12 seconds (88,000 nodes, about 720,000 a second), then took 7.5 seconds for depth 13 at about 38,000 nodes a second: the search was mostly waiting. The single-threaded WebAssembly build pauses during a search so the worker can read messages such as "stop" (Emscripten's `emscripten_sleep` through Asyncify), it pauses with `setTimeout`, and browsers make a nested `setTimeout` wait at least 4 ms. The build now changes that one line: a sleep of 0 ms yields through a `MessageChannel`, which has no minimum (`web/scripts/patchStockfish.mjs`, tested in `web/test/patchStockfish.test.ts`; the WebAssembly file is unchanged). Run alone in Chrome, three of the slowest positions took 36.5, 2.2 and 28.9 seconds before and 1.8, 0.35 and 1.5 after, with the same node counts, scores and best moves. For the whole recheck of a 50-game build, two runs before took 34.5 seconds each; three runs after took 21.8, 10.7 and 10.2 seconds, the first still with several searches of 7 to 12 seconds, which I suspect came from an old copy of the engine in Chrome's cache but did not confirm. A whole 50-game run took 17.0 and 16.4 seconds in the last two. The recap's own analysis and the website use the same engine file, so they gain too. Native Stockfish needs far fewer nodes on these positions (36,746 against 941,448 at depth 14 on the first), because the browser build uses a smaller network; that difference remains.

**Deep search order.** The shallow pass records Stockfish's combined node count for the positions before and after each move. The deep pass starts the flagged positions with the highest shallow counts first. Older cached rows use the median count of the measured tasks, or the original order when none have counts. On three 50-game blitz samples in headless Chrome with eight workers, two runs per order per sample, the median time from the first idle worker to completion fell from 202 ms to 82 ms. Median wall time for the whole deep pass was 1.56 s in game order and 1.54 s with the new order. Shallow counts estimate search cost, and individual runs still vary.

**Timings after these changes** (2026-11-18, Chrome on my Mac, a visible tab, all caches cleared). I built the code from before the adaptive worker count, the move-counting change and the engine patch, and timed it against the current code the same way. The website's full analysis of my last 150 blitz games:

| Stage | Before | Now |
|---|---:|---:|
| Fetching games | 3.6 s | 1.3 s |
| Depth-8 pass | 37.1 s | 16.9 s |
| Deep recheck | 78.7 s | 26.6 s |
| Patterns | 2.2 s | 2.0 s |
| Total | 122.3 s | 47.5 s and 48.5 s |

The score and opening table appeared after 3.3 seconds. The earlier figures in this document (23.1 seconds for the full analysis, and the README's "about 30 seconds") were measured on other sets of games and no longer match my current games under either version, so the table replaces them. For an extension recap of one of my bullet games in the development harness, a first install (which also builds a 50-game profile) took 7.5 and 4.8 seconds for the full recap, and 20.3 seconds the very first time the engine was loaded in that browser; with a saved profile it took 1.4 and 1.8 seconds. The old code took 7.7 and 60.6 seconds for a first install, and a third run passed 43 seconds before I stopped it: with the unpatched engine the time depended on how often its searches stalled.

The service worker (`background.ts`) creates the offscreen document when needed and relays messages between the two, because content scripts cannot start workers and service workers cannot run Stockfish. It asks only for storage and offscreen, and for access to `api.chess.com`.

The fair-play guard (`web/src/extension/guard.ts`, tested in `web/test/guard.test.ts`): the game ID is taken from the tab's address, and a recap is shown only if that ID appears in the player's games from the public API, which lists finished games only. Matching by ID covers every address form Chess.com uses (`/game/<id>`, `/live/game/<id>`, `/game/live/<id>`, the daily forms and the analysis review page). Chess.com loads a game at `/game/<id>` and then rewrites the address to `/live/game/<id>` a few seconds later, which I only found by testing in a real browser. The game is looked up by ID in the player's last three monthly archives. An earlier version only checked the 30 most recent games, so a game with 30 or more newer games after it counted as unfinished. Version 0.1 compared full URLs and missed `/game/<id>`, the form Chess.com now uses for live games, so it never showed a recap; the tests now include that form. A game still being played never appears in the API, so it never gets a recap; the cube shows only "Your recap will appear when this game ends" and checks again every 20 seconds. Pages that are not games, including the page where games are played, show no data. Tested in a development harness (`extension/dev.html`, which stands in for the Chrome APIs) and in Chromium with the unpacked extension on the live Chess.com site, with a game finished minutes earlier (recap), an unfinished game (waiting message only), the play page (hint only) and dragging.

**Panel logic** (`web/src/extension/panelModel.ts`, tested in `web/test/panelModel.test.ts`). Every decision about what the cube and its panel show is a plain function of the state, the address and the per-tab markers: the cube's color, dot, count and title, whether the panel shows the recap or the review, which review card is up and whether Chess.com's board already shows it, what happens once the game endpoint answers, and the markers that reopen a recap or a review card after "Find it on the board" loads the game. `content.ts` only draws the result and talks to Chess.com and the analysis page. The tests cover the paths first found by hand on Chess.com: a game in progress, the play page, the dot clearing once a recap is opened, "Next review tomorrow" appearing while positions were due, and "Show this game's recap" under another game's card. Once in the live test, the recap did not reopen after "Find it on the board"; three later tries from both address forms worked, and I have not found the cause.

**Review queue** (`web/src/browser/reviewQueue.ts`, tested in `web/test/reviewQueue.test.ts`). Each recap asks its turning point once, so the extension keeps those positions and asks them again until you find the better move. A recap whose turning point lost at least 20% with a different best move adds it, due the next day. An empty queue starts with the worst blunder from each of your 5 most recent games in the profile the extension already built, so nothing new is analyzed. Found it moves a position 3, 7 and then 21 days out, after which it is learned and leaves the queue; missed it starts it over the next day. The queue keeps at most 60 positions in `chrome.storage`, dropping learned ones first. To keep the panel quiet it has no tabs: on pages that are not games the panel opens on the review when something is due and the cube shows the count, and under a recap a single line links to it. "Find it on the board" opens the game at that position on Chess.com's board, and the panel reopens on the same card. A game opened from the queue does not get its own recap unless asked for, so reviewing does not run Stockfish on old games. The fair-play rule is in `canReview` (`guard.ts`): no count or review on the play page, or on a game page until Chess.com's endpoint has confirmed the game is over. Changes to the queue go through `web/src/extension/queueStore.ts`, which applies each one to the latest saved queue under a lock that every Chess.com tab shares (Web Locks are per origin), and tabs refresh their copy when the stored queue changes. Before, each tab saved its whole copy, so a tab with an older copy could undo a grade made in another; `web/test/queueStore.test.ts` shows both a grade and an addition from another tab surviving, and the same interleaving losing one without the lock.

Browser notifications are optional (the "Notify me" button asks for permission), and the tab title shows a count of unread recaps.

## Odds experiment

`scripts/eval_odds.py` asks whether account history predicts a game's result better than ratings alone. The first run used 1,780 games from 30 players. The current one uses 14,830 games: `collect` picks 250 players with enough blitz games (a fixed pseudo-random sample of players from the first run), takes each one's last 60 games as targets, and downloads the last two months of blitz games for every target opponent (12,178 players, cached in data/odds/v2/), including clock times and how each game ended.

Each target game gets features built only from games that ended before it: the Elo expected score from pre-game ratings; each player's recent form and results with this color; both players' results in each side's most-played opening; each player's results against the openings the other side usually plays with these colors; the share of losses that were on time, the share of wins where the opponent ran out of time, and the clock left at the end, plus their product across players (a frequent flagger against someone who often loses on time); the share of the last three games won; games in the hour before the previous game ended; and minutes between the previous two games. Models predict win, draw or loss and are scored by grouped 5-fold cross-validation over the 250 players, with 90% intervals from resampling players.

| Model | Log loss | Brier (expected score) | Brier change vs ratings only (90% interval) |
|---|---:|---:|---|
| Elo formula | n/a | 0.2398 | |
| Ratings only, logistic | 0.8407 | 0.2387 | |
| Ratings plus first-run history, logistic | 0.8410 | 0.2387 | +0.0000 (−0.0003 to +0.0003) |
| Ratings plus all history and matchups, logistic | 0.8420 | 0.2389 | −0.0002 (−0.0006 to +0.0002) |
| Ratings plus all history and matchups, gradient boosting | 0.8420 | 0.2391 | −0.0004 (−0.0007 to +0.0000) |

The widest interval is 0.0008, so the test could detect a history effect that shifts a typical game's expected score by about 2 percentage points (0.02² ≈ 0.0004). Targeted checks on the games where a matchup applies (mean of score minus Elo expected score) found nothing outside noise in openings. For clock habits, the top 10% of games where the time matchup favored the focal player came out +0.015 (−0.006 to +0.036), and the bottom 10% came out −0.019 (−0.041 to +0.003).

**Rating quality and tilt.** A third collection (data/odds/v3, the same 250 focal players and their latest 60 games, 12,233 opponents) also keeps every player's bullet and rapid ratings over the same two months, the date they joined and whether the account was later closed. New features, each for both players and only from games that ended before the target: rapid and bullet rating minus blitz rating going into the game, rating trend over the last 100 blitz games (points per game), best rating in the last 200 games minus the current one, number of blitz games in the window, account age and the length of the last break, and tilt (the player's shrunk residual in games started within 20 minutes of a loss minus the same after a win, and that number times whether they just lost).

| Model (v3 data, 14,828 games) | Brier | Change vs ratings only (90% interval) |
|---|---:|---|
| Ratings only, logistic | 0.2388 | |
| Ratings plus rating quality, logistic | 0.2387 | +0.0001 (−0.0003 to +0.0005) |
| Ratings plus rating quality, gradient boosting | 0.2392 | −0.0004 (−0.0007 to −0.0000) |
| Ratings plus tilt, logistic | 0.2388 | −0.0000 (−0.0002 to +0.0001) |
| Ratings plus everything, gradient boosting | 0.2392 | −0.0004 (−0.0008 to −0.0001) |

Only 21 games involved an account later closed for fair-play violations; the focal player scored 0.137 below the Elo expectation in them, which fits playing a cheater, but there are too few to matter. In subgroups where a feature should matter most, one of ten checks reached the 90% level: when the opponent's bullet rating was at least 150 above their blitz rating (268 games), the focal player scored 0.055 below expectation (−0.108 to −0.005). With ten checks, one is expected by chance, so it is a lead, not a finding. The rapid-rating version pointed the same way (−0.006 for the opponent's gap, +0.011 for the focal player's) without reaching it.

**Learned playstyles.** `scripts/eval_embeddings.py` gives each player k numbers and models a game as sigmoid(β × rating logit + b + x_iᵀ A x_j) with A antisymmetric, so a style edge for one player is exactly the other's disadvantage. It optionally adds a per-player offset (how much stronger than rated they play). It trains on every game in the cached histories that ended before a cutoff (the median target game, 6,506,300 games, 65,166 players with at least 30), chooses the size and L2 strength on the last week before the cutoff, and tests once on the 7,479 target games after it. Splitting by time matters: the histories contain the target games, so a random split would leak them.

| Model (chosen on validation) | Test Brier | Change vs ratings only (90% interval) |
|---|---:|---|
| Ratings only | 0.2389 | |
| Styles, size 2 | 0.2388 | +0.0001 (+0.0000 to +0.0002) |
| Per-player offsets | 0.2395 | −0.0006 (−0.0009 to −0.0003) |
| Offsets plus styles | 0.2388 | +0.0001 (−0.0003 to +0.0004) |

The model does learn: with weak regularization, size-8 styles fit the training games far better than ratings (Brier 0.2208 against 0.2371) and did worse on later games, and on validation every model got closer to ratings-only as regularization grew. On the earlier v2 data the result was the same (styles −0.0001, offsets −0.0003).

**A leak I caught.** The first run of this version measured "games in the last hour" and "minutes since the last game" from the target game's end time. That end time includes how long the target game lasted, and game length gives away how it ended. Gradient boosting combined those features with the clock habits and showed a gain of +0.0044 (0.0034 to 0.0053) over ratings, while no feature group helped on its own. Dropping the two features removed the gain (+0.0003, −0.0001 to +0.0006). They are now measured from the end of the player's previous game, and the table above is the corrected run.

**Post-game ratings.** The `rating` field in Chess.com's game archive is the rating after the game. Across 980,711 consecutive game pairs, a player's rating change agreed with the result of that same game 99.6% of the time and with the previous game's result 50.2% of the time. The first run used those ratings and reported a Brier score of 0.163 for the fitted ratings model against 0.218 for the Elo formula, because the fitted model had learned to read the result from the rating change. The script now uses each player's rating after their previous game in the same time class. For past games in a player's history, the opponent's pre-game rating is estimated as their post-game rating plus the player's own rating change. On these games, post-game ratings move the expected score by 2.2 percentage points on average, almost always toward the actual result. The report, the extension's profile and Follow mode recaps read the same archive and had the same problem until 2026-11-18. Both fetchers (`chesscheck/fetch.py` `pregame_ratings`, `web/src/browser/games.ts` `withPregameRatings`) now use the same rule, reading one extra game so the oldest game has a previous one. On the demo's 300 games this moved the overall expected score from 49.57% to 49.60% and changed one opening verdict.

### Stockfish history features

`scripts/eval_engine_features.py` samples 1,000 distinct targets with seed 0,
round-robin across focal players. For each player it uses their latest 50 blitz
games that finished before the target's PGN start time and the rating recorded
after their previous blitz game. It excludes targets whose start time or full
history is unavailable. Stockfish runs at depth 10 and reuses the evaluation
after each move as the next move's starting evaluation. The target's engine
output is used only for the accuracy label, the focal player's mean
win-percentage-point loss per move minus the opponent's. Sharpness is the standard
deviation of per-move changes after clipping each evaluation to ±1,000 cp, so
mate scores do not dominate it.

The result model compares ratings alone with ratings plus engine features
using grouped five-fold cross-validation by focal player. It reports expected
score Brier, log loss, paired 90% focal-player bootstrap intervals, and the
same interval-width sensitivity estimate as the odds experiment. The
accuracy-gap comparison reports out-of-fold R² for ridge and histogram
gradient boosting.

**Results.** The seed-0 sample drew 1,000 targets from 250 focal players.
Five lacked 50 pre-start blitz games for at least one player. The 995 eligible
targets included 455 losses, 53 draws, and 487 wins for the focal player.

Adding Stockfish history worsened held-out predictions for both classifiers.
The changes below subtract the engine model's loss from the ratings-only
model's loss, so negative values favor ratings alone. Intervals resample
focal players 2,000 times.

- **Multinomial logistic regression.** Expected-score Brier rose from 0.236165
  to 0.243307, a change of −0.007143 (90% interval −0.011891 to −0.002324).
  Log loss rose from 0.865516 to 0.889617, a change of −0.024101
  (−0.039205 to −0.008939).
- **Histogram gradient boosting.** Brier rose from 0.242674 to 0.271777,
  a change of −0.029104 (−0.039280 to −0.018956). Log loss rose from
  0.891071 to 1.001532, a change of −0.110461 (−0.147737 to −0.076304).

The raw Elo formula scored 0.234814 Brier. The widest Brier interval had
a half-width of 0.010162, the experiment's approximate minimum detectable
Brier effect by its interval-width rule. Its square root corresponds to about
10.08 percentage points of expected score under the same heuristic.

How to read this: the sample is too small to settle the question. It can only
detect an engine effect of about 10 points of expected score per game, five
times coarser than the 14,830-game tests above (about 2 points). The losses are
about what fitting 23 extra features to roughly 800 games per fold costs
(p/n × variance ≈ 0.007 Brier), and even the fitted ratings-only model scored
worse than the plain Elo formula. So this rules out large engine effects, not
small ones. Reaching 2-point resolution would take about 25 times more games,
roughly 1.8 million game analyses, which is weeks of CPU on one machine.

**Nested regularization check** (`scripts/eval_engine_regularization.py`, run against
the study's cache with no new engine work). The study's logistic models used C = 1.
Here C is chosen inside each training fold by an inner grouped 4-fold split on
Brier, over 0.0001 to 10, and the models are evaluated on the same five
held-out folds. Ratings alone chose C = 0.01 to 0.03; ratings plus engine features
chose 0.0001 to 0.001.

| Logistic model | Ratings only | Ratings plus engine | Change (90% interval) |
|---|---:|---:|---|
| Brier, C = 1 (study) | 0.236165 | 0.243307 | −0.007143 (−0.011891 to −0.002324) |
| Brier, nested C | 0.236156 | 0.236538 | −0.000382 (−0.002217 to +0.001519) |
| Log loss, nested C | 0.865007 | 0.864590 | +0.000417 (−0.003984 to +0.004812) |

Tuned this way, the penalty disappears, which confirms it was overfitting. The
engine model got there by choosing very strong regularization, shrinking the
engine features almost to zero, so the narrower interval does not mean the test
became more sensitive. It means the engine features could not earn weight in 995
games. The 10-point resolution above still applies.

**Engine features alone.** The same script compares models without ratings, with the
same nested choice of C.

| Model (nested C, 995 games) | Brier | Gain over always predicting 50% (90% interval) |
|---|---:|---|
| Always 50% | 0.2367 | |
| Ratings only | 0.2362 | +0.0005 (−0.0011 to +0.0022) |
| Engine only, both players' features | 0.2371 | −0.0005 (−0.0022 to +0.0013) |
| Engine only, focal minus opponent | 0.2373 | −0.0006 (−0.0019 to +0.0006) |
| Ratings plus engine | 0.2365 | +0.0001 (−0.0015 to +0.0018) |

Nothing beats a coin flip here, ratings included, because matchmaking leaves almost
nothing to predict: the median rating gap is 14 points, 90% of games are within 42,
and the middle 90% of Elo expected scores run from 0.44 to 0.56. The engine features
do measure skill. Across the 1,962 player histories (ratings 780 to 2149), rating
correlates −0.25 with mean win-percentage points lost per move (about −57 rating
points per extra point lost), −0.17 with missed tactics per move, +0.12 with
conversion of winning positions, and −0.06 with blunders under 10% of the clock.
From 50 blitz games they are a noisy measure of what the rating already measures
from thousands of results, and matchmaking has used the rating to make the game even.

For the accuracy gap, 991 targets had moves for both players. Adding engine
features lowered out-of-fold R² from 0.000741 to −0.029585 for ridge and
from −0.024083 to −0.084170 for histogram gradient boosting.

Stockfish 19 analyzed 70,467 distinct games, including histories. Summed
per-game analysis time was 75,625.608 seconds across workers. The final
18-worker engine pass took 4,144.936 wall seconds and reused 1,522 cached
games. The model rerun reused all 70,467 engine results.

```sh
python scripts/eval_engine_features.py --source /path/to/data/odds/v3 --workers 18
```

### Tactical matchups

`scripts/eval_tactic_matchups.py` uses the same sampled targets, previous-game
ratings, and 50 strictly pre-start blitz games per player as the Stockfish
history study. It reads the downloaded PGNs offline and stores separate
depth-10 motif counts. The original cache pooled motifs across types.

The detector tags the engine's best move and the move actually played. A
missed motif is present in the best move, absent in the played move, and
accompanied by a drop of at least 20 win-percentage points. An allowed motif
appears on the best reply to a move with that drop. The model uses missed
events per tagged best-move opportunity, and opportunities, allowed events,
and played motifs per move. Played motifs count only on moves below the drop
threshold. Fixed pseudo-counts shrink sparse rates toward zero. Played motifs
estimate how often a player uses a motif, including opportunities gifted by an
opponent. Single-move tags also miss combinations that unfold over several
moves, and pin and back-rank tags were less precise in puzzle validation.

The baseline calibrates the pre-game Elo gap and color with multinomial
logistic regression. The first extension adds the difference between players'
motif rates. The second adds two matchup terms per motif, combining one
player's played rate with the other's missed or allowed rate and subtracting
the reverse matchup. The three models use the same five held-out focal-player
folds. Each selects regularization by Brier score inside a grouped four-fold
split of its training data. Paired 90% intervals resample focal players.

**Results.** The study analyzed 70,222 distinct depth-10 history games for
995 targets across 250 focal players. The full pass took about 83 wall minutes
with 14 workers (69,098.416 summed seconds across workers). The final model
rerun used the complete cache. Across distinct history games, the detector
counted 53,787 fork opportunities, 7,573 missed forks, 14,436 allowed forks,
and 43,236 forks played. Back-rank mates had 1,900 opportunities and 151 misses.

- Ratings and color yielded Brier 0.236645 and log loss 0.866444.
- Adding motif profiles yielded Brier 0.237306 and log loss 0.867459.
  Improvements over ratings and color were −0.000661 for Brier
  (90% interval −0.002233 to +0.000953) and −0.001015 for log loss
  (−0.004733 to +0.002581).
- Adding the matchup terms yielded Brier 0.237033 and log loss 0.866642.
  Improvements over ratings and color were −0.000387 for Brier
  (−0.002337 to +0.001525) and −0.000198 for log loss
  (−0.004499 to +0.004054).

The matchup terms alone improved on the motif-profile model by +0.000274
Brier (−0.000362 to +0.000929) and +0.000817 log loss (−0.000532 to +0.002226).
All six paired intervals span zero. The study leaves room for small effects
and estimates the combined predictive value of these motif features.

```sh
python scripts/eval_tactic_matchups.py --source /path/to/data/odds/v3 --workers 14
```

### Beating raw ratings on a large holdout

`scripts/eval_session_effects.py` uses every game in the v3 player histories (12,233 players),
each seen from the view of the player whose history it is in, with features from that player's
earlier games only. It fits on games before 2026-11-01 (4,437,393 player-games) and tests on games
from 2026-11-07 (1,537,434), with a six-day gap, bootstrapping the test gain over players. The
baseline is the Elo expected score recalibrated on the training period plus colour (+1 White,
−1 Black), fitted by multinomial logistic regression.

Two checks before it. In the 14,807 target games (excluding the 21 against later-banned accounts),
White scored 0.0153 above the Elo expectation (+0.0058 to +0.0247) and Black 0.0144 below, and
the Elo curve was overconfident: games Elo gave 0.338 on average ended 0.423, and games it gave
0.690 ended 0.549. Cross-validated over the 250 focal players, recalibration gained +0.00110
(+0.00061 to +0.00162) over Elo and colour +0.00015 more (−0.00006 to +0.00034). Rating swing
(a proxy for Glicko's uncertainty: median 7.7 points per game, 90th percentile 8.0), abandonment
rate and draw rate added nothing.

| Added to recalibrated ratings + colour (test) | Brier gain (90% interval) |
|---|---|
| Session stage for everyone (games 2–5, 6–15, 16+) | −0.000001 (−0.000003 to +0.000002) |
| The player's own session curve | −0.000005 (−0.000007 to −0.000003) |
| Games in the 24 hours before their previous game ended | −0.000000 (−0.000001 to −0.000000) |
| Games so far in the current run | +0.000000 (−0.000002 to +0.000003) |
| Break before the run, first run after 3+ days | +0.000001 (−0.000000 to +0.000001) |
| Own tilt (after-loss minus after-win residual) + lost last game | +0.000018 (+0.000012 to +0.000022) |
| Rating minus own 200-game average | +0.000049 (+0.000026 to +0.000072) |
| Hours from the player's usual hour | +0.000002 (−0.000000 to +0.000004) |
| Own colour split | +0.000001 (+0.000001 to +0.000002) |
| Lost an upset last game (Elo gave them 70%+), and mid-session | +0.000001 (−0.000001 to +0.000003) |
| Distance below the best rating in the last 200 games | +0.000083 (+0.000068 to +0.000099) |
| Losses in a row | +0.000015 (+0.000011 to +0.000020) |
| All of the above | +0.000152 (+0.000133 to +0.000167) |

The recalibrated ratings + colour model itself gains +0.00083 (+0.00077 to +0.00087) over the Elo
formula on the same test games, so the full model is about +0.00098 over Elo. Mean score minus
Elo expected in the test games, directly: 10% furthest below their 200-game average (62+ points)
+0.0238 (+0.0217 to +0.0258), middle 80% +0.0018, 10% furthest above (78+) −0.0068 (−0.0094 to
−0.0040); after a loss +0.0001, after a win or draw +0.0058; after an upset loss −0.0789
(−0.0944 to −0.0644, 3,845 games), and about the same whether that loss was a resignation
(−0.075), checkmate (−0.072), timeout (−0.093) or abandonment (−0.085), so it is not only
connection trouble; some of it may be players whose rating was too high at the time. By session
stage: games 2–5 +0.0023, 6–15 +0.0038, 16+ +0.0041.

Leak rules: every feature uses earlier games only. Whether this game starts a new session cannot
be read from its end time, which includes its length, so session features describe the player's
state at their previous game, and "game 1 of a session" is not a category. Opponents' pre-game
ratings in history games are estimated as their post-game rating plus the player's own change.

### The upset meter's formula

`scripts/fit_expected_score.py` downloads the last two months of bullet, blitz and rapid games for
1,500 of the cached players (data/odds/calib) and fits, per time class,
expected = sigmoid(a × logit(Elo expected) + b × colour), using each game from both sides with no
intercept, so the formula is symmetric. Ratings are pre-game, as in the odds experiment. Fitted on
games before 2026-11-01 and checked on games from 2026-11-07:

| Time class | Fit games | Test games | a | b | Elo Brier | Formula Brier | Gain (90% interval) |
|---|---:|---:|---:|---:|---:|---:|---|
| Bullet | 81,339 | 18,878 | 0.4092 | 0.0580 | 0.23832 | 0.23514 | +0.00318 (+0.00207 to +0.00456) |
| Blitz | 574,360 | 202,775 | 0.4637 | 0.0606 | 0.23814 | 0.23722 | +0.00092 (+0.00078 to +0.00106) |
| Rapid | 19,393 | 3,594 | 0.3770 | 0.0583 | 0.23434 | 0.22873 | +0.00561 (+0.00375 to +0.00810) |

I use the same formula for the recap's upset meter and opening history, the main report's overall
and opening scores (including opening branches), and opponent notes. I also use those game scores
in the coach's facts and SQL tools. For daily games and other time classes without fitted coefficients,
I use plain Elo. I estimated the opponent's pre-game rating in the training games, so noise in the
rating gap may shrink a. The exact pre-game ratings in the 14,807 target games showed the same
overconfidence.

**Gate test: does a tactic profile predict the player's own next game?** (`scripts/eval_tactic_gate.py`,
no new engine work). The big engine study (`docs/engine-study-plan.md`) was to run only if it did.
A focal player's target game is part of the history of their later targets, so 728 target games
(all 250 players) already have motif counts. For each, the player's pooled profile from their
previous 50 games is compared with their own mistakes in that game, out of sample by grouped
5-fold over players, beyond their rating:

| That game's ... | Correlation with the profile | Out-of-sample R², rating + profile |
|---|---:|---:|
| Missed tactics (share of opportunities) | −0.03 | −0.002 |
| Allowed tactics (per move) | +0.10 | +0.001 |
| Missed + allowed (per move) | +0.02 | −0.006 |

Only allowing tactics shows a faint trait. A single game has few tactical chances, so its count is
mostly noise, and a 50-game profile does not predict it. The gate failed, so the big engine run is
not being done for tactics.

**Accuracy gate** (`scripts/eval_accuracy_gate.py`, same design as the tactics gate, no new engine
work). On 726 target games from all 250 players, a player's 50-game accuracy profile barely
predicts their next game: correlation 0.10 with their mean win-percentage points lost per move,
out-of-sample R² from −0.008 (rating alone) to −0.006. For who outplayed whom (the accuracy gap
between the two players in that game), the two players' profile gap correlates 0.04 and adding it
makes the out-of-sample prediction worse (R² +0.002 to −0.008). Accuracy is a real trait across
players (−0.25 with rating), but a single game varies far more than the profiles do. So the big
engine run is not a prediction study any more: it is run only to store a reusable dataset.

## Engine dataset

`chesscheck.dataset.EngineDataset` exposes `player_games`, `player_features`, and
`pregame_rating`. `register_views` installs their DuckDB table macros
(`dataset_player_games`, `dataset_player_features`, and `dataset_pregame_rating`)
on an existing connection. Pass the target's PGN start as an exclusive cutoff
in UTC Unix seconds. Game history and the rating lookup only use completed games
whose end is earlier than that cutoff. Each historical game's own pre-game
rating uses the same rule at its start, within the same time class. Ratings can
be missing when the previous game is outside the dataset.

The reader scans `games/part-*.parquet` and `positions/part-*.parquet` in place.
It pairs shards by filename and uses the games shard as the completion marker.
It ignores temporary files and does not depend on the sampling manifest. Pass a
username to limit the position aggregation to that player's history. Pass
`None` in Python or `NULL` in SQL to summarize all players.

Win-percentage-point loss is the nonnegative difference between consecutive
evaluations from the mover's perspective, using the engine's centipawn curve
and opening, middlegame, and endgame rules. Forced mates use ±3,000 cp and
terminal draws use zero. A move is critical when the best and second-best
lines differ by at least 20 points. Easy moves have two scored lines and a
smaller gap. Positions without a second line are excluded from both groups.
The views report best-move rate and mean seconds spent in each group, plus
mean loss when the clock before the move is below 10% of the base time.

Conversion is the share of games won after reaching +300 cp. Resilience is
the share drawn or won after reaching −300 cp. Depth-10 blunders lose at
least 20 points. Counts distinguish blunders confirmed by the depth-14
re-check, blunders that fall below the threshold at depth 14, and those with
missing deep evaluations. The confirmation rate uses re-checked blunders as
its denominator. Player summaries pool the underlying moves or eligible games.
Each rate includes its denominator in a matching `_n` column and is null when
that denominator is zero.

### Engine profiles against the odds formula, full sample

`scripts/eval_engine_odds.py` asks the odds question again on all 14,739 targets in the dataset.
The earlier engine tests used 995. Each player's profile comes only from the 50 blitz games listed
for that target, all of which ended before it started. The baseline is the app's own formula. Each
model adds a group of features as focal-minus-opponent differences in a win/draw/loss logistic
regression, with C chosen inside each training fold, five folds grouped by focal player, and a
paired bootstrap over players.

| Model | Brier | Gain (90% interval) |
|---|---:|---:|
| App formula, fixed | 0.23853 | |
| Formula refit on this sample | 0.23849 | +0.00004 (−0.00010 to +0.00018) |
| + results against rating, rating climb (no engine) | 0.23844 | +0.00006 (−0.00006 to +0.00018) |
| + move quality (win-% lost, blunders, best-move rates) | 0.23852 | −0.00008 (−0.00016 to +0.00001) |
| + loss by phase | 0.23845 | −0.00001 (−0.00010 to +0.00008) |
| + low-clock loss, time on critical moves | 0.23848 | −0.00004 (−0.00014 to +0.00006) |
| + conversion, resilience, results after move 20 | 0.23843 | +0.00000 (−0.00012 to +0.00012) |
| + form (last 15 games against the 35 before) | 0.23848 | −0.00004 (−0.00010 to +0.00002) |
| + implied rating (rating predicted from move quality, minus actual) | 0.23843 | +0.00001 (−0.00005 to +0.00007) |
| + all engine features | 0.23855 | −0.00011 (−0.00028 to +0.00005) |

Engine gains are measured against the no-engine history row. None of them helps, and all of them
together make predictions slightly worse. The profiles are real (win-% lost correlates −0.28 with
rating, critical best-move rate +0.21, conversion +0.22), but the rating has already priced them
in. The widest interval is 0.00033 wide, so this sample rules out any engine effect that shifts a
typical game's expected score by more than about 2 points. With 15 times the data, the result
matches the 995-game test.

### Two-sided history against the odds formula

I tested whether both players' recent blitz results improve the recap's
expected score. I used the v3 histories for ratings and results, and joined
game IDs to PGN start times in the stored game metadata. I required matching
records for both players and counted each game once, from White's side. A
history game had to end strictly before the target started. Each player's
rating came from their own last completed blitz game. The calibration cache
has no game IDs or opponent names, so I used its published blitz coefficients
as the baseline and used v3 for the two-sided join.

I used the session study's split by end date in UTC. The fit used 6,252 games
that ended before November 1, 2026, across 4,919 players. The holdout used
99,121 games from November 7 onward, across 12,015 players. Games without a
verified start or enough history for both players were excluded. The metadata
covers the archive games collected for an earlier study, with much denser
coverage late in the snapshot. The results apply to this matched blitz sample.

I kept the shipped rating and color coefficients fixed and fitted a logistic
adjustment with no intercept, treating a draw as half a win. This scores the
same expected score the app displays. The adjustment uses the difference
between the two players' features, so swapping the players and color
complements the prediction. The features are points below the highest rating,
points above the mean rating, consecutive losses capped at six, whether the
last game was a loss, and a shrunk tilt estimate. Tilt is the difference in
score minus Elo expectation after a loss and after a win, using pairs of games
that ended less than 30 minutes apart.
Each bucket gets 20 zero-residual pseudo-games. For a history game I estimated
the opponent's pre-game rating from the player's rating change, as in the
one-sided study.

I compared all windows on the same games. Both players needed 30 earlier games,
and each window used up to its cap. Both sides had at least 50, 150, and 200
games in 97,680, 86,986, and 80,002 of the test games, respectively. I used 200
as the shipping candidate because the odds calculation can read ratings,
results, and timestamps directly from the monthly archives, independently
of the 150-game analysis profile. Live fetch time for 200 games remains
unmeasured.

I computed paired 90% intervals from 2,000 bootstrap resamples of player IDs.
Each game's weight is the product of the two players' resample counts, so
games involving the same player are resampled together whether they played
White or Black. Decile error is the size-weighted mean absolute gap between
predicted and observed scores in ten equally populated bins per model. Both
log loss and Brier score use the expected-score target.

| Model | Brier | Brier gain (90% interval) | Log loss | Decile error |
|---|---:|---:|---:|---:|
| Current formula | 0.2379700 |  | 0.6925341 | 0.0064461 |
| 50-game history | 0.2379503 | +0.0000197 (-0.0000622 to +0.0001067) | 0.6924948 | 0.0075009 |
| 150-game history | 0.2378877 | +0.0000823 (-0.0000121 to +0.0001753) | 0.6923692 | 0.0067229 |
| 200-game history | 0.2378294 | +0.0001406 (+0.0000352 to +0.0002465) | 0.6922544 | 0.0068774 |

Each decile cell gives the mean prediction followed by the observed score.

| Decile | Current formula | 50-game history | 150-game history | 200-game history |
|---:|---:|---:|---:|---:|
| 1 | 0.4802 / 0.4892 | 0.4750 / 0.4877 | 0.4742 / 0.4857 | 0.4732 / 0.4854 |
| 2 | 0.5015 / 0.5136 | 0.4969 / 0.5099 | 0.4961 / 0.5102 | 0.4953 / 0.5049 |
| 3 | 0.5057 / 0.5119 | 0.5034 / 0.5113 | 0.5030 / 0.5094 | 0.5025 / 0.5098 |
| 4 | 0.5095 / 0.5138 | 0.5084 / 0.5163 | 0.5082 / 0.5126 | 0.5080 / 0.5042 |
| 5 | 0.5132 / 0.5153 | 0.5129 / 0.5106 | 0.5128 / 0.5061 | 0.5127 / 0.5088 |
| 6 | 0.5170 / 0.5142 | 0.5171 / 0.5160 | 0.5172 / 0.5154 | 0.5173 / 0.5228 |
| 7 | 0.5207 / 0.5152 | 0.5216 / 0.5201 | 0.5218 / 0.5217 | 0.5221 / 0.5214 |
| 8 | 0.5245 / 0.5266 | 0.5265 / 0.5191 | 0.5270 / 0.5244 | 0.5275 / 0.5225 |
| 9 | 0.5287 / 0.5244 | 0.5330 / 0.5293 | 0.5337 / 0.5349 | 0.5346 / 0.5384 |
| 10 | 0.5493 / 0.5330 | 0.5542 / 0.5367 | 0.5551 / 0.5368 | 0.5561 / 0.5389 |

**The gate failed.** The 200-game model improved Brier by 0.0001406, with a
90% interval of +0.0000352 to +0.0002465. Log loss also fell. Decile error rose
from 0.0064461 to 0.0068774. The 50- and 150-game intervals include zero, and
both had higher decile error than the current formula. I kept the current odds
formula in the app.

```sh
python scripts/fit_history_odds.py
```

## How often players find the only good move

`scripts/eval_find_rate.py` (`build`, then `evaluate`). The review queue asks you to find a move you missed, and a miss means more if most players at your rating find that move. So the question is: in a position where only one move works, how often does a blitz player at a given rating find it, and does anything besides the rating predict it?

**Data.** From the engine dataset, every position in a third of the blitz games (chosen by a hash of the game ID) where the best move beats the second best by at least 20 points of win chance for the player to move, so missing it costs a lot. That gives 803,299 positions from 59,720 players. The label is whether the player chose Stockfish's best move. The rating is the player's rating before the game, from their previous game, as in the odds study. Players were split by a hash of their username: 645,716 positions from 47,852 players to fit and 157,583 from 11,868 players to test, so no tested player was seen in fitting. The only good move was found 79.3% of the time.

**Features.** Each is computable from the position and the best move alone, so the browser can compute it too: what piece moves, whether it captures (and what), gives check, promotes, castles, moves backward or sideways, escapes an attack or lands on an attacked square, whether the player is in check, how many legal moves, captures and checks there are, and the material. The clock and Stockfish's own numbers (the gap to the second move and the win chance) were tested as separate groups.

| Model (held-out players) | Log loss | Brier | AUC |
|---|---:|---:|---:|
| Overall rate | 0.5102 | 0.1643 | 0.500 |
| Rating | 0.5102 | 0.1643 | 0.508 |
| Rating and clock | 0.5069 | 0.1632 | 0.557 |
| Rating, clock and the move's features (logistic) | 0.4410 | 0.1428 | 0.758 |
| Same, plus Stockfish's gap and win chance (logistic) | 0.4323 | 0.1400 | 0.773 |
| Move features, gradient boosting | 0.4090 | 0.1332 | 0.800 |
| All features, gradient boosting | 0.4011 | 0.1306 | 0.811 |

The rating says almost nothing here, because nearly every position comes from players between 1400 and 1800 (the find rate goes from 77.9% at 1200 to 80.5% at 1800). What kind of move it is says a lot. With the logistic model's gain over the rating alone bootstrapped by player, log loss falls by 0.069 (90% interval 0.068 to 0.071). The largest effects: captures are found far more often, and more so the bigger the captured piece; a move to an attacked square, a position with many legal moves or many captures available, and being in check all make the move harder; and the more material the player is ahead, the less often they find it, possibly because a won position invites less care, though the data cannot say why. Gradient boosting is better again, but the logistic model is what the browser uses, since it is 27 numbers. Its calibration is within 6 points in every decile (predicted 47% against 53% actual at the hardest tenth, 97% against 98% at the easiest).

**In the extension.** `scripts/eval_find_rate.py evaluate` writes the coefficients to `web/src/browser/findRateModel.ts`, and `web/src/browser/findRate.ts` computes the same features with chess.js. `web/test/findRate.test.ts` checks the features and probabilities against Python on 300 held-out positions (all features identical, probabilities within 0.0001). After you reveal a review card, it says how often players near your rating then find the move, with the clock held at the training median (0.66 of the starting time) so the number describes the position and not your clock that day. The line appears only for ratings from 1200 to 2000, where the data are; outside that range there is no estimate, since the model at 1200 says little about players near 800. Two limits: the model was fitted on positions with one clearly best move, and a review position only promises that your move lost at least 20 points, so another move may also have worked; and the figure is rounded to the nearest 5%. Because the model was fitted on blitz only, the line appears only for positions from blitz games, and it says how often players find "moves like this", an estimate from the kind of move, rather than a measured rate for that exact position. Queue entries keep their game's time control; older entries get it from the profile, and those it cannot fill are marked unknown and show no estimate.

## Cross-language parity

The TypeScript port is tested against Python output on real games (`web/test/`, run in CI before every deploy):

- Opening statistics match to 1e-9, with identical verdicts and worst branches.
- scikit-learn's GroupKFold assignment is reproduced exactly, and logistic-regression probabilities match to 1e-8.
- The coach's facts and the game summaries match character for character. This caught a rounding difference: Python rounds halves to even (36.5 becomes 36) while JavaScript rounds them up.
- BM25 matches rank_bm25 to 1e-9, and given the same embedding vectors the hybrid ranking is identical.
- The tactic detector gives the same labels as the Python one on 3,000 Lichess puzzle positions, and the tactic summary, verdicts and coach facts match on real games. This caught a second rounding problem: multiplying 2.675 by 100 gives exactly 267.5 in floating point, so a check for exact halves has to read the number's real decimal digits.

## Deployment

- I run the Python tests, TypeScript tests and build, and Chrome extension build in GitHub Actions on pull requests and pushes to main.
- **Live demo:** GitHub Pages. `scripts/make_snapshot.py` saves an analysis and coach report for the opening page, and `.github/workflows/pages.yml` runs the TypeScript tests, builds `web/` and deploys it. Asset URLs carry the commit hash so new deploys show up right away.
- **Full app:** the Dockerfile builds the frontend and a Python image with Stockfish and CPU-only PyTorch (needed by sentence-transformers). `docker compose up --build` runs it with MySQL. Hosting defaults cap a request at 150 games, depth 8 and 2 engine workers.
- **Why not a free server host:** the free tiers I tried were either too slow for Stockfish (Render, 0.1 CPU) or now require a paid plan (Hugging Face Docker Spaces). Running everything in the browser avoids hosting entirely. `scripts/deploy_hf.sh` still deploys the image to a Space for anyone with a paid plan.

## Ideas for later

- Compare each opening against all Lichess players at the same rating, using the open Lichess database.
- Tag blunders by tactical motif (forks, pins, back-rank) and link matching Lichess puzzles.
- Load the tables into BigQuery; the SQL is standard and only the connection changes.
