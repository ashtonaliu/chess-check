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

**Chrome extension** (`extension/`, built from `web/src/extension/` by `scripts/build_extension.sh`). A Manifest V3 extension with three parts. A content script (`content.ts`) draws a 44 pixel draggable cube inside a closed Shadow DOM on Chess.com pages, so Chess.com's styles and the extension's cannot affect each other. It needs no setup. It takes the game ID from the address and gets both usernames from `/callback/live/game/<id>` (or `/callback/daily/game/<id>`), the same endpoint the game page loads. It reads the signed-in username from the user settings Chess.com embeds in every page as JSON, with the sidebar link to your profile as a fallback, and reads nothing else from the page. Signed out, it shows both players as buttons and remembers the one you pick. The callback returns 404 for a game that is still being played (I checked one game that went from 404 to a finished resignation a minute later), and the cube treats that as "your recap will appear when this game ends". It remembers its position in `chrome.storage`. An offscreen document (`offscreen.ts`) does the heavy work with the same browser code as the website: game fetching, the profile build, Stockfish (bundled, not loaded from a CDN, since the Chrome Web Store forbids remote code), tactics and the recap. When the engine runs: the cube asks the offscreen page to build ("warm") the profile only from pages that are not a game or the play page, for the time class the player played most in their last 40 games. Opening the play page or a game in progress sends "stop", which aborts the build through an AbortController between games or blunder checks (in testing, a build at game 64 of 150 restarted from scratch afterwards). Version 0.2 started the build as soon as any game page opened, including a game in progress.

The recap does not wait for the public archive. On a game page the cube asks `/callback/live/game/<id>` every 5 seconds; it answers 404 until a live game is over. The finished game's moves come in Chess.com's two-characters-per-move encoding, which `web/src/browser/tcn.ts` decodes (tested against the archive's PGN on three real games, including an underpromotion and a capturing promotion). `callbackGame.ts` rebuilds the PGN with clock times from the endpoint's move timestamps, takes pre-game ratings as the endpoint's rating minus its rating change, and names the opening from the past game that shares the longest run of opening moves, because the endpoint's ECO code does not always match the archive's (A84 against A40 for one game). Profiles are saved in IndexedDB (`profileStore.ts`) and reused after a restart, then refreshed in the background once per session; with the engine cache the refresh only analyzes new games. A first-ever build uses the last 50 games, and a 150-game build follows in the background; the recap says so while it is based on 50. The extension has the `unlimitedStorage` permission and the website asks for persistent storage, so the browser does not evict the caches when disk space runs low.

Measured in Chromium on chess.com (150 bullet games, no cache): engine pass 14.7 s, blunder re-check 5.4 s, fetching 0.7 s, patterns 0.6 s. A recap was ready 12.7 s after opening a finished game on a new install (50-game build), 1.5 s once the profile was full, and 3.2 s after restarting the browser. Raising the worker cap from 8 to 17 on an 18-core Mac only took a cold build from 21.0 to 19.7 s (two runs each), so the cap stays at 8. Caching positions across games was not worth adding: only 6.1% of 12,830 positions in 150 games repeated. The service worker (`background.ts`) creates the offscreen document when needed and relays messages between the two, because content scripts cannot start workers and service workers cannot run Stockfish. It asks only for storage and offscreen, and for access to `api.chess.com`.

The fair-play guard (`web/src/extension/guard.ts`, tested in `web/test/guard.test.ts`): the game ID is taken from the tab's address, and a recap is shown only if that ID appears in the player's games from the public API, which lists finished games only. Matching by ID covers every address form Chess.com uses (`/game/<id>`, `/live/game/<id>`, `/game/live/<id>`, the daily forms and the analysis review page). Chess.com loads a game at `/game/<id>` and then rewrites the address to `/live/game/<id>` a few seconds later, which I only found by testing in a real browser. The game is looked up by ID in the player's last three monthly archives. An earlier version only checked the 30 most recent games, so a game with 30 or more newer games after it counted as unfinished. Version 0.1 compared full URLs and missed `/game/<id>`, the form Chess.com now uses for live games, so it never showed a recap; the tests now include that form. A game still being played never appears in the API, so it never gets a recap; the cube shows only "Your recap will appear when this game ends" and checks again every 20 seconds. Pages that are not games, including the page where games are played, show no data. Tested in a development harness (`extension/dev.html`, which stands in for the Chrome APIs) and in Chromium with the unpacked extension on the live Chess.com site, with a game finished minutes earlier (recap), an unfinished game (waiting message only), the play page (hint only) and dragging.

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

**Post-game ratings.** The `rating` field in Chess.com's game archive is the rating after the game. Across 980,711 consecutive game pairs, a player's rating change agreed with the result of that same game 99.6% of the time and with the previous game's result 50.2% of the time. The first run used those ratings and reported a Brier score of 0.163 for the fitted ratings model against 0.218 for the Elo formula, because the fitted model had learned to read the result from the rating change. The script now uses each player's rating after their previous game in the same time class. For past games in a player's history, the opponent's pre-game rating is estimated as their post-game rating plus the player's own rating change. On these games, post-game ratings move the expected score by 2.2 percentage points on average, almost always toward the actual result.

### Stockfish history features

`scripts/eval_engine_features.py` samples 1,000 distinct targets with seed 0,
round-robin across focal players. For each player it uses their latest 50 blitz
games that finished before the target's PGN start time and the rating recorded
after their previous blitz game. It excludes targets whose start time or full
history is unavailable. Stockfish runs at depth 10 and reuses the evaluation
after each move as the next move's starting evaluation. The target's engine
output is used only for the accuracy label, the difference between the two
players' mean win-percentage-point loss per move.

The result model compares ratings alone with ratings plus engine features
using grouped five-fold cross-validation by focal player. It reports expected
score Brier, log loss, paired 90% focal-player bootstrap intervals, and the
same interval-width sensitivity estimate as the odds experiment. The
accuracy-gap comparison reports out-of-fold R² for ridge and histogram
gradient boosting.

**Run status.** The available v3 input contains 20 distinct targets from two
focal players, so the 1,000-game study and five-fold evaluation are pending.
A smoke test downloaded both players' histories for one target and verified
the two 50-game cutoffs. Stockfish 19 analyzed three games in 2.052 summed
engine seconds (1.256 seconds wall time with two workers). Repeating that
batch ran zero engine searches. Both model families ran on synthetic data.
No real-data Brier, log loss, interval, sensitivity estimate, or R² is
available yet.

```sh
python scripts/eval_engine_features.py --source /path/to/data/odds/v3
```

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
