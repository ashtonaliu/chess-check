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

- Each analysis is written to its own schema (`chesscheck_<hash>`) with `games` and `moves` tables. The hash covers the player-relative rows and engine results. A writer lock serializes creation, and a finished snapshot is reused as-is.
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
| Opponent note | The opponent's record in the opening as their color, from their last 100 games on Chess.com or their last 50 games in that color on Lichess |

**Fair play.** Chess.com forbids outside assistance during a game, and in live chess the clock starts at pairing, so there is no safe "before the game" moment. Recaps use only finished games, which is all the public API returns, and the opponent note and win probability appear only after the game.

**Chrome extension** (`extension/`, built from `web/src/extension/` by `scripts/build_extension.sh`). A Manifest V3 extension with three parts. A content script (`content.ts`) draws a 44 pixel draggable cube inside a closed Shadow DOM on Chess.com pages, so Chess.com's styles and the extension's cannot affect each other. It needs no setup. It takes the game ID from the address and gets both usernames from `/callback/live/game/<id>` (or `/callback/daily/game/<id>`), the same endpoint the game page loads. It reads the signed-in username from the user settings Chess.com embeds in every page as JSON, with the sidebar link to your profile as a fallback, and reads nothing else from the page. Signed out, it shows both players as buttons and remembers the one you pick. The callback returns 404 for a game that is still being played (I checked one game that went from 404 to a finished resignation a minute later), and the cube treats that as "your recap will appear when this game ends". It remembers its position in `chrome.storage`. An offscreen document (`offscreen.ts`) does the heavy work with the same browser code as the website: game fetching, the profile build, Stockfish (bundled, not loaded from a CDN, since the Chrome Web Store forbids remote code), tactics and the recap. When the engine runs: the cube asks the offscreen page to build ("warm") the profile only from pages that are not a game or the play page, for the time class the player played most in their last 40 games. Opening the play page or a game in progress sends "stop", which aborts the build through an AbortController between games or blunder checks (in testing, a build at game 64 of 150 restarted from scratch afterwards). Version 0.2 started the build as soon as any game page opened, including a game in progress.

Chromium reports Play and unconfirmed game routes to the service worker, and the content script closes the old recap when the route changes. The service worker keeps the paused tabs in session storage. Analysis stays paused across tabs until each affected tab leaves the route, closes, or confirms that its game is over.

