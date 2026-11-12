# Weakness Finder

Enter a Chess.com username and get an honest answer to "what am I actually bad at?"

- **Openings, adjusted properly.** "You score 38% against the Sicilian" says little if those opponents were stronger or there were only 6 games. Each game's result is compared with its Elo-expected score. Per-opening averages go into a hierarchical Bayesian model that shrinks them toward the player's mean, with a 90% interval for each. Openings that look bad on their own but could be chance among ~30 tested are labeled "worth watching", not "weakness".
- **Where it goes wrong.** For each weak opening, it finds the move sequence where your results drop off, for example *"after 1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Qxd4 you score 22% in 6 games"*.
- **Engine analysis of every move.** Stockfish runs on every position. Losses are measured in win probability, not centipawns, and split by game phase.
- **A blunder-risk model.** It predicts whether a move will lose 20 or more win% from position and clock features. It learns from your opponents' moves (players of similar rating) and then scores yours, so it can say *"you made 1.6× the blunders the model expects in positions this hard, mostly with under 10% of your clock left."*
- **A grounded LLM coach, with evals.** An agent with SQL, retrieval and Stockfish tools writes the report. A verifier checks every number, move and link in it against the facts and tool results the agent was given. If anything is unsupported, the checker's findings go back to the agent for one repair turn.

## Results

**Blunder-risk model.** Tested on 150 blitz games / 14,217 moves (a public account), with a held-out split grouped by game so no game appears in both train and test. Blunder base rate: 1.3%.

| Model | ROC AUC | Log loss | Brier |
|---|---:|---:|---:|
| Base rate | 0.500 | 0.073 | 0.014 |
| Logistic regression (scikit-learn) | 0.840 | 0.063 | 0.013 |
| Gradient boosting (scikit-learn) | 0.835 | 0.064 | 0.013 |
| MLP (PyTorch) | 0.848 | 0.062 | 0.014 |

The top features by permutation importance are fraction of clock left, then the engine eval before the move. Time pressure predicts blunders better than position type does.

**Coach hallucination eval** (`scripts/eval_coach.py`). The same verifier scores three conditions: the model reading raw PGNs, the grounded agent's first draft, and the final report after repair. *To fill in after running it on 3–5 players.*

| Condition | Claims checked | Unsupported rate | Reports fully verified |
|---|---:|---:|---:|
| Raw PGN, no context engineering | | | |
| Facts + tools, first draft | | | |
| Facts + tools + verifier repair | | | |

## How it works

```
Chess.com public API ──► PGN parsing (python-chess) ──► DuckDB: games, moves
                                                          │
             Stockfish (parallel, cached) ──► per-move features: clock, time spent,
                                              mobility, material, eval, phase
                                                          │
     SQL aggregation ──► Elo residuals ──► empirical-Bayes shrinkage ──► opening verdicts
     moves table ──► scikit-learn / PyTorch blunder model ──► actual vs expected blunders
                                                          │
                              numbered facts [F1..Fn] ◄───┘
                                       │
     Claude agent ── tools: run_sql (read-only DuckDB), example_games (retrieval),
                     engine_eval (Stockfish); each result becomes a citable fact [T#]
                                       │
     verifier: citations, moves, numbers, links ──► one repair turn if needed
                                       │
     FastAPI ──► TypeScript UI (forest plot, phase cards, verified report)
```

| Part | File |
|---|---|
| Fetch + parse games, canonical opening families | `wf/fetch.py` |
| DuckDB tables, SQL aggregation, sandboxed SQL tool | `wf/db.py` |
| Elo residuals, shrinkage, intervals, worst branch | `wf/stats.py` |
| Stockfish analysis + feature engineering | `wf/engine.py` |
| Blunder model: logistic regression, gradient boosting, PyTorch MLP | `wf/model.py` |
| Facts given to the coach | `wf/facts.py` |
| Agent loop with tools + repair | `wf/coach.py` |
| Claim verifier | `wf/verify.py` |
| API | `server.py` |
| Frontend (TypeScript, no framework) | `web/src/main.ts` |
| Eval + model benchmark | `scripts/` |

### Design decisions

- **Shrinkage, not thresholds.** A "minimum 10 games" rule throws away information and still flags noise at 10 games. A normal-normal hierarchical model gives every opening an estimate and an interval.
- **Integrate over the between-opening variance; don't plug in an estimate.** The first version used empirical Bayes. On real data (300 games, 34 openings) both method of moments and maximum likelihood put the between-opening SD near 0. Yet values anywhere from 0 to 10 points fit within one log-likelihood unit. Plugging in ~0 shrank a 12-game, −25-point result to −2 with a falsely narrow interval. The current model puts a half-normal prior on that SD and averages over a grid of values.
- **Multiple comparisons.** With 34 openings checked, one at z ≈ −2 is expected by chance. Those results are flagged "worth watching" rather than called weaknesses.
- **Medians for "eval after move 12".** One −7 blowout shouldn't define an opening.
- **The blunder model learns only from opponents.** Training on the user's own moves pulls their actual/expected ratio toward 1 by construction.
- **Win probability, not centipawns.** Going from +9 to +6 doesn't matter; going from +1 to −2 does. Losses use Lichess's logistic mapping from centipawns to win%.
- **Grouped splits.** Moves within a game are correlated, so both the train/test split and the cross-validation for out-of-fold risk predictions are grouped by game.
- **The model never sees raw PGN.** LLMs are unreliable at reading chess positions. The coach gets computed facts and tools, and must cite one for every number, so its claims can be checked mechanically.
- **The verifier is strict.** A number that isn't in a cited fact counts as unsupported, even if it's "roughly right". That makes the eval metric unambiguous.

## Run it

Requires Python 3.11+, Node 18+, and Stockfish (`brew install stockfish` or `apt install stockfish`).

```bash
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
(cd web && npm install && npm run build)
export ANTHROPIC_API_KEY=...   # only needed for the coach
.venv/bin/uvicorn server:app --port 8765
```

Open http://localhost:8765. Other commands:

```bash
.venv/bin/python -m pytest -q                                # tests (no API calls)
.venv/bin/python scripts/benchmark_model.py USER --games 200  # model table
.venv/bin/python scripts/eval_coach.py USER1 USER2 USER3     # hallucination eval (uses the API)
```

**Deploy:** `docker build -t weakness-finder . && docker run -p 8080:8080 -e ANTHROPIC_API_KEY=... weakness-finder` works on Render, Fly.io or Cloud Run.

## Next steps

- Peer baseline: compare each opening against all Lichess players at the same rating (open database), not just the player's own average.
- Tactical-motif tags for blunders (missed forks, pins, back-rank) and links to matching Lichess puzzles.
- Run the warehouse in BigQuery. The SQL is standard and only the connection changes.
