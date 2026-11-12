# Weakness Finder

Enter a Chess.com username and get an honest answer to "what am I actually bad at?"

**[Live demo](https://ashtonaliu.github.io/weakness-finder/)**: enter any Chess.com username and the analysis runs entirely in your browser. Games come straight from Chess.com's API, and Stockfish runs as WebAssembly across parallel workers (about 15–40 s for 150 games). The blunder-risk model trains in the browser too (logistic regression, fitted by Newton's method). There's no server and no key. The page opens on a snapshot of my own games with the coach's verified report. The live AI coach is in the full app ([Run it](#run-it)).

- **Openings, adjusted properly.** "You score 38% against the Sicilian" says little if those opponents were stronger or there were only 6 games. Each game's result is compared with its Elo-expected score. Per-opening averages go into a hierarchical Bayesian model that shrinks them toward the player's mean, with a 90% interval for each. Openings that look bad on their own but could be chance among ~30 tested are labeled "worth watching", not "weakness".
- **Where it goes wrong.** For each weak opening, it finds the move sequence where your results drop off, for example *"after 1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Qxd4 you score 22% in 6 games"*.
- **Engine analysis of every move.** Stockfish runs on every position. Losses are measured in win probability, not centipawns, and split by game phase.
- **A blunder-risk model.** It predicts whether a move will lose 20 or more win% from position and clock features. It learns from your opponents' moves (players of similar rating) and then scores yours, so it can say *"you made 1.6× the blunders the model expects in positions this hard, mostly with under 10% of your clock left."*
- **A grounded LLM coach, with evals.** An agent with SQL, retrieval and Stockfish tools writes the report. A verifier checks every number, move and link in it against the facts and tool results the agent was given. If anything is unsupported, the checker's findings go back to the agent for one repair turn.

## Skills demonstrated

| Area | In this project |
|---|---|
| Data preprocessing and feature engineering pipelines | PGN and clock parsing, per-move engine and position features, canonical opening families. Parallel, cached Stockfish runs 300 games in about 30 s on the server and 150 in about 17 s in the browser |
| Developing, training and deploying ML models into a product | Hierarchical Bayesian opening model and a blunder-risk classifier, benchmarked in scikit-learn and PyTorch. The classifier was reimplemented in TypeScript and ships to every visitor's browser |
| Math and traditional ML | Elo expectation, a normal-normal hierarchical model with the variance integrated out, multiple comparisons, Poisson intervals, grouped cross-validation, and calibration vs. discrimination |
| LLM applications: context engineering, RAG, evals, agentic patterns | Tool-using agent (SQL, retrieval over your games, Stockfish) with computed facts instead of raw games, served over the API or MCP. Verifier and repair loop, plus a five-player hallucination eval with a manual audit |
| SQL | DuckDB tables and aggregations (standard SQL, portable to BigQuery), and a sandboxed read-only SQL tool for the agent |
| Python and TypeScript | Python is the reference implementation. The TypeScript port is parity-tested against it in CI: statistics match to 1e-9 and model probabilities to 1e-6 |
| Ownership | Real data exposed mistakes in my own method, and the fixes are documented below: collapsed shrinkage, a self-referential baseline, verifier bugs and a solver stopping early |

## Results

**Blunder-risk model.** Tested on 150 blitz games / 14,217 moves (a public account), with a held-out split grouped by game so no game appears in both train and test. Blunder base rate: 1.3%.

| Model | ROC AUC | Log loss | Brier |
|---|---:|---:|---:|
| Base rate | 0.500 | 0.073 | 0.014 |
| Logistic regression (scikit-learn, with clock and eval band features) | 0.824 | 0.064 | 0.014 |
| Gradient boosting (scikit-learn) | 0.835 | 0.064 | 0.013 |
| MLP (PyTorch) | 0.848 | 0.062 | 0.014 |

The top features by permutation importance are fraction of clock left, then the engine eval before the move. Time pressure predicts blunders better than position type does.

**Calibration matters more than AUC here.** The page reports *actual ÷ expected* blunders per clock band, so what matters is whether predicted totals are right within each band, not just the ranking. A plain logistic model ranks well (AUC 0.840) but can't bend at low clock: across five players it disagreed with gradient boosting by up to 0.75 in the low-clock ratio. Adding indicator features for the reported bands makes a logistic model match observed and predicted totals within each band on its training data. On held-out opponent moves, pooled across five players (actual ÷ predicted, by band <10% / 10–30% / >30% of clock):

| Model | <10% | 10–30% | >30% |
|---|---:|---:|---:|
| Logistic regression with band features | 0.96 | 0.99 | 0.99 |
| Gradient boosting | 1.12 | 0.95 | 0.99 |

The band features cost a little AUC (0.840 → 0.824) and buy calibration where the page needs it. So the browser uses logistic regression, and every ratio now carries a 90% Poisson interval. Opponents make only about 15–30 low-clock blunders per player, so those intervals are wide, and the page highlights a band only when its interval excludes 1.

**Coach hallucination eval** (`scripts/eval_coach.py`). 5 players (me plus four similar-rated recent opponents), 120 blitz games each, run through Claude Opus 5.5. The same verifier scores three conditions:

| Condition | Unsupported claims (lenient) | Clean reports | Unsupported claims (strict) | Clean reports |
|---|---:|---:|---:|---:|
| Raw PGNs, no context engineering | 46 / 323 (14.2%) | 0 / 5 | n/a | n/a |
| Computed facts + tools, first draft | 4 / 214 (1.9%) | 2 / 5 | 19 / 214 (8.9%) | 0 / 5 |
| Facts + tools + verifier repair | 0 / 202 (0.0%) | 5 / 5 | 0 / 202 (0.0%) | 5 / 5 |

*Lenient:* a number, move or link counts as supported if it appears anywhere in the computed analysis or in the games the model was shown. That's fair to the raw baseline, which was never asked to cite. *Strict:* it must appear in the specific fact its sentence cites.

**What "unsupported" means.** I checked one raw report by hand against the games. All 7 move sequences it cited were real, and its Black record (6–9–1) was right. Its White record ("10–4") was wrong: the truth was 9–5. Most of its other flagged numbers were training advice ("20 minutes a day"). So the raw model isn't 14% wrong. Its claims can't be checked automatically, and when one is wrong, nothing catches it. The grounded coach makes every claim checkable. Its first drafts mostly fail strict checking by citing the wrong fact for a correct number, and one repair turn fixed all 5.

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
| Agent loop with tools + repair (Claude API) | `wf/coach.py` |
| Same agent through Claude Code, tools served over MCP | `wf/coach_cli.py`, `wf/mcp_server.py` |
| Claim verifier | `wf/verify.py` |
| API | `server.py` |
| Frontend (TypeScript, no framework) | `web/src/main.ts` |
| In-browser port: game fetching, stats, Stockfish WASM worker pool | `web/src/browser/` (parity-tested against the Python: `web/test/parity.test.ts`) |
| Eval, model benchmark, example report | `scripts/` |

### Design decisions

- **Shrinkage, not thresholds.** A "minimum 10 games" rule throws away information and still flags noise at 10 games. A normal-normal hierarchical model gives every opening an estimate and an interval.
- **Integrate over the between-opening variance; don't plug in an estimate.** The first version used empirical Bayes. On real data (300 games, 34 openings) both method of moments and maximum likelihood put the between-opening SD near 0. Yet values anywhere from 0 to 10 points fit within one log-likelihood unit. Plugging in ~0 shrank a 12-game, −25-point result to −2 with a falsely narrow interval. The current model puts a half-normal prior on that SD and averages over a grid of values.
- **Multiple comparisons.** With 34 openings checked, one at z ≈ −2 is expected by chance. Those results are flagged "worth watching" rather than called weaknesses.
- **Solvers should converge.** scikit-learn's default logistic-regression tolerance (1e-4) stopped up to 0.7% short in probability. Parity testing against the browser's Newton solver surfaced it, and Python now uses tol=1e-8.
- **Medians for "eval after move 12".** One −7 blowout shouldn't define an opening.
- **The blunder model learns only from opponents.** Training on the user's own moves pulls their actual/expected ratio toward 1 by construction.
- **Win probability, not centipawns.** Going from +9 to +6 doesn't matter; going from +1 to −2 does. Losses use Lichess's logistic mapping from centipawns to win%.
- **Grouped splits.** Moves within a game are correlated, so both the train/test split and the cross-validation for out-of-fold risk predictions are grouped by game.
- **The model never sees raw PGN.** LLMs are unreliable at reading chess positions. The coach gets computed facts and tools, and must cite one for every number, so its claims can be checked mechanically.
- **The verifier is strict, and it was tested against real output.** A number must appear in the specific fact its sentence cites, even if it's "roughly right" or shows up in some other fact. Reading real reports turned up three verifier bugs, each now covered by a regression test. It ignored `[T#]` tool-result citations. It accepted "15 minutes a day" because an unrelated interval ended at +15. And it rejected real game links because the tool result put a colon after each URL, which made the coach delete correct links to satisfy the checker. A checker can fail in both directions, so you have to read what it flags.
- **Two coach backends, one agent.** With `ANTHROPIC_API_KEY` set, the coach uses the Claude API with tool use. Without one, it runs through the local Claude Code CLI (`claude -p`) on the user's Claude subscription: the same three tools are served by a small MCP server, built-in tools are disabled, and the repair turn resumes the same session. A hosted deployment with neither shows a saved example report.

## Run it

Requires Python 3.11+, Node 18+, and Stockfish (`brew install stockfish` or `apt install stockfish`).

```bash
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
(cd web && npm install && npm run build)
# Coach: either install Claude Code and log in (uses your Claude subscription),
# or put ANTHROPIC_API_KEY=... in .env (copy .env.example).
.venv/bin/uvicorn server:app --port 8765
```

Open http://localhost:8765. Other commands:

```bash
.venv/bin/python -m pytest -q                                # tests (no API calls)
.venv/bin/python scripts/benchmark_model.py USER --games 200  # model table
.venv/bin/python scripts/eval_coach.py USER1 USER2 USER3     # hallucination eval
.venv/bin/python scripts/make_snapshot.py USER               # snapshot + report for the static demo
```

**Deploy:** the public demo is a static snapshot on GitHub Pages (`scripts/make_snapshot.py`, then the `pages.yml` workflow builds and deploys `web/` on push). Free hosts that can run Stockfish for live requests are either paid or too slow (0.1 vCPU). The Docker image runs the full app on any container host, for example Hugging Face Spaces (free tier, 2 vCPU): run `hf auth login` once, then `scripts/deploy_hf.sh <hf-user>/weakness-finder`. That pushes the committed HEAD with the Space's required README header. Hosting defaults in the Dockerfile cap a request at 150 games, Stockfish depth 8 and 2 engine workers. A cold analysis takes about a minute. PyTorch is left out of the image because only the offline benchmark uses it. With no API key on the host, the coach shows the saved example report. Set `ANTHROPIC_API_KEY` as a Space secret to turn live coaching on.

## Next steps

- Peer baseline: compare each opening against all Lichess players at the same rating (open database), not just the player's own average.
- Tactical-motif tags for blunders (missed forks, pins, back-rank) and links to matching Lichess puzzles.
- Run the warehouse in BigQuery. The SQL is standard and only the connection changes.
- Bring-your-own-key coach in the browser: the visitor's Anthropic key calls the API directly from the page, with DuckDB-WASM for the SQL tool and the verifier ported to TypeScript.

## Licenses

The in-browser demo serves [Stockfish.js](https://github.com/nmrugg/stockfish.js) (GPL-3.0) unmodified as a separate file, and the Docker image installs Debian's `stockfish` package. Both are separate programs this project talks to over UCI. Their source is available at those links.