The recap does not wait for the public archive. On a game page the cube asks `/callback/live/game/<id>` every 5 seconds; it answers 404 until a live game is over. The finished game's moves come in Chess.com's two-characters-per-move encoding, which `web/src/browser/tcn.ts` decodes (tested against the archive's PGN on three real games, including an underpromotion and a capturing promotion). `callbackGame.ts` rebuilds the PGN with clock times from the endpoint's move timestamps, takes pre-game ratings as the endpoint's rating minus its rating change, and names the opening from the past game that shares the longest run of opening moves, because the endpoint's ECO code does not always match the archive's (A84 against A40 for one game). Profiles are saved in IndexedDB (`profileStore.ts`) and reused after a restart, then refreshed in the background once per session; with the engine cache the refresh only analyzes new games. A first-ever build uses the last 50 games, and a 150-game build follows in the background; the recap says so while it is based on 50. The extension has the `unlimitedStorage` permission and the website asks for persistent storage, so the browser does not evict the caches when disk space runs low.

Measured in Chromium on chess.com (150 bullet games, no cache): engine pass 14.7 s, blunder re-check 5.4 s, fetching 0.7 s, patterns 0.6 s. A recap was ready 12.7 s after opening a finished game on a new install (50-game build), 1.5 s once the profile was full, and 3.2 s after restarting the browser. Raising the worker cap from 8 to 17 on an 18-core Mac only took a cold build from 21.0 to 19.7 s (two runs each), so the cap stays at 8. Since 2026-11-18 neither page waits for all of that. The recap shows the result as soon as the game is over and adds the turning point and then the history as each is ready (in the development harness: result 0.06 s, full recap 3.3 s with a saved profile and 35 s on a new install). The website shows the overall score and opening table as soon as the games are downloaded (2.4 s for 150 of my blitz games with nothing cached, against 23.1 s for the full analysis), and Cancel stops the engines mid-search. Profile builds wait until the finished game is analyzed so they do not compete with it, and an engine that crashes or stops answering for 60 seconds fails its pending searches instead of leaving them waiting. Caching positions across games was not worth adding: only 6.1% of 12,830 positions in 150 games repeated. Since 2026-11-18 a recap rechecks only the player's own blunders at depth 14, since the turning point needs no others, and each flagged position is its own task shared across up to 4 workers, so one game's blunders are checked in parallel. The deep results are cached position by position, and the profile build later checks only the opponent's, without repeating work. Each write merges into the stored entry in the same IndexedDB transaction that reads it, so a recap's recheck and a profile build's that overlap keep each other's positions (the first version wrote the whole entry, so the later writer could drop the other's). On three of my games, with old and new runs interleaved in the same page, the recheck went from 0.25, 0.15 and 0.51 seconds to 0.11, 0.15 and 0.19 (the middle game had one blunder, mine, so nothing changed). The extension's Chess.com script no longer loads chess.js: the find rate is worked out on the offscreen page, and board drawing moved to `web/src/ui/board.ts`, which only the website uses. With minification the script went from 155 KB to 44 KB (37 KB to 14 KB compressed), and the website's first load from 65 KB to 52 KB compressed. I also checked whether a background profile build makes Chess.com stutter, since it uses every core but one, up to 8. On my Mac (18 cores: 6 performance, 12 efficiency), a probe on a visible Chess.com tab in Chrome counted frames over 10 seconds and timed a fixed piece of JavaScript work every frame. With nothing else running it drew 1,203 frames with none longer than 50 ms. With 8 and then 17 Stockfish workers searching in another app (about 7.5 and 15 cores busy) it drew 1,201 frames each time, again none over 50 ms. During a real 50-game bullet build in the extension (up to about 8 cores), the busy probe drew 718 and 734 frames against 718 without it, and its work took 10.7 and 10.6 ms at the median against 10.5 ms. So the worker count stays as it is. This only covers a Mac with many cores, and I did not find out why the page was unaffected; a laptop with 4 cores is untested. A test that ran the workers in an ordinary Chrome tab was discarded, because they barely ran there (no search finished in 4 seconds, and Chrome used about one core).

Once Chess.com confirms the game is finished, I start reading the opponent's archive while Stockfish looks for the turning point. The player's archive waits until the turning point is found, because the first 50-game build reads it at that point anyway. The opening record and opponent note appear as soon as it arrives, before the build's Stockfish work, and the patterns appear when that build finishes.

**Adaptive worker count** (`web/src/browser/pace.ts`, tested in `web/test/pace.test.ts`; the stutter counting is `StallWatch` in `panelModel.ts`). Builds for different time controls can run at once, so they share one budget (`SharedPace`): each gets the count divided by the builds running, at least one, and a stutter lowers the count for all of them. A review pointed out that the first version gave each build its own count, so two builds could use twice the limit, and only the newest heard about stutter. Since the measurement above only covers my Mac, background profile builds now adapt to the device. The cube watches the Chess.com page it is on for long frames (Chrome's long-animation-frame entries; only their timing is read), ignoring the first 5 seconds of a page load and any time the tab is hidden. Two frames of 100 ms or more within 5 seconds send one report to the offscreen page, which drops one worker for the rest of that build. Workers above the current count wait between tasks instead of being shut down. The lower count is remembered on the device, a build that finishes without a report raises it by one, and a build starts at the remembered count or, the first time, at the usual count (every core but one, up to 8), so nobody's build is slower than before unless their page stutters. Builds the player is waiting on keep their fixed count. In the development harness, with fresh caches each time, a 50-game build took 40.6 s at the usual 8 workers; with reports sent at 5, 10 and 15 seconds it went from 8 to 7, 6 and 5 workers, took 49.1 s and remembered 5; the next build without reports started at 5, took 41.4 s and remembered 6. On a visible Chess.com tab in Chrome, two 300 ms freezes were reported as long frames of 331 and 307 ms. That test stopped at the page-side report.

**Slow CPU test.** I loaded the unpacked build in a fresh signed-out headless Chrome 157 profile for each run and opened [the same finished bullet game](https://www.chess.com/game/live/187138001290). I set DevTools CPU throttling on the Chess.com tab and the extension's offscreen document. I capped the worker budget at four and started it at four or two using the remembered worker count. This setting applies to the profile build. The finished game's own search kept its usual worker settings under the four-worker cap. I timed the turning point and complete recap from choosing White, and the first 50-game profile from the first observed active budget to the IndexedDB commit. These are single runs with live Chess.com responses and empty analysis caches.

- 4×, four starting workers: turning point 2.8 s, full recap 13.2 s, 50-game build 9.9 s.
- 4×, two starting workers: turning point 2.8 s, full recap 17.4 s, 50-game build 13.7 s.
- 6×, four starting workers: turning point 1.3 s, full recap 19.2 s, 50-game build 16.7 s.
- 6×, two starting workers: turning point 3.5 s, full recap 21.1 s, 50-game build 17.0 s.

The visible Chess.com tab reported zero long animation frames (50 ms or longer) during the 50- and 150-game builds in these four runs, over 31 to 47 seconds per run. In the 15 seconds before choosing a player it reported 6 to 11 long frames per run, with up to six lasting 100 ms or more. Separate 60-second no-analysis runs reported 10 long frames at 4× and 14 at 6×, of which four and eight reached 100 ms. At both throttle rates, four stayed at four. A build starting at two stayed there until the first profile was saved, then used three for the 150-game refresh and remembered four after that finished.

I also sent 40 previous and next move keystrokes over about 9.5 seconds on the finished board at 6×. During a four-worker build I observed 36 board position changes and zero long frames. With analysis idle I observed 40 position changes and zero long frames.

In a separate 6× run I deliberately blocked four frames on the finished-game page for about 145 ms each. The cube sent one stall report to the offscreen document. The build dropped from four workers to three and saved that count. The next build ran at three with no long frames and remembered four again.

I found a race at the end of the first build. The recap could use the 50-game profile and stop polling while its save was still in progress, leaving the 150-game refresh unstarted. I now make the profile available in the same step that clears the build. The regression test holds the save open and checks that the recap keeps polling and that its next request can start the refresh.

These measurements use [Chrome's main-thread throttling](https://chromium.googlesource.com/chromium/src/+/99baeeafe29b54168bc18411791025d4a9419eea/third_party/blink/renderer/platform/scheduler/public/thread_cpu_throttler.h) and an extension worker limit on my 18-core Mac. A physical four-core laptop or Chromebook can run the Stockfish workers more slowly and have more contention with the page.

**Four-vCPU Linux test.** I repeated the test on the same finished game in headless Chromium 156 on Debian 12, running inside a Colima VM with four ARM64 virtual CPUs and 4 GiB of RAM. Chromium reported four CPUs. I used a fresh browser profile for each run and throttled the Chess.com and offscreen main threads. I set the worker ceiling to four for the test and started the profile at two or four. I timed the recap from choosing White and the 50-game build from the first observed active worker budget to the IndexedDB commit.

- 4×, four starting workers: opening record and opponent note 3.5 s, turning point 2.7 s, full recap 14.9 s, 50-game build 11.8 s.
- 4×, two starting workers: opening record and opponent note 2.9 s, turning point 3.8 s, full recap 19.2 s, 50-game build 15.1 s.
- 6×, four starting workers: opening record and opponent note 3.8 s, turning point 4.7 s, full recap 20.3 s, 50-game build 15.0 s.
- 6×, two starting workers: opening record and opponent note 3.9 s, turning point 4.8 s, full recap 24.4 s, 50-game build 18.4 s.

On the previous build, the archive details appeared with the full recap at 16.6 s in the 4× four-worker run and at 25.5 s and 25.7 s in two 6× two-worker runs. After the change, the 6× two-worker runs showed the details at 3.9 s and 3.8 s, with full recaps at 24.4 s and 24.3 s. The turning point at 6× with two starting workers took 1.4 s and 3.6 s before, and 4.8 s and 4.7 s after. Fetching the archives early can compete with the game's search on the offscreen thread, and these runs include live network variation. These runs started both archives with the game's search. Since the turning point comes first in the recap, I moved the player's archive back until after the search, so the opening record now arrives a moment after the turning point.

I tried to re-time the turning point on `8e9882f` in the same VM with fresh signed-out profiles. At 4× and 6×, with two and four starting profile workers at each rate, the recap stayed paused after I chose White on the finished game. The trace showed the only Chess.com tab report the game finished, then emit another loading event for the same game. The service worker had marked the tab paused again by the time I chose White.

I fixed the service worker to preserve the finished game's confirmation through those loading events. In the same VM on the same finished game, all five attempts showed the turning point. At 4× it took 2.9 s with two starting profile workers and 2.9 s with four. At 6× it took 1.3 s and 3.4 s with two starting profile workers, and 3.6 s with four. The two 6× samples with two workers were close to the earlier 1.4 s and 3.6 s. These timings include live network variation and cover the turning point only.

There were zero frames of 50 ms or longer from the start of the first profile through the 150-game save in these four runs. The per-run windows were 37 to 55 seconds. The worker count stayed at four when it started there. Both two-worker runs used three for the refresh and remembered four. With four deliberate stalls at 6×, the budget dropped to three. The next build ran at three and remembered four.

I first saw 36 board changes for 40 arrow presses during a four-worker run. I repeated the 6× comparison after moving away from either end of the finished game's score. All 40 presses changed the board in each of the idle, two-worker, and four-worker runs. The 95th-percentile time from a keydown to the first change in piece positions was 5.3, 6.6, and 8.1 ms, respectively. The same windows had one, two, and one long frames. The longest was 110 ms in the two-worker run. These single runs measure a DOM update, before the board is painted.

I also held an archive reply in the content script, changed the URL to Play in the same document, and released the reply. The panel discarded the reply, hid the cube, and sent the stop request. The virtual machine limits how many CPUs Chrome and Stockfish share. It still runs on my Mac's CPU and uses a headless graphics stack.

I first also tuned the count by how fast the build went: every 4 seconds, add a worker if the last one made the build at least 10% faster, else step back. Starting from 2 workers it stopped at 2 (86.7 s against 40.6 s at 8), counting finished games. Counting individual searches and lowering the bar to 3% it still stopped at 4 (66.5 s). The speed over a few seconds depends on which positions happen to be searched more than on one worker more or less, so I dropped that part. The calm build above also shows why the count matters less than expected: 5 workers built as fast as 8, and the offscreen process used only 2 to 3 cores with 5 workers, which suggests the offscreen page's own thread (chess.js work for every position, between searches) limits the build, not the number of Stockfish workers.

**The offscreen page's own work.** Following that up: timing the chess.js work the offscreen page does for each position in the depth-8 pass (in Node, on 6,312 positions from 30 games) gave about 1.0 ms per position, 82% of it one call, `moves({ verbose: true })`, used only to count legal moves and captures. In chess.js 1.x the verbose form builds the position before and after every legal move. The plain SAN list gives the same two counts (identical on all 6,312 positions, captures being the moves with an "x") in 0.06 ms instead of 0.80. With that change, in the development harness with fresh caches, the depth-8 pass of a 50-game build took 6.5 and 7.6 seconds against 15.2 and 16.9 before. The whole build did not shrink as clearly, because the deep recheck that follows took 25 to 34 seconds and varied that much between identical runs; during it the process used 2 to 5 cores out of 8 workers, and in one run nearly none for its last 8 seconds, which I have not explained. The website's analysis uses the same code, so it gains the same.

**Why the deep recheck left cores idle.** Timing every deep search in a build (an instrumented page, 50 games, 8 workers, in a visible Chrome tab) ruled out the offscreen page: the gaps between one search answering and the same engine's next search added up to 0.18 seconds, and 8 searches were in flight for most of the stage. But the searches were wildly uneven, half under 100 ms and the slowest 26 seconds, and the slow ones barely used the CPU. Stockfish's own output gave the reason. On one endgame it reached depth 12 in 0.12 seconds (88,000 nodes, about 720,000 a second), then took 7.5 seconds for depth 13 at about 38,000 nodes a second: the search was mostly waiting. The single-threaded WebAssembly build pauses during a search so the worker can read messages such as "stop" (Emscripten's `emscripten_sleep` through Asyncify), it pauses with `setTimeout`, and browsers make a nested `setTimeout` wait at least 4 ms. The build now changes that one line: a sleep of 0 ms yields through a `MessageChannel`, which has no minimum (`web/scripts/patchStockfish.mjs`, tested in `web/test/patchStockfish.test.ts`; the WebAssembly file is unchanged). Run alone in Chrome, three of the slowest positions took 36.5, 2.2 and 28.9 seconds before and 1.8, 0.35 and 1.5 after, with the same node counts, scores and best moves. For the whole recheck of a 50-game build, two runs before took 34.5 seconds each; three runs after took 21.8, 10.7 and 10.2 seconds, the first still with several searches of 7 to 12 seconds, which I suspect came from an old copy of the engine in Chrome's cache but did not confirm. A whole 50-game run took 17.0 and 16.4 seconds in the last two. The recap's own analysis and the website use the same engine file, so they gain too. Native Stockfish needs far fewer nodes on these positions (36,746 against 941,448 at depth 14 on the first), because the browser build uses a smaller network; that difference remains.

**Deep search order.** The shallow pass records Stockfish's combined node count for the positions before and after each move. The deep pass starts the flagged positions with the highest shallow counts first. Older cached rows use the median count of the measured tasks, or the original order when none have counts. On three 50-game blitz samples in headless Chrome with eight workers, two runs per order per sample, the median time from the first idle worker to completion fell from 202 ms to 82 ms. Median wall time for the whole deep pass was 1.56 s in game order and 1.54 s with the new order. Shallow counts estimate search cost, and individual runs still vary.

**Extension storage.** I measured the UTF-8 JSON size of the keys and values in a clean Chrome profile after recapping a finished bullet game (187138001290) and building a 150-game bullet profile. Its completed recap was 1,075 bytes in memory, the depth-8 record was 31,860 bytes, and the depth-14 record was 459 bytes after the profile recheck. Across the 150 games, depth 8 averaged 34.2 KiB per game and depth 14 averaged 366 bytes per game, including the 16 games that added no deep record. A 50-game profile was about 429 KiB and its 150-game replacement was 1.19 MiB, about 7.9 KiB per extra game between those two snapshots. Once full, a profile replaces the record for the same player and time control, so another game does not add another profile.

At one analyzed game a day for a year, those averages give 12.2 MiB of shallow cache, 0.13 MiB of deep cache and one 1.19 MiB profile, or about 13.5 MiB on disk before database overhead. At five games a day the same estimate is 62.7 MiB. If every game got a recap and the offscreen page stayed open all year, the old in-memory recap cache would add about 0.37 MiB at one game a day or 1.87 MiB at five. These are payload estimates from bullet games. The shallow record grows with the number of moves, and Chrome's IndexedDB files have their own storage overhead.

The extension keeps 200 completed recaps in memory by last use. The offscreen page trims IndexedDB on its first safe analysis request and after a set of profile builds finishes. It keeps 1,500 shallow and 1,500 deep entries, newest game end time first. Old cache entries without a date use game ID order as a fallback behind dated entries. It keeps eight profiles by last use, falling back to when the profile was saved. At the measured sizes those counts are roughly 50 MiB shallow, 0.6 MiB deep, 9.5 MiB of profiles and 0.2 MiB of recaps, assuming eight full profiles. Counts can grow between cleanup passes. An unfinished review card keeps its game's analysis and can keep an older profile if the card is missing its position or time control. The current and building profiles, games in the kept profiles, and unfinished recap work also take priority over the limits. Play and games in progress send the same stop request as before, which now also cancels a cleanup that has yet to commit.

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

### Where the time goes

I used the unpacked profiling build in Chrome 158.0.8127.38 on an M5 Pro Mac. I opened only the
finished games, with three fresh Chrome profiles per site. I preselected the player so the clock
starts just before the content script's first game check and ends each stage when the panel
updates. Each run started with an empty profile, let the 150-game profile save, then opened a
second game and reopened its recap. Before opening the second game I cleared its search cache
in the temporary browser profile. Reopening kept Chrome's ordinary page and response caches.
Run `node scripts/profile_recaps.mjs /tmp/recaps.json` for the two sites and a JSON report.
[Timing tool](../scripts/profile_recaps.mjs) · [Recap results](../README.md#results)

The turning point took about 1.1 s on Lichess and 1.3 s on Chess.com. The panel polls every
second, and the game's own engine and blunder work finished in under half a second in these
runs. Lichess's opponent note arrived about 5 s in, on the same update as the full recap with
a saved profile. That is the time to download the opponent's last 100 games, since Lichess sends
anonymous history at about 20 games a second, so the opponent note sets the Lichess recap time
once a profile is saved. The first recap also builds the 50-game profile.

The note only reads the opponent's games in the color they had, and about half of their last 100
games are in it. Lichess can filter history by color, so the extension and the website now ask
for their last 50 games in that color. For 6 players from finished games in the parity fixture,
3 runs each and one request at a time, the median download went from 4.16 s for 100 games to
2.16 s for 50. The old request held a median of 50 games in the note's color (49 to 50), so the
note reads about as many games as before. Chess.com's archive cannot be filtered by color, and its
pregame ratings need the games in between, so it still reads 100 games. I measured the download
with the API alone. Lichess showed a security check to headless Chrome, so I did not rerun the
recap timings above. Run `python scripts/time_lichess_opponent_history.py /tmp/opponent.json`.

I timed each search from sending the position to receiving `bestmove` and used the last UCI
`info` line with a `time` field for Stockfish's own time. The 12 new recaps totaled 2.84 s
across 980 searches, against 3.07 s reported by Stockfish. The six 150-game refreshes, each
reusing the first 50 games' searches, totaled 271.83 s across 49,865 searches, against 278.21 s
reported. These are sums across workers. The raw gaps were -8.1% and -2.3%. Stockfish uses
integer millisecond timestamps and reports at least 1 ms, so those gaps are within the
clock's resolution. Allowing 1 ms per search puts the overhead at up to about 26% of the
recap search time and 16% of the profile search time. Even the whole search round trip
amounted to about 0.24 s per recap. [Stockfish.js clock](https://github.com/nmrugg/stockfish.js/blob/0d5dd79/src/misc.h#L140-L146) · [UCI time field](https://github.com/nmrugg/stockfish.js/blob/0d5dd79/src/search.cpp#L2134-L2139)

I would keep the current Stockfish build.

### End-to-end tests

I load the unpacked extension in headless Chromium and run Stockfish in the offscreen page.
The 8 tests check finished recaps and reopening at the turning point on both sites, the
Chess.com `/play` and `/live` cross-tab pause, and what happens when a game is still in
progress or is aborted. A loopback HTTPS server supplies the game data and small stand-ins
for the pages. The proxy rejects requests outside the fixtures. The store ZIP check makes
sure the panel's shadow root stays closed.

The suite took 16.6 s on my M5 Pro Mac and 20.3 s on GitHub's Ubuntu runners, the median of
3 runs on each. That is the browser test time, with installation and build time excluded.
The stand-ins cannot catch changes to either site's live markup, API availability, or
sign-in behavior. To run it, install Chromium with `npx playwright install chromium --no-shell`
in `web`, then run `npm run test:e2e`.

## Lichess

A Lichess game keeps the same address when it ends, and its export can answer while the game is
still being played. Every game page starts paused. Play pages and pages the extension does not
recognize also pause analysis across tabs.

**Fair play.** The service worker first checks `/game/export/{id}` with `moves=false&clocks=false`
and reads only the status. Once it sees a finished status, it fetches the export with moves and
clocks and checks the status and game ID again before passing along the details. The offscreen page
checks both again before parsing. The private 12-character player ID stays in the page address.
The extension uses only the public 8-character ID in requests, messages and storage.

**Requests.** One queue in the service worker handles both game checks and history. It runs one
request at a time and starts status checks on the same tab at least 3 seconds apart. A 429 pauses
the queue for a full minute. The worker saves the end of that wait in Chrome's session storage and
restores it after a restart.

**Parity.** I used 20 finished games from the October 2026 archive. TypeScript and Python read the
same fixture and compare the parsed games with the Phase A PGN ingest. Both tests check pregame
ratings and scores from each player's side. They also check the moves, opening, speed and time
control, and compare each recorded clock with the PGN to within 1 second.
[Shared fixture](../web/test/fixtures/lichess_parity.json) · [TypeScript #125](https://github.com/ashtonaliu/chess-check/pull/125) · [Python #127](https://github.com/ashtonaliu/chess-check/pull/127)

**What I changed from the plan.**

- I first wrote down root-level game addresses. The extension uses `/game/{id}` and recognizes
  the old addresses in the guard.
- An aborted game would have polled forever under the old pending rule. Both `aborted` and
  `noStart` now stop polling with no recap.
- With `perfType` omitted, variants and games from custom starting positions could use up
  `max` before the parser dropped them. Every history request now sends `perfType`. With no
  time class selected it asks for UltraBullet, bullet, blitz, rapid, classical and correspondence.
- Lichess reads the `#ply` fragment and then clears it. The content script saves the initial
  fragment before the board loads so it can reopen the review card at that position.

**Live recap.** I used the unpacked extension in Chrome on the finished game BYvvanic and started
timing when I chose the player. The result, pregame ratings, opening and expected score appeared
at once. The turning point and opponent note were in by 8.2 s, when the panel estimated about
1 s left. I checked about every 7 seconds, so 15.2 s is an upper bound for the complete recap.
Cloudflare took about 6 s before the game page loaded, outside the recap timing.
[Finished game](https://lichess.org/game/BYvvanic)

Reopening that game reused the existing recap and showed it in under 1 s. With the 50-game profile
saved, a new game by the same player (oiuCrb3L) had its full recap by 7.6 s after I chose the
player. On a third game (jXSW5txW), with the player remembered, the recap started on page load
and was complete by 7.0 s, including Lichess's own page load. Each browser step I took added
about a second, so these are upper bounds as well. With a local finished-game fixture and six
history records, the complete recap took 2.16 s cold and 1.34 s on reopening.

**Demo.** The website fetches Lichess history directly, with the same request parameters as the
extension, one request at a time, and fails at once for a minute after a 429. On my 18-core Mac in
Chrome 156, 150 blitz games with nothing cached showed the score and opening table after 7.11 and
7.26 s in two runs, and the full analysis after 15.97 and 16.27 s. Lichess sends anonymous history
at about 20 games a second, so the first number is mostly the download. On Chess.com the same
table appears in 2.4 s. [Demo PR #129](https://github.com/ashtonaliu/chess-check/pull/129)

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

The rating says almost nothing here, because nearly every position comes from players between 1400 and 1800 (the find rate goes from 77.9% at 1200 to 80.5% at 1800). What kind of move it is says a lot. With the logistic model's gain over the rating alone bootstrapped by player, log loss falls by 0.069 (90% interval 0.068 to 0.071). The largest effects: captures are found far more often, and more so the bigger the captured piece; a move to an attacked square, a position with many legal moves or many captures available, and being in check all make the move harder; and the more material the player is ahead, the less often they find it, possibly because a won position invites less care, though the data cannot say why. The logistic model was the first extension model and has 27 coefficients. Its calibration is within 6 points in every decile (predicted 47% against 53% actual at the hardest tenth, 97% against 98% at the easiest).

**Review cards and ordering.** The extension uses the neural model described under [Shipped review model](#shipped-review-model). It estimates how often players on the same site, in the same speed, and near your rating find moves like this, with the clock held at 0.6561 of the starting time so the estimate describes the position. The review card shows the estimate after the answer only within the calibrated site, speed, and rating limits below. The displayed rating is rounded to the nearest 50 and the estimate to the nearest 5%. Training positions had one clearly best move. A review card requires a loss of at least 20 points, so the position can also have other good moves. Review order uses the unrounded estimate, highest first. Positions without an estimate count as the typical 79%.

**Review card calibration and limits.** To set the allowed site, speed, and rating limits from held-out data, `scripts/calibrate_review_find_rate.py` evaluates the shipped float16 weights (`web/src/extension/neuralFindRateWeights.json`) at the fixed review clock fraction 0.6561 on the held-out test split from `scripts/prepare_neural_find_rate.py` (157,583 Chess.com blitz positions and 106,835 Lichess positions across five speeds; 264,418 positions total).

I first tried a fixed cutoff of 10-bin equal-width ECE at most 0.03 with at least 200 positions per 100-point band. I replaced that rule after review because 10-bin ECE is biased upward in small samples. With 293 positions, a calibrated model's simulated 95th-percentile ECE is 0.0689 and its draws exceed 0.03 most of the time, while at 2,000 positions it almost never does. A flat 0.03 cutoff therefore measured sample size as much as miscalibration, dropping noisy small bands whose mean predictions were accurate while letting larger bands with real bias slip under 0.03.

The revised rule keeps the `n >= 200` minimum and the longest contiguous span per site and speed, and judges each band against its own sampling noise floor (2,000 Monte Carlo draws of `y ~ Bernoulli(p)` with seed 24):

- Group held-out test positions by site, speed, and 100-point rating band (`[B, B + 99]`).
- Mark bands with fewer than 200 positions as too few to judge.
- Simulate 2,000 sets of binary outcomes from the band's own predicted probabilities and take the 95th percentile of the simulated 10-bin ECE as the noise floor.
- Fail a band only when its observed 10-bin ECE exceeds that noise floor and its mean bias `|mean predicted - mean actual|` exceeds 0.02.
- Allow the longest contiguous span of passing bands per site and speed. Speeds with no held-out data (Chess.com bullet, rapid, and daily; Lichess daily) remain disabled.

Comparing both rules shows what changed, and gives the limits enforced in `web/src/browser/rateRange.ts`:

| Site | Speed | First rule (ECE <= 0.03) | Revised rule | Held-out n in revised range | Predicted | Actual | Worst band ECE | Brier |
|---|---|---|---:|---:|---:|---:|---:|---:|
| Chess.com | blitz | 1300-1899 | 1200-1899 | 154,900 | 0.7924 | 0.7926 | 0.0530 | 0.1311 |
| Lichess | blitz | 1100-2299 | 1100-1899 | 14,563 | 0.7783 | 0.7796 | 0.0290 | 0.1366 |
| Lichess | rapid | 1300-2199 | 1300-2199 | 15,543 | 0.7880 | 0.8043 | 0.0264 | 0.1279 |
| Lichess | bullet | 1500-2199 | 1000-2299 | 18,133 | 0.7458 | 0.7466 | 0.0488 | 0.1479 |
| Lichess | classical | 1200-1799 | 1100-1699 | 11,220 | 0.7612 | 0.7609 | 0.0352 | 0.1507 |
| Lichess | ultraBullet | 2000-2199 | 1000-1799 | 10,312 | 0.5547 | 0.5562 | 0.0762 | 0.2089 |
| Chess.com | rapid | 1800-1899 | 1800-2099 | 1,884 | 0.8640 | 0.8593 | 0.0334 | 0.0964 |
| Chess.com | bullet | 1800-1899 | 1700-2099 | 2,631 | 0.7919 | 0.7868 | 0.0419 | 0.1362 |

**Effect on Chess.com users.** Previously, Chess.com blitz showed estimates for ratings 1200 through 2000. Under the revised rule, the range narrows only at the top, to 1200 through 1899:

| Chess.com blitz band | Previous (1200-2000) | Revised (1200-1899) | n | Predicted | Actual | Bias | 10-bin ECE | Noise p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|
| 1200-1299 | shown | shown | 293 | 0.7669 | 0.7645 | +0.0023 | 0.0530 | 0.0689 |
| 1300-1399 | shown | shown | 1,893 | 0.7791 | 0.7845 | -0.0053 | 0.0224 | 0.0264 |
| 1400-1499 | shown | shown | 7,170 | 0.7777 | 0.7848 | -0.0071 | 0.0088 | 0.0135 |
| 1500-1599 | shown | shown | 29,403 | 0.7845 | 0.7904 | -0.0059 | 0.0109 | 0.0066 |
| 1600-1699 | shown | shown | 57,209 | 0.7887 | 0.7909 | -0.0021 | 0.0097 | 0.0048 |
| 1700-1799 | shown | shown | 44,317 | 0.7975 | 0.7951 | +0.0024 | 0.0063 | 0.0053 |
| 1800-1899 | shown | shown | 14,615 | 0.8163 | 0.8017 | +0.0145 | 0.0159 | 0.0089 |
| 1900-1999 | shown | hidden | 1,966 | 0.8324 | 0.7986 | +0.0338 | 0.0339 | 0.0233 |
| 2000-2099 | 2000 only | hidden | 219 | 0.8892 | 0.8584 | +0.0308 | 0.0461 | 0.0553 |

The 1200-1299 band stays in because its observed ECE (0.0530) sits below its 95th-percentile noise floor (0.0689) and its mean prediction (76.69%) is within 0.23 points of actual (76.45%). The 1900-1999 band is dropped because it over-predicts by 3.38 points across 1,966 positions and its ECE (0.0339) exceeds its noise floor (0.0233). On Lichess, the revised rule catches real under-prediction in blitz at 1900-1999 (-2.95 points, ECE 0.0295 vs noise floor 0.0253) and in classical at 1700-1799 (-2.94 points, ECE 0.0294 vs 0.0213), while keeping bullet (1000-2299) and ultraBullet (1000-1799) bands whose earlier misses were small-sample bin noise. Holding the clock fraction at 0.6561 still drives the upper-end under-prediction in slower Lichess speeds, where median test clock fractions are 0.8017 in rapid and 0.8822 in classical against 0.6556 in Chess.com blitz and 0.6750 in Lichess blitz.

| Site | Speed | Rating band | n | Predicted | Actual | Bias | 10-bin ECE | Noise p95 | Brier | Status |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| Chess.com | blitz | 300-399 | 5 | 0.8182 | 1.0000 | -0.1818 | 0.1818 | n/a | 0.0577 | too few |
| Chess.com | blitz | 400-499 | 7 | 0.8786 | 0.2857 | +0.5929 | 0.5929 | n/a | 0.5419 | too few |
| Chess.com | blitz | 500-599 | 7 | 0.7517 | 0.5714 | +0.1803 | 0.2061 | n/a | 0.2697 | too few |
| Chess.com | blitz | 600-699 | 29 | 0.8142 | 0.8276 | -0.0134 | 0.0983 | n/a | 0.1224 | too few |
| Chess.com | blitz | 700-799 | 76 | 0.8187 | 0.7632 | +0.0555 | 0.0583 | n/a | 0.1494 | too few |
| Chess.com | blitz | 800-899 | 7 | 0.8415 | 1.0000 | -0.1585 | 0.1585 | n/a | 0.0456 | too few |
| Chess.com | blitz | 900-999 | 38 | 0.7629 | 0.6053 | +0.1576 | 0.1955 | n/a | 0.1834 | too few |
| Chess.com | blitz | 1000-1099 | 69 | 0.7729 | 0.8261 | -0.0532 | 0.0673 | n/a | 0.1297 | too few |
| Chess.com | blitz | 1100-1199 | 40 | 0.7486 | 0.7000 | +0.0486 | 0.0929 | n/a | 0.1522 | too few |
| Chess.com | blitz | 1200-1299 | 293 | 0.7669 | 0.7645 | +0.0023 | 0.0530 | 0.0689 | 0.1289 | allowed |
| Chess.com | blitz | 1300-1399 | 1893 | 0.7791 | 0.7845 | -0.0053 | 0.0224 | 0.0264 | 0.1357 | allowed |
| Chess.com | blitz | 1400-1499 | 7170 | 0.7777 | 0.7848 | -0.0071 | 0.0088 | 0.0135 | 0.1334 | allowed |
| Chess.com | blitz | 1500-1599 | 29403 | 0.7845 | 0.7904 | -0.0059 | 0.0109 | 0.0066 | 0.1320 | allowed |
| Chess.com | blitz | 1600-1699 | 57209 | 0.7887 | 0.7909 | -0.0021 | 0.0097 | 0.0048 | 0.1322 | allowed |
| Chess.com | blitz | 1700-1799 | 44317 | 0.7975 | 0.7951 | +0.0024 | 0.0063 | 0.0053 | 0.1294 | allowed |
| Chess.com | blitz | 1800-1899 | 14615 | 0.8163 | 0.8017 | +0.0145 | 0.0159 | 0.0089 | 0.1278 | allowed |
| Chess.com | blitz | 1900-1999 | 1966 | 0.8324 | 0.7986 | +0.0338 | 0.0339 | 0.0233 | 0.1330 | fail |
| Chess.com | blitz | 2000-2099 | 219 | 0.8892 | 0.8584 | +0.0308 | 0.0461 | 0.0553 | 0.1079 | pass (outside span) |
| Chess.com | blitz | 2100-2199 | 125 | 0.9096 | 0.8800 | +0.0296 | 0.0508 | n/a | 0.0958 | too few |
| Chess.com | blitz | 2200-2299 | 28 | 0.8955 | 0.7857 | +0.1098 | 0.1585 | n/a | 0.1084 | too few |
| Chess.com | blitz | 2300-2399 | 39 | 0.9509 | 0.7949 | +0.1561 | 0.1561 | n/a | 0.1737 | too few |
| Chess.com | blitz | 2400-2499 | 6 | 0.9809 | 1.0000 | -0.0191 | 0.0191 | n/a | 0.0009 | too few |
| Chess.com | blitz | 2500-2599 | 16 | 0.9732 | 1.0000 | -0.0268 | 0.0268 | n/a | 0.0040 | too few |
| Chess.com | blitz | 2800-2899 | 2 | 0.9970 | 1.0000 | -0.0030 | 0.0030 | n/a | 0.0000 | too few |
| Chess.com | blitz | 2900-2999 | 4 | 0.9821 | 0.7500 | +0.2321 | 0.2321 | n/a | 0.2381 | too few |
| Lichess | blitz | 400-499 | 8 | 0.6912 | 0.2500 | +0.4412 | 0.4412 | n/a | 0.3813 | too few |
| Lichess | blitz | 500-599 | 17 | 0.7179 | 0.3529 | +0.3650 | 0.3650 | n/a | 0.2984 | too few |
| Lichess | blitz | 600-699 | 48 | 0.7023 | 0.5833 | +0.1190 | 0.1319 | n/a | 0.2381 | too few |
| Lichess | blitz | 700-799 | 160 | 0.7094 | 0.6250 | +0.0844 | 0.0944 | n/a | 0.2051 | too few |
| Lichess | blitz | 800-899 | 278 | 0.7284 | 0.6547 | +0.0738 | 0.0815 | 0.0738 | 0.1862 | fail |
| Lichess | blitz | 900-999 | 520 | 0.7393 | 0.7231 | +0.0162 | 0.0367 | 0.0537 | 0.1687 | pass (outside span) |
| Lichess | blitz | 1000-1099 | 708 | 0.7287 | 0.6794 | +0.0493 | 0.0600 | 0.0467 | 0.1788 | fail |
| Lichess | blitz | 1100-1199 | 1014 | 0.7524 | 0.7377 | +0.0148 | 0.0283 | 0.0378 | 0.1472 | allowed |
| Lichess | blitz | 1200-1299 | 1340 | 0.7609 | 0.7381 | +0.0228 | 0.0290 | 0.0327 | 0.1592 | allowed |
| Lichess | blitz | 1300-1399 | 1610 | 0.7633 | 0.7683 | -0.0051 | 0.0135 | 0.0296 | 0.1418 | allowed |
| Lichess | blitz | 1400-1499 | 1861 | 0.7692 | 0.7695 | -0.0002 | 0.0127 | 0.0274 | 0.1390 | allowed |
| Lichess | blitz | 1500-1599 | 2070 | 0.7813 | 0.7908 | -0.0095 | 0.0168 | 0.0253 | 0.1296 | allowed |
| Lichess | blitz | 1600-1699 | 2173 | 0.7854 | 0.7809 | +0.0044 | 0.0144 | 0.0249 | 0.1352 | allowed |
| Lichess | blitz | 1700-1799 | 2269 | 0.7883 | 0.7959 | -0.0076 | 0.0149 | 0.0238 | 0.1320 | allowed |
| Lichess | blitz | 1800-1899 | 2226 | 0.7991 | 0.8122 | -0.0131 | 0.0229 | 0.0241 | 0.1252 | allowed |
| Lichess | blitz | 1900-1999 | 1845 | 0.8101 | 0.8396 | -0.0295 | 0.0295 | 0.0253 | 0.1106 | fail |
| Lichess | blitz | 2000-2099 | 1355 | 0.8254 | 0.8494 | -0.0241 | 0.0257 | 0.0281 | 0.1053 | pass (outside span) |
| Lichess | blitz | 2100-2199 | 896 | 0.8350 | 0.8471 | -0.0120 | 0.0166 | 0.0343 | 0.1064 | pass (outside span) |
| Lichess | blitz | 2200-2299 | 525 | 0.8441 | 0.8514 | -0.0074 | 0.0296 | 0.0426 | 0.0995 | pass (outside span) |
| Lichess | blitz | 2300-2399 | 286 | 0.8519 | 0.8322 | +0.0197 | 0.0437 | 0.0586 | 0.1095 | pass (outside span) |
| Lichess | blitz | 2400-2499 | 190 | 0.8632 | 0.8789 | -0.0158 | 0.0400 | n/a | 0.0967 | too few |
| Lichess | blitz | 2500-2599 | 77 | 0.8700 | 0.9091 | -0.0391 | 0.0524 | n/a | 0.0749 | too few |
| Lichess | blitz | 2600-2699 | 16 | 0.8900 | 0.8750 | +0.0150 | 0.1073 | n/a | 0.1345 | too few |
| Lichess | blitz | 2700-2799 | 11 | 0.8840 | 0.9091 | -0.0250 | 0.0767 | n/a | 0.0539 | too few |
| Lichess | blitz | 2800-2899 | 4 | 0.9171 | 1.0000 | -0.0829 | 0.0829 | n/a | 0.0077 | too few |
| Lichess | blitz | 2900-2999 | 1 | 0.8338 | 1.0000 | -0.1662 | 0.1662 | n/a | 0.0276 | too few |
| Lichess | rapid | 400-499 | 33 | 0.6704 | 0.5455 | +0.1250 | 0.1432 | n/a | 0.2149 | too few |
| Lichess | rapid | 500-599 | 77 | 0.6621 | 0.5714 | +0.0907 | 0.0926 | n/a | 0.2315 | too few |
| Lichess | rapid | 600-699 | 196 | 0.6403 | 0.5408 | +0.0995 | 0.0995 | n/a | 0.2144 | too few |
| Lichess | rapid | 700-799 | 355 | 0.6464 | 0.5606 | +0.0858 | 0.0858 | 0.0718 | 0.2009 | fail |
| Lichess | rapid | 800-899 | 669 | 0.6727 | 0.6293 | +0.0434 | 0.0434 | 0.0517 | 0.1935 | pass (outside span) |
| Lichess | rapid | 900-999 | 931 | 0.6673 | 0.6574 | +0.0100 | 0.0323 | 0.0443 | 0.1836 | pass (outside span) |
| Lichess | rapid | 1000-1099 | 1210 | 0.6936 | 0.6868 | +0.0068 | 0.0270 | 0.0375 | 0.1786 | pass (outside span) |
| Lichess | rapid | 1100-1199 | 1447 | 0.7106 | 0.7249 | -0.0144 | 0.0375 | 0.0337 | 0.1634 | pass (outside span) |
| Lichess | rapid | 1200-1299 | 1637 | 0.7256 | 0.7489 | -0.0233 | 0.0380 | 0.0309 | 0.1509 | fail |
| Lichess | rapid | 1300-1399 | 2019 | 0.7404 | 0.7632 | -0.0229 | 0.0253 | 0.0274 | 0.1446 | allowed |
| Lichess | rapid | 1400-1499 | 2047 | 0.7601 | 0.7855 | -0.0254 | 0.0254 | 0.0259 | 0.1400 | allowed |
| Lichess | rapid | 1500-1599 | 2565 | 0.7702 | 0.7747 | -0.0045 | 0.0217 | 0.0235 | 0.1438 | allowed |
| Lichess | rapid | 1600-1699 | 2375 | 0.7883 | 0.8008 | -0.0125 | 0.0177 | 0.0230 | 0.1272 | allowed |
| Lichess | rapid | 1700-1799 | 2146 | 0.7992 | 0.8131 | -0.0139 | 0.0155 | 0.0243 | 0.1225 | allowed |
| Lichess | rapid | 1800-1899 | 1896 | 0.8120 | 0.8265 | -0.0145 | 0.0201 | 0.0247 | 0.1193 | allowed |
| Lichess | rapid | 1900-1999 | 1323 | 0.8310 | 0.8519 | -0.0208 | 0.0228 | 0.0290 | 0.1056 | allowed |
| Lichess | rapid | 2000-2099 | 763 | 0.8441 | 0.8676 | -0.0236 | 0.0256 | 0.0366 | 0.0988 | allowed |
| Lichess | rapid | 2100-2199 | 409 | 0.8587 | 0.8851 | -0.0264 | 0.0264 | 0.0481 | 0.0843 | allowed |
| Lichess | rapid | 2200-2299 | 178 | 0.8733 | 0.9326 | -0.0593 | 0.0593 | n/a | 0.0587 | too few |
| Lichess | rapid | 2300-2399 | 88 | 0.9014 | 0.9545 | -0.0532 | 0.0598 | n/a | 0.0581 | too few |
| Lichess | rapid | 2400-2499 | 38 | 0.8386 | 0.9474 | -0.1087 | 0.1338 | n/a | 0.0584 | too few |
| Lichess | rapid | 2500-2599 | 10 | 0.9425 | 0.9000 | +0.0425 | 0.0948 | n/a | 0.0700 | too few |
| Lichess | rapid | 2600-2699 | 1 | 0.9960 | 1.0000 | -0.0040 | 0.0040 | n/a | 0.0000 | too few |
| Lichess | bullet | 400-499 | 2 | 0.8222 | 0.5000 | +0.3222 | 0.4718 | n/a | 0.3264 | too few |
| Lichess | bullet | 500-599 | 7 | 0.6764 | 0.5714 | +0.1050 | 0.3660 | n/a | 0.2125 | too few |
| Lichess | bullet | 600-699 | 10 | 0.7546 | 0.8000 | -0.0454 | 0.2652 | n/a | 0.2156 | too few |
| Lichess | bullet | 700-799 | 58 | 0.6879 | 0.6207 | +0.0672 | 0.0672 | n/a | 0.2069 | too few |
| Lichess | bullet | 800-899 | 147 | 0.6814 | 0.6735 | +0.0080 | 0.0765 | n/a | 0.1704 | too few |
| Lichess | bullet | 900-999 | 252 | 0.7043 | 0.6468 | +0.0575 | 0.0862 | 0.0787 | 0.1767 | fail |
| Lichess | bullet | 1000-1099 | 511 | 0.7014 | 0.7025 | -0.0011 | 0.0209 | 0.0558 | 0.1605 | allowed |
| Lichess | bullet | 1100-1199 | 642 | 0.7232 | 0.7103 | +0.0129 | 0.0259 | 0.0483 | 0.1562 | allowed |
| Lichess | bullet | 1200-1299 | 795 | 0.7038 | 0.7069 | -0.0031 | 0.0488 | 0.0441 | 0.1604 | allowed |
| Lichess | bullet | 1300-1399 | 1070 | 0.7153 | 0.7280 | -0.0127 | 0.0195 | 0.0379 | 0.1557 | allowed |
| Lichess | bullet | 1400-1499 | 1288 | 0.7266 | 0.7376 | -0.0110 | 0.0449 | 0.0340 | 0.1548 | allowed |
| Lichess | bullet | 1500-1599 | 1539 | 0.7229 | 0.7316 | -0.0088 | 0.0221 | 0.0312 | 0.1532 | allowed |
| Lichess | bullet | 1600-1699 | 1731 | 0.7349 | 0.7377 | -0.0028 | 0.0123 | 0.0287 | 0.1457 | allowed |
| Lichess | bullet | 1700-1799 | 1907 | 0.7346 | 0.7341 | +0.0004 | 0.0072 | 0.0280 | 0.1496 | allowed |
| Lichess | bullet | 1800-1899 | 2059 | 0.7464 | 0.7416 | +0.0048 | 0.0152 | 0.0264 | 0.1505 | allowed |
| Lichess | bullet | 1900-1999 | 1970 | 0.7625 | 0.7706 | -0.0081 | 0.0152 | 0.0263 | 0.1365 | allowed |
| Lichess | bullet | 2000-2099 | 1821 | 0.7689 | 0.7770 | -0.0081 | 0.0216 | 0.0276 | 0.1379 | allowed |
| Lichess | bullet | 2100-2199 | 1578 | 0.7846 | 0.7750 | +0.0095 | 0.0291 | 0.0289 | 0.1446 | allowed |
| Lichess | bullet | 2200-2299 | 1222 | 0.7998 | 0.7750 | +0.0248 | 0.0313 | 0.0320 | 0.1429 | allowed |
| Lichess | bullet | 2300-2399 | 831 | 0.8014 | 0.7774 | +0.0241 | 0.0407 | 0.0393 | 0.1358 | fail |
| Lichess | bullet | 2400-2499 | 573 | 0.8119 | 0.7836 | +0.0283 | 0.0465 | 0.0450 | 0.1385 | fail |
| Lichess | bullet | 2500-2599 | 386 | 0.8330 | 0.8342 | -0.0012 | 0.0407 | 0.0516 | 0.1266 | pass (outside span) |
| Lichess | bullet | 2600-2699 | 227 | 0.8525 | 0.8282 | +0.0244 | 0.0346 | 0.0641 | 0.1208 | pass (outside span) |
| Lichess | bullet | 2700-2799 | 113 | 0.8493 | 0.7345 | +0.1148 | 0.1148 | n/a | 0.1685 | too few |
| Lichess | bullet | 2800-2899 | 64 | 0.8484 | 0.8281 | +0.0203 | 0.0203 | n/a | 0.1224 | too few |
| Lichess | bullet | 2900-2999 | 36 | 0.8719 | 0.8611 | +0.0108 | 0.1508 | n/a | 0.1235 | too few |
| Lichess | bullet | 3000-3099 | 14 | 0.9163 | 1.0000 | -0.0837 | 0.0837 | n/a | 0.0164 | too few |
| Lichess | bullet | 3100-3199 | 7 | 0.9282 | 1.0000 | -0.0718 | 0.0718 | n/a | 0.0129 | too few |
| Lichess | bullet | 3300-3399 | 1 | 0.9984 | 1.0000 | -0.0016 | 0.0016 | n/a | 0.0000 | too few |
| Lichess | classical | 500-599 | 1 | 0.8115 | 1.0000 | -0.1885 | 0.1885 | n/a | 0.0355 | too few |
| Lichess | classical | 600-699 | 19 | 0.6402 | 0.4737 | +0.1665 | 0.2125 | n/a | 0.2268 | too few |
| Lichess | classical | 700-799 | 59 | 0.6497 | 0.5424 | +0.1073 | 0.1766 | n/a | 0.1947 | too few |
| Lichess | classical | 800-899 | 157 | 0.6515 | 0.5732 | +0.0782 | 0.0942 | n/a | 0.2171 | too few |
| Lichess | classical | 900-999 | 287 | 0.6740 | 0.6132 | +0.0608 | 0.0753 | 0.0763 | 0.1849 | pass (outside span) |
| Lichess | classical | 1000-1099 | 583 | 0.6801 | 0.6226 | +0.0575 | 0.0702 | 0.0549 | 0.1955 | fail |
| Lichess | classical | 1100-1199 | 775 | 0.6909 | 0.6594 | +0.0315 | 0.0352 | 0.0479 | 0.1846 | allowed |
| Lichess | classical | 1200-1299 | 1234 | 0.7176 | 0.7083 | +0.0094 | 0.0209 | 0.0360 | 0.1743 | allowed |
| Lichess | classical | 1300-1399 | 1586 | 0.7373 | 0.7383 | -0.0010 | 0.0294 | 0.0309 | 0.1635 | allowed |
| Lichess | classical | 1400-1499 | 1957 | 0.7630 | 0.7629 | +0.0001 | 0.0074 | 0.0274 | 0.1447 | allowed |
| Lichess | classical | 1500-1599 | 3050 | 0.7757 | 0.7685 | +0.0072 | 0.0235 | 0.0210 | 0.1524 | allowed |
| Lichess | classical | 1600-1699 | 2618 | 0.7986 | 0.8189 | -0.0204 | 0.0207 | 0.0222 | 0.1245 | allowed |
| Lichess | classical | 1700-1799 | 2728 | 0.8100 | 0.8394 | -0.0294 | 0.0294 | 0.0213 | 0.1162 | fail |
| Lichess | classical | 1800-1899 | 1898 | 0.8241 | 0.8609 | -0.0368 | 0.0368 | 0.0240 | 0.1057 | fail |
| Lichess | classical | 1900-1999 | 1378 | 0.8429 | 0.8839 | -0.0410 | 0.0455 | 0.0267 | 0.0900 | fail |
| Lichess | classical | 2000-2099 | 710 | 0.8596 | 0.9183 | -0.0587 | 0.0587 | 0.0357 | 0.0767 | fail |
| Lichess | classical | 2100-2199 | 282 | 0.8827 | 0.9326 | -0.0500 | 0.0673 | 0.0520 | 0.0576 | fail |
| Lichess | classical | 2200-2299 | 155 | 0.8831 | 0.9613 | -0.0781 | 0.0781 | n/a | 0.0486 | too few |
| Lichess | classical | 2300-2399 | 40 | 0.8887 | 0.9500 | -0.0613 | 0.0903 | n/a | 0.0360 | too few |
| Lichess | classical | 2400-2499 | 36 | 0.9036 | 1.0000 | -0.0964 | 0.0964 | n/a | 0.0211 | too few |
| Lichess | classical | 2500-2599 | 6 | 0.8912 | 1.0000 | -0.1088 | 0.1088 | n/a | 0.0239 | too few |
| Lichess | ultraBullet | 500-599 | 1 | 0.5310 | 0.0000 | +0.5310 | 0.5310 | n/a | 0.2819 | too few |
| Lichess | ultraBullet | 600-699 | 2 | 0.3643 | 0.5000 | -0.1357 | 0.1357 | n/a | 0.2652 | too few |
| Lichess | ultraBullet | 700-799 | 14 | 0.4768 | 0.3571 | +0.1196 | 0.2797 | n/a | 0.2945 | too few |
| Lichess | ultraBullet | 800-899 | 43 | 0.4848 | 0.5349 | -0.0501 | 0.0799 | n/a | 0.2119 | too few |
| Lichess | ultraBullet | 900-999 | 96 | 0.4958 | 0.4688 | +0.0271 | 0.1228 | n/a | 0.1957 | too few |
| Lichess | ultraBullet | 1000-1099 | 234 | 0.5088 | 0.4573 | +0.0515 | 0.0762 | 0.0913 | 0.2149 | allowed |
| Lichess | ultraBullet | 1100-1199 | 419 | 0.5195 | 0.4654 | +0.0541 | 0.0614 | 0.0660 | 0.2149 | allowed |
| Lichess | ultraBullet | 1200-1299 | 725 | 0.5072 | 0.5172 | -0.0101 | 0.0374 | 0.0513 | 0.2212 | allowed |
| Lichess | ultraBullet | 1300-1399 | 816 | 0.5402 | 0.5049 | +0.0353 | 0.0413 | 0.0492 | 0.2129 | allowed |
| Lichess | ultraBullet | 1400-1499 | 1068 | 0.5426 | 0.5150 | +0.0276 | 0.0422 | 0.0438 | 0.2143 | allowed |
| Lichess | ultraBullet | 1500-1599 | 1731 | 0.5551 | 0.5667 | -0.0116 | 0.0551 | 0.0334 | 0.2022 | allowed |
| Lichess | ultraBullet | 1600-1699 | 2510 | 0.5632 | 0.5785 | -0.0153 | 0.0283 | 0.0281 | 0.2060 | allowed |
| Lichess | ultraBullet | 1700-1799 | 2809 | 0.5771 | 0.5924 | -0.0153 | 0.0415 | 0.0263 | 0.2080 | allowed |
| Lichess | ultraBullet | 1800-1899 | 2936 | 0.5879 | 0.6172 | -0.0292 | 0.0492 | 0.0265 | 0.2020 | fail |
| Lichess | ultraBullet | 1900-1999 | 2874 | 0.5985 | 0.6322 | -0.0337 | 0.0351 | 0.0260 | 0.2008 | fail |
| Lichess | ultraBullet | 2000-2099 | 2266 | 0.6249 | 0.6222 | +0.0027 | 0.0196 | 0.0289 | 0.1999 | pass (outside span) |
| Lichess | ultraBullet | 2100-2199 | 1538 | 0.6315 | 0.6099 | +0.0216 | 0.0216 | 0.0350 | 0.2037 | pass (outside span) |
| Lichess | ultraBullet | 2200-2299 | 1089 | 0.6603 | 0.6474 | +0.0130 | 0.0329 | 0.0414 | 0.1927 | pass (outside span) |
| Lichess | ultraBullet | 2300-2399 | 521 | 0.6695 | 0.6967 | -0.0272 | 0.0303 | 0.0598 | 0.1869 | pass (outside span) |
| Lichess | ultraBullet | 2400-2499 | 494 | 0.6859 | 0.6822 | +0.0037 | 0.0576 | 0.0593 | 0.1788 | pass (outside span) |
| Lichess | ultraBullet | 2500-2599 | 159 | 0.7008 | 0.6226 | +0.0781 | 0.0856 | n/a | 0.1971 | too few |
| Lichess | ultraBullet | 2600-2699 | 122 | 0.7147 | 0.6885 | +0.0261 | 0.0767 | n/a | 0.1755 | too few |
| Lichess | ultraBullet | 2700-2799 | 27 | 0.7387 | 0.6296 | +0.1091 | 0.1467 | n/a | 0.2226 | too few |

**Held-out check on Chess.com rapid and bullet.** Because `data/engine/v1` has only Chess.com blitz, I sampled held-out test players (`hash(player.casefold()) % 5 == 0`) from the v1 username pool, probed `/stats` for 1,200 players across 600 to 2400, and fetched public monthly archives for 455 stratified players (`scripts/fetch_chesscom_rapid.py`, at most 2 concurrent requests, zero 429 responses). That yielded 9,888 finished rated standard games with `[%clk]` comments and verified pre-game ratings (4,443 rapid and 5,445 bullet) and 343,924 moves (`ply >= 2`, 8.1 MB).

I labeled all 343,924 moves on Ashton's M5 Pro Mac (18 cores) using `scripts/label_chesscom_rapid.py` with the exact v1 Stockfish 19 settings (depth 10, MultiPV 2, WDL on, 32 MB hash, 1 thread per worker, hash cleared per search, 17 workers). A 5,000-move benchmark ran at 420.31 searches per second (11.90 s) and projected 1,034.7 s for the full 42-shard run; labeling finished in 950.04 engine seconds (15.8 minutes) and produced 20,069 critical held-out positions (`gap >= 20`): 9,693 rapid (3,437 games, 198 players, median clock fraction 0.7900) and 10,376 bullet (4,204 games, 208 players, median clock fraction 0.6050). The full directory under `data/engine/chesscom-rapid-v1/` is 40.1 MB.

Rerunning `scripts/calibrate_review_find_rate.py` on all 284,487 held-out positions left all six existing site and speed ranges unchanged. On the two new pairs, the shipped model passes the noise-floor rule only in narrow upper-middle windows:

- **Chess.com rapid:** passes `1800-2099` (1,884 positions, 0.8640 predicted vs 0.8593 actual, Brier 0.0964). It fails broadly across `700-1799` (11 straight bands, under-predicting by 5.6 to 13.3 points) and across `2100-2399` (over-predicting by 2.4 to 7.6 points).
- **Chess.com bullet:** passes `1700-2099` (2,631 positions, 0.7919 predicted vs 0.7868 actual, Brier 0.1362). It fails across `600-1299` (6 of 7 bands, over-predicting by 2.0 to 12.2 points), at `1600-1699` (+7.0 points), and across `2100-2399` (+5.1 to +14.6 points).

Because the shipped model standardized Chess.com ratings on blitz (mean around 1647, narrow spread) and never trained on Chess.com rapid or bullet, its rating slope is too steep for rapid and bullet outside those windows. I widened `REVIEW_RATE_RANGES` to add Chess.com rapid `1800-2099` and bullet `1700-2099` and left lower ratings hidden; covering wider Chess.com rapid and bullet bands requires retraining on those speeds in a separate pass.

| Site | Speed | Rating band | n | Predicted | Actual | Bias | 10-bin ECE | Noise p95 | Brier | Status |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| Chess.com | rapid | 500-599 | 46 | 0.6672 | 0.6957 | -0.0284 | 0.1373 | n/a | 0.1471 | too few |
| Chess.com | rapid | 600-699 | 267 | 0.6836 | 0.6854 | -0.0018 | 0.0430 | 0.0804 | 0.1734 | pass (outside span) |
| Chess.com | rapid | 700-799 | 672 | 0.6461 | 0.7083 | -0.0622 | 0.0622 | 0.0523 | 0.1709 | fail |
| Chess.com | rapid | 800-899 | 437 | 0.6603 | 0.7666 | -0.1063 | 0.1063 | 0.0636 | 0.1648 | fail |
| Chess.com | rapid | 900-999 | 448 | 0.6880 | 0.7545 | -0.0665 | 0.0852 | 0.0605 | 0.1507 | fail |
| Chess.com | rapid | 1000-1099 | 740 | 0.6531 | 0.7432 | -0.0902 | 0.0902 | 0.0481 | 0.1616 | fail |
| Chess.com | rapid | 1100-1199 | 395 | 0.6808 | 0.7595 | -0.0787 | 0.0834 | 0.0630 | 0.1520 | fail |
| Chess.com | rapid | 1200-1299 | 484 | 0.6868 | 0.7748 | -0.0880 | 0.0880 | 0.0583 | 0.1615 | fail |
| Chess.com | rapid | 1300-1399 | 743 | 0.6735 | 0.7847 | -0.1112 | 0.1112 | 0.0485 | 0.1463 | fail |
| Chess.com | rapid | 1400-1499 | 469 | 0.7184 | 0.8017 | -0.0833 | 0.0833 | 0.0565 | 0.1376 | fail |
| Chess.com | rapid | 1500-1599 | 475 | 0.7303 | 0.8632 | -0.1328 | 0.1328 | 0.0564 | 0.1237 | fail |
| Chess.com | rapid | 1600-1699 | 320 | 0.7495 | 0.8594 | -0.1099 | 0.1099 | 0.0680 | 0.1063 | fail |
| Chess.com | rapid | 1700-1799 | 399 | 0.7808 | 0.8371 | -0.0563 | 0.0653 | 0.0577 | 0.1317 | fail |
| Chess.com | rapid | 1800-1899 | 703 | 0.8261 | 0.8250 | +0.0010 | 0.0201 | 0.0399 | 0.1164 | allowed |
| Chess.com | rapid | 1900-1999 | 606 | 0.8668 | 0.8729 | -0.0062 | 0.0334 | 0.0380 | 0.0847 | allowed |
| Chess.com | rapid | 2000-2099 | 575 | 0.9076 | 0.8870 | +0.0206 | 0.0206 | 0.0318 | 0.0841 | allowed |
| Chess.com | rapid | 2100-2199 | 555 | 0.9190 | 0.8865 | +0.0326 | 0.0329 | 0.0294 | 0.0881 | fail |
| Chess.com | rapid | 2200-2299 | 829 | 0.9444 | 0.9204 | +0.0241 | 0.0250 | 0.0202 | 0.0680 | fail |
| Chess.com | rapid | 2300-2399 | 452 | 0.9609 | 0.8850 | +0.0760 | 0.0775 | 0.0217 | 0.1015 | fail |
| Chess.com | rapid | 2400-2499 | 78 | 0.9615 | 0.9231 | +0.0384 | 0.0650 | n/a | 0.0724 | too few |
| Chess.com | bullet | 500-599 | 2 | 0.6292 | 0.5000 | +0.1292 | 0.3828 | n/a | 0.1632 | too few |
| Chess.com | bullet | 600-699 | 378 | 0.8149 | 0.6931 | +0.1218 | 0.1218 | 0.0545 | 0.1921 | fail |
| Chess.com | bullet | 700-799 | 576 | 0.7948 | 0.7292 | +0.0656 | 0.0837 | 0.0471 | 0.1607 | fail |
| Chess.com | bullet | 800-899 | 692 | 0.7915 | 0.6922 | +0.0993 | 0.0993 | 0.0433 | 0.1846 | fail |
| Chess.com | bullet | 900-999 | 479 | 0.7674 | 0.6722 | +0.0951 | 0.0951 | 0.0547 | 0.1828 | fail |
| Chess.com | bullet | 1000-1099 | 582 | 0.7730 | 0.7526 | +0.0204 | 0.0378 | 0.0487 | 0.1499 | pass (outside span) |
| Chess.com | bullet | 1100-1199 | 458 | 0.7594 | 0.6747 | +0.0847 | 0.0847 | 0.0556 | 0.1846 | fail |
| Chess.com | bullet | 1200-1299 | 515 | 0.7576 | 0.7204 | +0.0372 | 0.0661 | 0.0542 | 0.1674 | fail |
| Chess.com | bullet | 1300-1399 | 674 | 0.7668 | 0.7552 | +0.0116 | 0.0307 | 0.0448 | 0.1368 | pass (outside span) |
| Chess.com | bullet | 1400-1499 | 440 | 0.7494 | 0.7500 | -0.0006 | 0.0425 | 0.0571 | 0.1382 | pass (outside span) |
| Chess.com | bullet | 1500-1599 | 746 | 0.7574 | 0.7708 | -0.0134 | 0.0388 | 0.0428 | 0.1383 | pass (outside span) |
| Chess.com | bullet | 1600-1699 | 446 | 0.7562 | 0.6861 | +0.0701 | 0.0701 | 0.0577 | 0.1609 | fail |
| Chess.com | bullet | 1700-1799 | 740 | 0.7512 | 0.7622 | -0.0109 | 0.0419 | 0.0432 | 0.1510 | allowed |
| Chess.com | bullet | 1800-1899 | 731 | 0.7955 | 0.8071 | -0.0116 | 0.0231 | 0.0410 | 0.1199 | allowed |
| Chess.com | bullet | 1900-1999 | 572 | 0.8010 | 0.7850 | +0.0161 | 0.0388 | 0.0454 | 0.1409 | allowed |
| Chess.com | bullet | 2000-2099 | 588 | 0.8299 | 0.7942 | +0.0357 | 0.0397 | 0.0423 | 0.1332 | allowed |
| Chess.com | bullet | 2100-2199 | 755 | 0.8654 | 0.8146 | +0.0508 | 0.0537 | 0.0332 | 0.1295 | fail |
| Chess.com | bullet | 2200-2299 | 590 | 0.8996 | 0.7932 | +0.1064 | 0.1083 | 0.0330 | 0.1436 | fail |
| Chess.com | bullet | 2300-2399 | 379 | 0.9162 | 0.7704 | +0.1457 | 0.1457 | 0.0366 | 0.1710 | fail |
| Chess.com | bullet | 2400-2499 | 33 | 0.9487 | 0.8788 | +0.0699 | 0.0699 | n/a | 0.0902 | too few |

```sh
python scripts/fetch_chesscom_rapid.py --v1-root data/engine/v1 --output data/engine/chesscom-rapid-v1 stats
python scripts/fetch_chesscom_rapid.py --v1-root data/engine/v1 --output data/engine/chesscom-rapid-v1 games
python scripts/label_chesscom_rapid.py label --v1-root data/engine/v1 --output data/engine/chesscom-rapid-v1 --max-per-band 20000
python scripts/calibrate_review_find_rate.py --data-root data/engine --output eval_results/review-calibration
```

**Chess.com rapid and bullet training data.** To train the neural model on Chess.com rapid and bullet without touching any held-out test player, I extended `scripts/fetch_chesscom_rapid.py` (`--split non-test`) and `scripts/label_chesscom_rapid.py` to draw non-test usernames (`hash(player.casefold()) % 5 != 0`) from `data/engine/v1`. Validation uses the same second base-5 digit (`(hash // 5) % 5 == 0`) as `scripts/prepare_neural_find_rate.py`.

I probed `/stats` for 2,000 non-test players (2,001 requests, 967.0 s, zero 429 responses, at most 2 concurrent requests) and fetched public monthly archives for 1,006 stratified players across 600 to 2399 (6,568 requests, 2,491.0 s, zero 429 responses). That yielded 71,957 finished rated standard games with `[%clk]` comments and verified pre-game ratings (31,760 rapid and 40,197 bullet) and 2,462,737 moves (`ply >= 2`).

I labeled 1,645,707 stratified moves (`--max-per-band 45000`) on Ashton's M5 Pro Mac (18 cores) using Stockfish 19 with the exact v1 settings (depth 10, MultiPV 2, WDL on, 32 MB hash, 1 thread per worker, hash cleared per search, 17 workers). The 5,000-move benchmark ran at 426.81 searches per second (11.715 s) and projected 4,831.5 s across 201 atomic shards against the 28,800 s budget. Labeling finished in 4,301.6 engine seconds (71.7 minutes) and produced 95,683 critical positions (`gap >= 20`, 46,771 games, zero test players):

- **Chess.com rapid:** 48,439 critical positions (38,072 train across 392 players; 10,367 validation across 118 players).
- **Chess.com bullet:** 47,244 critical positions (38,159 train across 429 players; 9,085 validation across 108 players).

The full directory under `data/engine/chesscom-rapid-train-v1/` is 207.7 MB (217,790,170 bytes), with all request batches, counts, and engine settings recorded in `data/engine/chesscom-rapid-train-v1/runs.json`.

```sh
python scripts/fetch_chesscom_rapid.py --v1-root data/engine/v1 --output data/engine/chesscom-rapid-train-v1 --split non-test stats --max-players 2000
python scripts/fetch_chesscom_rapid.py --v1-root data/engine/v1 --output data/engine/chesscom-rapid-train-v1 --split non-test games --per-band 45
python scripts/label_chesscom_rapid.py label --v1-root data/engine/v1 --output data/engine/chesscom-rapid-train-v1 --max-per-band 45000
```

The logistic baseline is reproduced by `scripts/eval_find_rate.py evaluate`. `web/test/findRate.test.ts`
checks its chess.js features and probabilities against Python on 300 held-out positions. The
features match exactly and the probabilities agree within 0.0001.

## Lichess dataset

I used the October 2026 rated standard archive (30.98 GB compressed) and the Lichess
evaluation archive with 417,862,375 records (22.50 GB compressed). The local download manifest
records their exact byte sizes, URLs and SHA-256 checksums. I checked both hashes against Lichess's
published sums. [Lichess open database](https://database.lichess.org/)

I streamed the evaluation archive once on an Apple M5 Pro Mac with 6 super cores, 12 performance
cores and 48 GB of memory. I kept the deepest search at depth 10 or higher with two distinct legal
moves and a scored line for each. I normalized castling and kept an en passant square when a legal
capture exists. I grouped by the four FEN fields that identify the board position and resolved
duplicates in hash buckets on disk. The result was 193,996,647 keyed rows in 5.46 GB of Parquet.
Conversion and deduplication took 423.4 seconds, excluding download time.

The Rust ingest writes a game row for every PGN record and stores exclusions on that row. It writes
board rows only for eligible games whose XXH3 game-ID hash falls in the chosen bucket. Each such
game has a row for the board before each move and an extra row for the final board. I drew 100 games
from each of 10 chronological strata, covering all 31 UTC dates in October. All 64,970 board FENs,
including the final boards, matched python-chess. Both ingest benchmarks scan the entire archive.

I calibrated the storage projection on the first 65,536 records and added a 25% margin. With
66.01 GB already under `data/` and 40 GB set aside for later work, I used bucket zero modulo 20.
The runner projected 6.28 GB of game rows and 6.45 GB of board rows before it opened any output
shards. The measured sizes were 3.93 GB and 5.12 GB. The scan kept all 95,395,628 games and wrote
board rows for 4,704,665 of them. The measured board count includes 311,189,971 played moves.

In that scan, 494,406 game rows were marked as bot games, 37,811 as clockless, 99,185 as non-clocked
and 689,520 as unfinished. These are exclusive reasons. Illegal moves are checked during replay,
so that check covers the position bucket. Clock comments have whole-second resolution. I use
Lichess's own speed classes and keep its ratings on the Lichess scale.

I timed one scan per bucket on the same Mac and used local archives. The wall times cover the
Rust scan and Parquet writes. Peak memory is the Rust process's peak resident size.

| Position bucket | Wall time | Games scanned per second | Eligible games per second | Board rows per second | Board rows stored | Peak memory | Parquet |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 in 20 | 714.3 s | 133,552 | 131,703 | 442,247 | 315,894,636 | 1.02 GB | 9.05 GB |
| 1 in 100 | 497.8 s | 191,654 | 189,000 | 127,169 | 63,298,254 | 0.16 GB | 5.01 GB |

I joined played moves from the 1-in-20 bucket to the cached evaluations. I put scores on the mover's
side, used the engine dataset's win-chance curve and kept the same 20-point gap for a critical move.
The first full training query exhausted the DuckDB spill allowance. I matched the critical boards
before attaching game metadata and capped DuckDB spill and the final Parquet file independently.
The successful coverage and training run took 116.5 seconds. All files under `data/` took 80.12 GB
afterward, including the archives, the comparison run and the existing data.

| Phase | Played moves | Matched | Coverage | Critical rows from the join |
|---|---:|---:|---:|---:|
| Opening | 110,606,914 | 63,342,026 | 57.27% | 807,717 |
| Middlegame | 123,188,232 | 306,833 | 0.25% | 14,158 |
| Endgame | 77,394,825 | 1,442,800 | 1.86% | 108,285 |
| All | 311,189,971 | 65,091,659 | 20.92% | 930,160 |

Coverage dropped from 100% at ply 0 to 58.64% at ply 12, 2.12% at ply 24 and 0.0021% at ply 48.
The opening accounted for 86.84% of the critical rows. The cloud comparison table contains 930,160 moves
from 434,768 Lichess players and takes 48.72 MB. The run report includes every ply, speed and
200-point rating band. Bands from 800 through 2399 reached the 20,000-row target. The outer bands
and the two least represented speeds fell short.

| Lichess speed | Cloud rows | Distinct players |
|---|---:|---:|
| UltraBullet | 7,098 | 3,326 |
| Bullet | 288,473 | 126,928 |
| Blitz | 442,141 | 220,511 |
| Rapid | 185,950 | 109,401 |
| Classical | 6,498 | 4,372 |

I timed Stockfish 19 at depth 10 with two lines, 32 MB of hash and one thread per worker. I took
200 moves per speed from games chosen independently of the cloud join. The 1,000 searches took
2.60 seconds with 17 workers, including engine startup. Stockfish found 57 critical positions in
this balanced sample. One had a qualifying cloud evaluation. The cloud labels had an 87.88% find
rate. The v1 Chess.com blitz set had a 79.3% find rate. I use local Stockfish for Lichess training.

### Local Stockfish labels

I sampled uniformly without replacement within each of the five speeds from the 311,189,971 played
moves in the 1-in-20 bucket. The sample ranks a hash of the game ID and ply, with separate seeds
for timing and production. I used the v1 Stockfish 19 binary and find-rate settings, depth 10,
two lines, WDL enabled, 32 MB hash and one thread per worker. Each search starts from the sampled
FEN and clears the hash. The depth-14 recheck in v1 was for a separate blunder metric.

On the same M5 Pro Mac I timed one run of 50,000 searches with 17 workers, 10,000 per speed. The
search phase took 117.76 seconds after startup, or 424.6 searches per second in aggregate. I used
the lower 95% Wilson bound on each speed's critical-row yield when setting the target. I stopped
the initial 20,000-per-speed run and raised the target to 100,000. The revised plan calls for
9,493,961 searches, including every eligible Classical move. Before restarting, the runner
projected 7 hours 59 minutes 28 seconds, including the benchmark, the charged time from the
stopped run and a 25% margin on the new estimate. Classical's sample size is limited by the
number of played moves in its bucket.

| Speed | Planned searches |
|---|---:|
| UltraBullet | 1,893,361 |
| Bullet | 1,946,543 |
| Blitz | 1,893,361 |
| Rapid | 1,939,282 |
| Classical | 1,821,414 |

I freeze the move sample and publish each completed score shard by atomic rename. The run
manifest records the sample hash, engine settings and elapsed engine time. A resume skips published
shards and charges the reserved time for an interrupted shard. The main table is
`data/engine/lichess-v1/training.parquet`, filtered to rated moves from ply 2 onward with a
20-point win-chance gap. The report puts the cloud and local row counts and find rates side by
side by phase, speed and rating band in `data/engine/lichess-v1/comparison.md`. The full grouped
results are in `data/engine/lichess-v1/comparison.json`.

The production run completed all 9,493,961 searches in 1,159 shards on the same Mac. The run
charged 7 hours 5 minutes 47 seconds of engine time, including the benchmark, the superseded
run and the reservations for two interrupted shards. The training Parquet is 65.59 MB, and
`data/` used 81.65 GB when the comparison finished. All five speeds passed the 100,000-row target.
Opening moves account for 26.84% of the Stockfish set and 86.84% of the cloud set.

| Group | Stockfish rows | Stockfish find rate | Cloud rows | Cloud find rate |
|---|---:|---:|---:|---:|
| All | 532,086 | 73.95% | 930,160 | 87.88% |
| endgame | 118,066 | 75.35% | 108,285 | 82.17% |
| middlegame | 271,203 | 73.23% | 14,158 | 89.81% |
| opening | 142,817 | 74.15% | 807,717 | 88.61% |
| blitz | 107,102 | 78.81% | 442,141 | 89.05% |
| bullet | 105,200 | 75.26% | 288,473 | 87.45% |
| classical | 100,114 | 79.41% | 6,498 | 88.10% |
| rapid | 111,012 | 77.79% | 185,950 | 86.81% |
| ultraBullet | 108,658 | 58.93% | 7,098 | 59.93% |
| Rating 400-599 | 767 | 49.28% | 1,806 | 64.12% |
| Rating 600-799 | 4,569 | 59.20% | 11,494 | 74.56% |
| Rating 800-999 | 16,620 | 65.18% | 41,113 | 79.71% |
| Rating 1000-1199 | 37,386 | 68.57% | 87,814 | 83.17% |
| Rating 1200-1399 | 65,644 | 71.73% | 130,316 | 85.77% |
| Rating 1400-1599 | 98,824 | 73.56% | 165,234 | 87.38% |
| Rating 1600-1799 | 115,314 | 75.01% | 174,838 | 89.02% |
| Rating 1800-1999 | 99,283 | 75.88% | 151,385 | 90.36% |
| Rating 2000-2199 | 57,875 | 76.52% | 95,401 | 91.80% |
| Rating 2200-2399 | 24,134 | 77.63% | 46,286 | 92.69% |
| Rating 2400-2599 | 8,526 | 79.01% | 17,263 | 93.09% |
| Rating 2600-2799 | 2,463 | 80.39% | 5,492 | 93.17% |
| Rating 2800-2999 | 573 | 82.37% | 1,413 | 93.70% |
| Rating 3000-3199 | 92 | 90.22% | 274 | 92.34% |
| Rating 3200-3399 | 16 | 75.00% | 30 | 96.67% |
| Rating 3400-3599 | 0 | n/a | 1 | 100.00% |

```sh
cargo build --locked --release --manifest-path tools/lichess-ingest/Cargo.toml
python scripts/lichess_data.py fetch games evals
python scripts/lichess_data.py convert-evals
python scripts/lichess_data.py ingest
python scripts/lichess_data.py ingest --one-percent
python scripts/label_lichess.py
python scripts/audit_lichess_labels.py
python scripts/stockfish_lichess.py benchmark
python scripts/stockfish_lichess.py label
python scripts/stockfish_lichess.py compare
python scripts/check_lichess_replay.py data/lichess/downloads/lichess_db_standard_rated_2026-10.pgn.zst data/lichess/2026-10
```

## Native chess move generation

I represent a standard chess position with one bitboard per color and piece type. Sliding pieces
use magic bitboards. A fixed-seed search found one magic number per square for rooks and bishops in
0.14 seconds, and the source stores only those 128 numbers. The 107,648 attack entries, about 860 KB,
are built on first use, so they add nothing to the WebAssembly file. A test compares every lookup
with ray walking on all 107,648 relevant occupancies.

The generator works out legal moves directly. It finds the pieces giving check and the pinned pieces
first. In double check only the king moves. In single check the other pieces must capture the checker
or block its line, and a pinned piece moves only along the ray from its king. King moves are tested
with the king removed from the board, so a slider's attack continues past it. En passant is the one
case played on a copy and tested, because removing two pawns from one rank can expose the king along
it. The earlier copy-and-test generator stays in the unit tests as a reference. Both gave the same
moves at every position of 2,048 random games and on hand-picked positions for each of these rules.

Make and unmake save and restore the whole position, which is about 100 bytes. A FEN names the en
passant square only when a legal capture exists, as chess.js and the Lichess pipeline do, while the
position keeps the target internally.

I ran `bash scripts/check_engine_core.sh` on one thread on my M5 Pro Mac with 6 super cores and
12 performance cores. All six published perft positions and the mirror of position 4 matched
through depth 5. At depth 5, the initial position counted 4,865,609 nodes and Kiwipete counted
193,690,690. [Published perft results](https://www.chessprogramming.org/Perft_Results)

In one fixed-seed run I played 4,096 random games, half from the initial position and half from the
other perft positions, with a 256-ply limit. I compared sorted UCI lists and FENs with shakmaty at
each of the 943,932 positions, including each game's final position. All 23,593,115 legal moves
matched, and undo restored the previous position after each of the 939,836 played moves. These tests
cover native correctness. The FEN comparison uses shakmaty's legal en passant mode.

I also added SAN formatting to `engine-core` (`Position::san`) and checked parity against chess.js
1.4.0 on 10,000 distinct positions from the real-game and puzzle fixtures under `web/test/fixtures/`
(`scripts/make_chess_js_parity_fixture.mjs`, stored as a 4.76 MB JSON fixture using per-square board
diffs to stay under 5 MB). In one run of `bash scripts/check_engine_core.sh` on the same Mac, all
296,853 legal moves matched chess.js in sorted UCI order, SAN text and resulting FEN after each
move, and unmake restored each starting position.

I added the 16 find-rate move features (`Position::move_features`) and the 21-plane board encoding
(`Position::encode_board` and `Position::encode_board_planes`) to `engine-core`, and checked exact
parity against Python (`move_features` in `scripts/eval_find_rate.py` and `encode_board` in
`chesscheck/neural_find_rate.py`) on 10,000 positions (`scripts/make_engine_feature_fixture.py`,
stored as a 3.19 MB JSON fixture with base64-packed bitboards). Because the checked-in Parquet
shards under `tests/fixtures/engine-v1/positions/` hold 3,169 distinct position and best-move pairs,
the fixture includes all 3,169 of them plus 7 synthetic edge cases and 6,824 positions from
`web/test/fixtures/`. In one run of `bash scripts/check_engine_core.sh` on the same Mac, all
160,000 move-feature values and all 13,440,000 board bits matched Python exactly, including Black
rank reflection, attacks by pinned pieces, castling planes and the legal-only en passant plane.

I timed perft on one thread of the same Mac with no other work running, using a release build. At
the last ply it counts the legal move list instead of playing each move. Each figure is the median
of five runs; the slowest of the five was at most 3.2% slower than the fastest.

| Generator | Initial position, depth 6 | Kiwipete, depth 5 |
|---|---:|---:|
| Ray walking, play each move on a copy and test it | 1.304 s (91 million nodes/s) | 1.979 s (98 million nodes/s) |
| Magic bitboards, check and pin masks | 0.349 s (341 million nodes/s) | 0.428 s (452 million nodes/s) |

Both counted 119,060,324 and 193,690,690 nodes, the published values. The change made perft 3.7
times faster from the initial position and 4.6 times faster on Kiwipete, where more pieces and pins
make copying and testing every move more expensive.

I also compared saving the whole 112-byte position with undoing a move piece by piece using an
8-byte undo record (`engine-core/examples/bench_unmake.rs`, five single-threaded release runs each
on the same Mac). From the initial position at depth 6, piece-by-piece unmake was 3.4% faster at
the median: 0.340 s (0.339 to 0.341 s, 350 million nodes/s) against 0.352 s (0.347 to 0.356 s,
338 million nodes/s) for copying the position. On Kiwipete at depth 5, where captures, castling,
promotions and en passant are frequent, piece-by-piece unmake was 1.9% slower: 0.443 s (0.440 to
0.443 s, 438 million nodes/s) against 0.434 s (0.433 to 0.446 s, 446 million nodes/s). Because
the difference is small and reverses on tactical positions, `make_move` and `unmake_move` keep the
simpler whole-position copy.

### Offscreen build profile

I ran the development harness (`extension/dev.html`) in headless Chrome 157.0.8103.79 on the
same M5 Pro Mac with 6 super cores and 12 performance cores. I replayed the public November
2026 archive for my account from localhost. I took the last 150 finished bullet games before
the November 13 recap game, took the newest 50 of those for
the shorter build, and read one extra game for the oldest pregame rating in each build. The
two histories contain 4,712 and 12,692 plies. I ran each size three times with a fresh Chrome
profile each time and the default limit of eight Stockfish workers. The recorder checked for
training, tests and builds before each run and polled during it. I used the unthrottled CPU.
[Finished recap game](https://www.chess.com/game/live/187138001290)

I measured from starting the build through the IndexedDB save. The harness loads only the
offscreen bundle in profiling mode, so visible cube activity stays outside its Main track.
I opened a recording of each size in Chrome's Performance panel and inspected Bottom-up
between the build markers on that track. I used the traces' V8 samples for the caller totals.
For each sample I followed the stack to the outer chess.js call, mapped the caller to the
source, and counted only the sample's overlap with a main-thread task. I merged nested task
intervals before computing the busy-thread denominator. The wall-time denominator covers the
whole build, including Stockfish and IndexedDB waits.

The per-position move features run during the engine pass. I timed the tactics request on the
main thread and the summarizer on its worker. After the build I assembled one recap from the
same finished-game fixture using the extension's recap path. I then timed the shared find-rate
feature extractor on the recap's turning position as a separate call. Phase B's neural
predictor belongs to the review queue. Its standalone Chrome timing was 1.90 ms per position,
including input encoding.

The stage times are medians in milliseconds, with the minimum and maximum in parentheses.
The engine feature and worker rows overlap their enclosing stages.

| Stage | 50 games | 150 games |
|---|---:|---:|
| Profile build | 4,467 (4,443 to 4,612) | 13,542 (13,317 to 14,132) |
| Game parsing | 221 (220 to 226) | 563 (549 to 568) |
| Engine pass | 1,886 (1,854 to 1,908) | 4,827 (4,806 to 4,913) |
| Move features during engine pass | 341 (333 to 344) | 931 (912 to 961) |
| Blunder recheck | 1,998 (1,944 to 2,154) | 7,310 (7,092 to 7,774) |
| Tactics request through response | 339 (309 to 392) | 832 (806 to 840) |
| Tactics worker | 239 (236 to 281) | 692 (668 to 698) |
| Tactics summarizer on worker | 236 (233 to 278) | 684 (661 to 690) |
| Recap assembly, after the build | 0.1 (0.1 to 0.1) | 0.1 (0.1 to 0.1) |
| Find-rate features for one turning position, after the recap | 0.9 (0.9 to 1.0) | 0.9 (0.9 to 0.9) |

The main thread was busy for a median of 2,065 ms on 50 games and 5,498 ms on 150 games.
Chess.js accounted for 54.1% (53.0% to 54.6%) of busy main-thread time on 50 games and
55.2% (55.2% to 56.0%) on 150 games. That was 24.6% (24.4% to 25.3%) of full build wall time
on 50 games and 22.4% (22.4% to 22.8%) on 150 games. The tactics summarizer ran on a separate
worker. Its elapsed time counts toward the build, and the chess.js numerator covers the
main thread. Chrome's Bottom-up view showed `_attacked` and `_moves` among the largest
self-time entries.

Both build sizes cleared the 20% wall-time gate in all three runs. I would cover the call
sites below in 150-game time order. Legal move listing narrowly led SAN conversion at both
sizes. Each entry gives median sampled milliseconds and its share of median busy main-thread
time.

| Call site and binding work | 50 games | 150 games |
|---|---:|---:|
| `engine.ts` `analyseOne` `moves()`, count legal moves and captures for position features | 258 ms (12.5%) | 713 ms (13.0%) |
| `engine.ts` `uciToSan`, format the engine's UCI best moves and refutations as SAN | 253 ms (12.2%) | 711 ms (12.9%) |
| `games.ts` `parseGame`, parse the archive PGN and extract its SAN history | 199 ms (9.6%) | 508 ms (9.2%) |
| `engine.ts` `analyseOne` `history({ verbose: true })`, extract the played move records for replay | 127 ms (6.2%) | 353 ms (6.4%) |
| `engine.ts` `analyseOne` `move()`, advance the board through the played game | 103 ms (5.0%) | 282 ms (5.1%) |
| `engine.ts` `analyseOne` `loadPgn()`, load the game for the engine pass | 84 ms (4.1%) | 222 ms (4.0%) |
| `engine.ts` `evalWhite`, load a scratch FEN for best-move SAN | 36 ms (1.8%) | 92 ms (1.7%) |
| `engine.ts` `analyseOne` `isGameOver()`, check whether the position is terminal | 26 ms (1.3%) | 76 ms (1.4%) |
| `engine.ts` recheck callback, replay the played move and prepare its two search positions | 10 ms (0.5%) | 41 ms (0.7%) |
| `engine.ts` `evalWhite` `fen()`, serialize the board for Stockfish and SAN | 7 ms (0.3%) | 20 ms (0.4%) |

I would return legal-move and capture counts directly and keep a board across plies so PGN
replay, SAN and FEN generation can share it. The recheck is the longest build stage, and
Stockfish searches overlap the main-thread work. I would time the whole build again with
the bindings in place before claiming a speedup. These measurements cover the local cold
bullet histories at normal CPU speed. A live archive fetch, a warm refresh and a throttled
build are separate measurements.

```sh
mkdir -p data/profile-c
curl -fsSL https://api.chess.com/pub/player/ashton-iwnl/games/2026/11 \
  -o data/profile-c/ashton-iwnl-2026-11.json
node scripts/profile_offscreen.mjs data/profile-c/ashton-iwnl-2026-11.json data/profile-c/recordings
node --max-old-space-size=7000 scripts/summarize_offscreen_profile.mjs data/profile-c/recordings
```

The script bundles the harness with the profiling flag and writes compressed Chrome traces and
timer results under `data/`. In Performance, load a trace and select between `cc:build start`
and `cc:build end` on the Main track. The production bundles compile out the timers.

### WebAssembly bindings

I build `engine-core` for `wasm32-unknown-unknown` and package the Web-target wasm-bindgen module
with the extension. The offscreen page loads it on its first archive or engine request. A profile
parses archive PGNs in batches of up to 32 games. The engine pass advances one board through each
SAN history, returns all FENs and position counts together, and keeps the positions in WebAssembly
to format Stockfish's best moves in one call per game. The recheck prepares its next positions in
one batch and groups best moves and refutations together as searches finish. The existing chess.js
path handles unsupported records. The tactics worker, website, and review queue use chess.js.
The module exposes the 16 find-rate move features as a separate batch. In the Node parity
tests, the packaged module matched chess.js on move counts, captures and FEN across 10,000
positions, all 296,853 SAN strings in that fixture, and all 16 move features on a second
10,000-position fixture. The game fixtures also cover promotions and repetition through replay.

The PGN parser is new code, and a parse that fails falls back to chess.js while a wrong parse
would not. So I also check it on 400 finished games from my public archive for August through
November 2026 (`web/test/fixtures/archive_pgns.json`, built by `scripts/make_pgn_parity_fixture.py`).
The fixture keeps every game with an uncommon result, so it covers draws by agreement, repetition,
stalemate, the 50-move rule and insufficient material, and fills the rest across bullet, blitz and
rapid. Every game had the same SAN history, ECO tags and stored game record as chess.js. None of
these live games started from a custom position, so that case stays covered by a hand-written PGN.

To check the engine pass and recheck end to end, I ran both on 60 of those games once with chess.js
and once with WebAssembly, against a stand-in for Stockfish whose answers depend only on the
position and depth. Its scores swing widely, so 1,801 of the 4,562 move rows went through the
recheck. Every move row, including the deep recheck fields, was identical. A deliberate change to
one WebAssembly-only count made this test fail.

For the microbenchmarks I used 512 positions from the feature fixture and 24 PGNs from the profile
archive. I ran three fresh launches each in Node and headless Chrome on the same M5 Pro Mac.
Each operation had one untimed pass and five measured passes per backend per launch. I timed
the batch boundary and result decoding and checked the results against chess.js. I report the
median of the batch time divided by its item count. I initialized the module before timing.

| Operation and unit | Node chess.js | Node WebAssembly | Chrome chess.js | Chrome WebAssembly |
|---|---:|---:|---:|---:|
| Legal and capture counts plus FEN, µs per position | 78.59 | 2.31 | 76.37 | 2.15 |
| UCI to SAN, µs per move | 62.95 | 1.21 | 58.98 | 1.17 |
| Parse archive PGN to SAN history, ms per game | 3.97 | 0.049 | 3.70 | 0.042 |
| Replay SAN with counts and FENs, ms per game | 9.28 | 0.147 | 8.78 | 0.133 |
| Find-rate move features, µs per position | 970.61 | 2.06 | 935.55 | 1.95 |

For the build comparison I used the same finished bullet histories and Chrome recorder before
and after, with fresh browser profiles and the default limit of eight Stockfish workers. I ran
three builds per size at normal speed and three per size at each of 4x and 6x Chrome CPU
throttling. The throttle applies to the harness page. I replayed a local archive snapshot and
verified that the WebAssembly build used the module for every archived game and engine replay.
Every row gives the median and the full range in seconds across three runs.

| Chrome CPU setting | Games | Chess.js wall time | WebAssembly wall time | Reduction |
|---|---:|---:|---:|---:|
| Normal | 50 | 4.363 (4.234 to 4.382) | 3.784 (3.564 to 3.885) | 13.3% |
| Normal | 150 | 12.962 (11.951 to 13.591) | 11.500 (11.360 to 11.647) | 11.3% |
| 4x | 50 | 10.050 (9.878 to 10.283) | 4.211 (4.099 to 4.348) | 58.1% |
| 4x | 150 | 28.556 (28.125 to 28.745) | 12.338 (12.277 to 12.577) | 56.8% |
| 6x | 50 | 14.076 (13.768 to 14.434) | 5.131 (4.790 to 7.045) | 63.6% |
| 6x | 150 | 39.097 (38.759 to 39.613) | 15.941 (14.586 to 17.472) | 59.2% |

The cold builds at normal CPU speed saved about 0.58 seconds and 1.46 seconds. That gain is
modest beside the operation timings because Stockfish still dominates. The engine pass and
recheck, including their bookkeeping, took a median of 90.5% and 92.4% of build wall time
after the change. The throttled runs measure Chrome's emulation on this Mac. The throttle slowed only the harness page, not the Stockfish workers, so it overstates the gain on a slow computer, where the searches slow down too.

The new module is 211,458 bytes uncompressed and 79,031 bytes deflated inside the extension ZIP.
The ZIP grew from 1,476,265 to 1,559,355 bytes, an increase of 83,090 bytes against the 1 MB budget.

I used Chrome 157.0.8103.79 and Node 26.8.2. For the normal-speed baseline I built the extension
and ran the same recorder against the source at `1929a42`, with `PROFILE_WASM_ASSETS` unset. The
three-run 4x and 6x comparisons ran against `a5f5f56` with and without `PROFILE_WASM_ASSETS` set
on the same archive snapshot. The archive selection and its hash are in each recording's
`setup.json`. The commands below assume the archive snapshot from the offscreen profile and a copy
of the baseline ZIP.

```sh
archive=data/profile-c/ashton-iwnl-2026-11.json
results=data/wasm-measurements
mkdir -p "$results"
bash scripts/build_extension.sh
cp dist/chess-check-extension.zip "$results/after.zip"
npm run test:wasm --prefix web
PROFILE_WASM_ASSETS=extension/engine node scripts/profile_offscreen.mjs "$archive" "$results/after-1x"
for rate in 4 6; do
  PROFILE_CPU_RATE="$rate" \
    node scripts/profile_offscreen.mjs "$archive" "$results/before-${rate}x-3runs" 3
  PROFILE_WASM_ASSETS=extension/engine PROFILE_CPU_RATE="$rate" \
    node scripts/profile_offscreen.mjs "$archive" "$results/after-${rate}x-3runs" 3
done
python scripts/benchmark_engine_wasm.py "$archive" "$results/before.zip" "$results/after.zip"
```

## Cross-language parity

The TypeScript port is tested against Python output on real games (`web/test/`, run in CI before every deploy):

- Opening statistics match to 1e-9, with identical verdicts and worst branches.
- scikit-learn's GroupKFold assignment is reproduced exactly, and logistic-regression probabilities match to 1e-8.
- The coach's facts and the game summaries match character for character. This caught a rounding difference: Python rounds halves to even (36.5 becomes 36) while JavaScript rounds them up.
- BM25 matches rank_bm25 to 1e-9, and given the same embedding vectors the hybrid ranking is identical.
- The tactic detector gives the same labels as the Python one on 3,000 Lichess puzzle positions, and the tactic summary, verdicts and coach facts match on real games. This caught a second rounding problem: multiplying 2.675 by 100 gives exactly 267.5 in floating point, so a check for exact halves has to read the number's real decimal digits.

## Neural find-rate inputs

I encode the position before the best move as a float tensor with 21 planes of 8 by 8 squares.
Squares run file a through h, starting at the mover's home rank. Black-to-move positions reflect
the ranks and keep the files in place. The planes are ordered as follows.

- 0 through 11 hold pawns, knights, bishops, rooks, queens and kings for the mover, then the opponent.
- 12 and 13 mark the best move's origin and destination. The encoder accepts legal UCI or SAN.
- 14 and 15 mark squares attacked by the mover and the opponent. These include defended pieces
  and attacks by pinned pieces.
- 16 through 19 give the mover's kingside and queenside castling rights, then the opponent's rights
  in the same order. Each right fills its whole plane.
- 20 marks the en passant target when the mover has a legal en passant capture.

The scalar input holds the rating standardized within its source, six one-hot speed values in the
order UltraBullet, Bullet, Blitz, Rapid, Classical and Daily, the clock fraction clipped to 0 through
1.5, a missing-clock flag, and a Lichess source flag. A missing clock has fraction zero and its flag
set. The export carries each source's rating mean and standard deviation. The model uses two
convolutions with 32 output channels each, flattens the second output, and combines it with the scalar
input in a 32-unit dense layer and a sigmoid output.

The full model also appends the 21 handcrafted move inputs from the logistic model. They include
capture and check flags, attack and movement flags, scaled material, log counts of available moves,
captures and checks, and a one-hot piece type. The browser reuses `moveFeatures` to compute them.

`scripts/export_neural_find_rate.py CHECKPOINT DIRECTORY` expects a checkpoint with `state_dict` and
`ratings` maps. Ratings have `mean` and `std` for each training source. The export writes a float
ONNX model, a packed-weight ONNX model and the same packed parameters for the TypeScript forward
pass. I used the default per-output-channel int8 export in the experiment below. The
`--precision float16` export stores weights and biases as binary16. The predictor decodes them
for float arithmetic.

I check input equality and inference parity with initialized weights. The command below adds 300
critical positions from completed shards to the synthetic cases. With no shard path it checks the
synthetic cases alone, as in CI.

```sh
python scripts/check_neural_find_rate.py --positions data/engine/lichess-v1/positions
```

### Training and evaluation

I kept the existing Chess.com blitz test fold and used the same username hash for Lichess. Hashes
divisible by five went to test. Among the remaining players, a second base-five digit chose
validation. I case-folded usernames across sources and checked that the Chess.com test assignment
still agreed with the existing table. There were 516,340 Chess.com training positions, 129,376
validation positions and 157,583 test positions. The corresponding Lichess counts were 340,264,
84,987 and 106,835. The Lichess rows came from the local Stockfish training table.

I refit the logistic and histogram gradient-boosting move models on Chess.com alone. Their
Chess.com test log losses were 0.44100 and 0.40956. I also fit gradient boosting jointly on the
Chess.com and Lichess training splits, using the same normalized move features and scalar inputs
as the full neural model, including the speed one-hot and source flag. Both boosting models used
the player-grouped validation split for early stopping. Stockfish supplied the labels and best
moves. All fits excluded its numerical evaluations.

I ran seeds 24, 25 and 26 on my M5 Pro Mac with 6 super cores and 12 performance cores. The
neural runs used PyTorch MPS, binary cross-entropy, AdamW and batches of 1,024. I restored the
best validation epoch after four epochs without improvement or a cap of 24, then fitted a logit
temperature on validation. The rating scales were fitted separately on each source's training
players. All four repeated models use the same 157,583 Chess.com blitz test positions.

Per-seed scores and paired differences below are in seed order 24, 25 and 26. Each interval is
a 90% interval from 2,000 paired resamples of Chess.com test players. A negative difference means
lower log loss than the named reference.

- **Gradient boosting, Chess.com and Lichess.** Mean 0.40835, range 0.40831 to 0.40839. Seeds
  scored 0.40839, 0.40831 and 0.40834. Differences from Chess.com-only boosting were
  −0.00117 [−0.00144, −0.00090], −0.00125 [−0.00152, −0.00096] and −0.00122 [−0.00151, −0.00093].
- **Board, context and move features, Chess.com only.** Mean 0.40663, range 0.40598 to 0.40719.
  Seeds scored 0.40598, 0.40674 and 0.40719. Differences from Chess.com-only boosting were
  −0.00358 [−0.00469, −0.00247], −0.00282 [−0.00391, −0.00177] and −0.00237 [−0.00352, −0.00125].
- **Board and context, Chess.com and Lichess.** Mean 0.40981, range 0.40879 to 0.41119. Seeds
  scored 0.40945, 0.41119 and 0.40879. Differences from joint boosting were
  +0.00105 [−0.00019, +0.00229], +0.00288 [+0.00154, +0.00410] and +0.00045 [−0.00078, +0.00167].
- **Board, context and move features, Chess.com and Lichess.** Mean 0.40366, range 0.40257 to
  0.40500. Seeds scored 0.40257, 0.40341 and 0.40500. Differences from joint boosting were
  −0.00583 [−0.00692, −0.00481], −0.00490 [−0.00604, −0.00387] and −0.00334 [−0.00442, −0.00226].
  Differences from the same neural architecture trained on Chess.com only were
  −0.00341 [−0.00422, −0.00260], −0.00333 [−0.00414, −0.00249] and −0.00219 [−0.00300, −0.00136].

The full joint model beat joint boosting in all three seeds. The Chess.com-only comparison
also showed a gain from the full neural architecture on the same data. Adding Lichess to that
architecture gave a further mean gain of 0.00298. In the seed-24 pilot, the joint board-only model
scored 0.41797 and joint context plus move features scored 0.41353.

I chose the export architecture by mean Chess.com validation log loss across seeds, then took
its best seed on the same validation split. The selected full joint model had 81,921 parameters
and came from seed 24, epoch 7. It reached 0.40257 log loss, 0.13099 Brier and 0.80925 AUC on
Chess.com, and 0.45893, 0.15217 and 0.79859 on Lichess. It predicted a 79.03% find rate on
Chess.com blitz, where 79.28% of moves were found. On Lichess, the gap by speed was at most
1.06 points. Some rating bands within a speed had larger gaps, including 10.72 points for Rapid
at 400 through 599, with 110 test positions. The per-seed JSON includes the full calibration curves
and breakdowns by 200-point rating band and time control.

### Trained export and TypeScript timing

I checked the trained weights on 300 Chess.com holdout positions and six synthetic positions.
The Python and TypeScript inputs matched exactly, and the TypeScript probabilities agreed with
int8 ONNX within 0.001. Float ONNX and PyTorch differed by at most 0.00000108 on this sample.

On all 157,583 Chess.com test positions, per-output-channel int8 weights raised log loss from
0.402567 to 0.402610, a change of +0.000043. The largest absolute probability difference was
0.03703, and 26,481 positions exceeded the 0.005 tolerance. This export missed the maximum-error
target.

I ran the same bundled TypeScript predictor in Node 26.8.2 and headless Chrome 157.0.8103.79 on
the M5 Pro Mac. Each runtime used three fresh launches, one warmup pass over the 300 sampled
Chess.com positions and three measured passes per launch. The medians and 95th percentiles below
pool 2,700 calls per runtime and mode. The model weights were decoded before timing.

- **Node.** The forward pass took 0.89 ms at the median and 0.93 ms at the 95th percentile.
  Encoding the FEN, context and move features plus the forward pass took 2.03 ms and 2.92 ms.
- **Headless Chrome.** The forward pass took 0.90 ms and 1.00 ms. Encoding plus the forward pass
  took 1.90 ms and 2.80 ms.

The timings cover the standalone TypeScript predictor on this Mac. The offscreen page and its
ONNX Runtime Web path still need a runtime comparison.

```sh
engine_data=data/engine
prepared=eval_results/neural-find-rate/prepared-v1
runs=eval_results/neural-find-rate/three-seed
python scripts/prepare_neural_find_rate.py --data-root "$engine_data" --output "$prepared" --workers 12
for seed in 24 25 26; do
  python scripts/train_neural_find_rate.py --prepared "$prepared" --output "$runs/seed-$seed" \
    --seed "$seed" --device mps --models logistic_move boosting_move joint_boosting_move \
    chesscom_board_context_move joint_board_context joint_board_context_move
done
python scripts/summarize_neural_find_rate.py --runs "$runs" --prepared "$prepared" --device mps
checkpoint=$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["selected"]["checkpoint"])' "$runs/summary.json")
python scripts/check_neural_find_rate.py --checkpoint "$runs/$checkpoint" --prepared "$prepared" \
  --data-root "$engine_data" --output "$runs/export"
python scripts/benchmark_neural_find_rate.py "$runs/export"
```

### Shipped review model

The extension uses the validation-selected seed-24, epoch-7 network trained on Chess.com blitz
and Lichess. The offscreen TypeScript predictor uses the board, player context and 21 move
features. It scores eligible cards from finished games, including older saved cards with logistic
estimates. Recomputing a card's estimate preserves its review progress and due date. Display rounding stays the same as in the previous version, while allowed sites, speeds, and rating ranges follow the held-out calibration limits under [Review cards and ordering](#how-often-players-find-the-only-good-move).

I exported all 81,921 weights and biases as float16 and compared them with float32 on the full
157,583-position Chess.com test set. The largest probability shift was 0.000424 with the recorded
clock and 0.000433 with the review clock fixed at 0.6561. Both checks had zero positions above
0.005. The TypeScript predictor also matched packed ONNX within 0.001 on the 300 held-out positions
and six synthetic positions used in the parity check.

The exported weight file is 218,794 bytes. On my M5 Pro Mac, `scripts/build_extension.sh` produced
a ZIP of 1,476,239 bytes, up 165,916 bytes from 1,310,323 on `91b6b3f` with the same dependencies.
The weights are bundled into the offscreen JavaScript.

```sh
python scripts/check_neural_find_rate.py --checkpoint "$runs/$checkpoint" --prepared "$prepared" \
  --data-root "$engine_data" --output "$runs/export-float16" --precision float16 --review-clock 0.6561
cp "$runs/export-float16/weights.json" web/src/extension/neuralFindRateWeights.json
bash scripts/build_extension.sh
wc -c web/src/extension/neuralFindRateWeights.json dist/chess-check-extension.zip
```

### Retraining with Chess.com rapid and bullet

I extended `scripts/prepare_neural_find_rate.py` (`--chesscom-extra`) to append the 95,683 non-test Chess.com rapid and bullet critical positions (`data/engine/chesscom-rapid-train-v1/training.parquet`) to the v1 inputs (`1,431,068` total rows in `prepared-v2`, asserting zero `hash % 5 == 0` test players in the extra rows). The three held-out test sets stayed untouched throughout training, early stopping, temperature scaling, and seed selection: v1 Chess.com blitz (`157,583`), Lichess (`106,835`), and `data/engine/chesscom-rapid-v1` (`20,069`).

I kept the existing per-source `RatingScale` so the exported weight format and browser predictor remain unchanged. Adding Chess.com rapid and bullet widened the Chess.com training rating distribution from mean `1665.82` and std `115.23` (blitz only) to mean `1643.82` and std `223.37`, while Lichess stayed at mean `1659.46` and std `367.13`.

I trained `joint_board_context_move` across seeds 24, 25, and 26 on Ashton's M5 Pro Mac (18 cores, PyTorch CPU with 12 threads, AdamW, batch size 1,024, patience 4, logit temperature fitted on validation):

- **Seed 24:** best epoch 8, validation log loss `0.422738` (temperature `1.04306`, `1,155.9` s).
- **Seed 25:** best epoch 6, validation log loss `0.421950` (temperature `1.05255`, `958.3` s). Selected on validation.
- **Seed 26:** best epoch 8, validation log loss `0.423924` (temperature `1.07279`, `1,144.6` s).

`scripts/eval_retrained_find_rate.py` compares the validation-selected seed-25 checkpoint against the shipped float16 weights (`web/src/extension/neuralFindRateWeights.json`) on all eight held-out `(site, speed)` pairs using 2,000 player-grouped paired bootstrap resamples (negative log-loss delta favors the retrained model).

**Recorded clock:**

| Site | Speed | Held-out n | Shipped LL | Retrained LL | Delta (90% CI) | Shipped Brier | Retrained Brier | Pred (ship / new) | Actual |
|---|---|---:|---:|---:|---|---:|---:|---|---:|
| Chess.com | blitz | 157,583 | 0.40257 | 0.40197 | -0.00060 [-0.00132, +0.00013] | 0.13099 | 0.13078 | 0.7903 / 0.7929 | 0.7928 |
| Lichess | blitz | 21,508 | 0.40752 | 0.40619 | -0.00133 [-0.00347, +0.00087] | 0.13297 | 0.13243 | 0.7839 / 0.7869 | 0.7876 |
| Lichess | rapid | 22,413 | 0.42947 | 0.43174 | +0.00227 [+0.00010, +0.00436] | 0.14035 | 0.14110 | 0.7646 / 0.7864 | 0.7720 |
| Lichess | bullet | 20,861 | 0.44504 | 0.44385 | -0.00119 [-0.00335, +0.00108] | 0.14683 | 0.14631 | 0.7466 / 0.7525 | 0.7499 |
| Lichess | classical | 19,559 | 0.41613 | 0.41431 | -0.00181 [-0.00420, +0.00058] | 0.13482 | 0.13394 | 0.7877 / 0.8020 | 0.7922 |
| Lichess | ultraBullet | 22,494 | 0.58753 | 0.58604 | -0.00148 [-0.00407, +0.00104] | 0.20236 | 0.20160 | 0.5848 / 0.6014 | 0.5954 |
| Chess.com | rapid | 9,693 | 0.39090 | 0.36979 | -0.02111 [-0.02610, -0.01605] | 0.12566 | 0.11810 | 0.7753 / 0.8129 | 0.8164 |
| Chess.com | bullet | 10,376 | 0.45857 | 0.43843 | -0.02014 [-0.02552, -0.01520] | 0.15110 | 0.14400 | 0.7926 / 0.7624 | 0.7513 |

**Review clock fixed at 0.6561:**

| Site | Speed | Held-out n | Shipped LL | Retrained LL | Delta (90% CI) | Shipped Brier | Retrained Brier | Pred (ship / new) | Actual |
|---|---|---:|---:|---:|---|---:|---:|---|---:|
| Chess.com | blitz | 157,583 | 0.40312 | 0.40260 | -0.00052 [-0.00125, +0.00020] | 0.13106 | 0.13092 | 0.7932 / 0.7962 | 0.7928 |
| Lichess | blitz | 21,508 | 0.40784 | 0.40661 | -0.00123 [-0.00337, +0.00098] | 0.13302 | 0.13251 | 0.7862 / 0.7893 | 0.7876 |
| Lichess | rapid | 22,413 | 0.42929 | 0.43078 | +0.00150 [-0.00063, +0.00358] | 0.14032 | 0.14081 | 0.7620 / 0.7836 | 0.7720 |
| Lichess | bullet | 20,861 | 0.44681 | 0.44541 | -0.00139 [-0.00359, +0.00088] | 0.14706 | 0.14657 | 0.7528 / 0.7589 | 0.7499 |
| Lichess | classical | 19,559 | 0.41474 | 0.41197 | -0.00276 [-0.00511, -0.00042] | 0.13448 | 0.13328 | 0.7817 / 0.7958 | 0.7922 |
| Lichess | ultraBullet | 22,494 | 0.59059 | 0.58934 | -0.00125 [-0.00390, +0.00129] | 0.20354 | 0.20291 | 0.5893 / 0.6057 | 0.5954 |
| Chess.com | rapid | 9,693 | 0.39252 | 0.37005 | -0.02247 [-0.02738, -0.01748] | 0.12608 | 0.11810 | 0.7732 / 0.8105 | 0.8164 |
| Chess.com | bullet | 10,376 | 0.46209 | 0.44097 | -0.02111 [-0.02649, -0.01615] | 0.15182 | 0.14460 | 0.7966 / 0.7673 | 0.7513 |

**The ship gate failed.** Retraining cut log loss sharply on both new targets (Chess.com rapid `-0.02111` recorded / `-0.02247` review clock; Chess.com bullet `-0.02014` recorded / `-0.02111` review clock) and lowered point-estimate log loss on Chess.com blitz and four of five Lichess speeds. However, Lichess rapid regressed by `+0.00227` (`[+0.00010, +0.00436]`) on recorded clock and `+0.00150` (`[-0.00063, +0.00358]`) on review clock, exceeding the `+0.001` 90% CI upper-bound guard. On Lichess rapid, mean predicted find rate moved from `0.7646` to `0.7864` against `0.7720` actual while Chess.com rapid moved from `0.7753` to `0.8129` against `0.8164` actual, because the model shares one `rapid` speed indicator and one 32-unit hidden layer across both sites without explicit site-by-speed terms or per-speed rating scales. In addition, Lichess bullet (`+0.00108` recorded) and ultraBullet (`+0.00104` recorded, `+0.00129` review) had 90% CI upper bounds slightly above `+0.001` despite negative point estimates. I kept the shipped weights (`web/src/extension/neuralFindRateWeights.json`) and `REVIEW_RATE_RANGES` unchanged.

```sh
python scripts/prepare_neural_find_rate.py --data-root data/engine \
  --chesscom-extra data/engine/chesscom-rapid-train-v1/training.parquet \
  --base-prepared eval_results/neural-find-rate/prepared-v1 \
  --output eval_results/neural-find-rate/prepared-v2 --workers 1
for seed in 24 25 26; do
  python scripts/train_neural_find_rate.py --prepared eval_results/neural-find-rate/prepared-v2 \
    --output eval_results/neural-find-rate/retrain-v2/seed-$seed --seed $seed \
    --device cpu --threads 12 --models joint_board_context_move
done
python scripts/eval_retrained_find_rate.py \
  --prepared eval_results/neural-find-rate/prepared-v2 \
  --chesscom-extra data/engine/chesscom-rapid-v1/training.parquet \
  --shipped-weights web/src/extension/neuralFindRateWeights.json \
  --candidate eval_results/neural-find-rate/retrain-v2/seed-25/joint_board_context_move.pt \
  --output eval_results/neural-find-rate/retrain-v2/eval-seed-25.json --workers 1
```

## Deployment

- I run the Python tests, TypeScript tests and build, and Chrome extension build in GitHub Actions on pull requests and pushes to main.
- **Live demo:** GitHub Pages. `scripts/make_snapshot.py` saves an analysis and coach report for the opening page, and `.github/workflows/pages.yml` runs the TypeScript tests, builds `web/` and deploys it. Asset URLs carry the commit hash so new deploys show up right away.
- **Full app:** the Dockerfile builds the frontend and a Python image with Stockfish and CPU-only PyTorch (needed by sentence-transformers). `docker compose up --build` runs it with MySQL. Hosting defaults cap a request at 150 games, depth 8 and 2 engine workers.
- **Why not a free server host:** the free tiers I tried were either too slow for Stockfish (Render, 0.1 CPU) or now require a paid plan (Hugging Face Docker Spaces). Running everything in the browser avoids hosting entirely. `scripts/deploy_hf.sh` still deploys the image to a Space for anyone with a paid plan.

## Ideas for later

- Compare each opening against all Lichess players at the same rating, using the open Lichess database.
- Tag blunders by tactical motif (forks, pins, back-rank) and link matching Lichess puzzles.
- Load the tables into BigQuery; the SQL is standard and only the connection changes.
