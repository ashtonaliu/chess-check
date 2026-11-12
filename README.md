# Weakness Finder

Type in a Chess.com username and find out what that player is actually bad at.

**[Try the live demo](https://ashtonaliu.github.io/weakness-finder/)**. It runs entirely in your browser, so there is nothing to install and no account needed.

## What it does

1. Downloads your recent games from Chess.com.
2. Runs the Stockfish chess engine on every move to find your mistakes.
3. Checks each opening against what your rating predicts, so a bad result against stronger players does not count against you.
4. Estimates whether you blunder more than similar players would in the same positions, and whether time pressure is the cause.
5. Has an AI coach write a short report, then checks every number and move in it against the real data before showing it.

A typical result, from my own games: *"In the middlegame you blunder on 6.6% of moves, almost the same as your opponents' 6.5%. Your Queen's Gambit as White scores 57% against an expected 50%."*

## Try it

1. Open the [demo](https://ashtonaliu.github.io/weakness-finder/). It starts with an analysis of my own 300 blitz games.
2. Enter any Chess.com username and press Analyze. 150 games take about 15 to 40 seconds.
3. For the AI coaching report, paste your own [Anthropic API key](https://console.anthropic.com/settings/keys). The key only goes from your browser to Anthropic, and a report costs about $0.10 to $0.40.

## How it works

1. **Games:** pulled from the Chess.com public API.
2. **Engine:** Stockfish scores every position. I measure mistakes as lost winning chances, so dropping from +9 to +6 barely counts but +1 to -2 does.
3. **Openings:** each game's result is compared with the result your rating predicted. A statistical model then pulls small samples toward your average, so 4 unlucky games do not get called a weakness.
4. **Blunder model:** a machine learning model learns from your opponents' moves how often a player at your level blunders in a given position and clock situation. Comparing your real blunders with that prediction shows whether you blunder more than expected.
5. **AI coach:** Claude gets the computed facts plus tools to query your games, search them, and run Stockfish. A checker verifies every number, move and link in its report. If something is not supported, the coach gets one chance to fix it.

## Results

**Blunder model.** Predicting which moves will be blunders, tested on 14,217 moves the models never saw (AUC: 0.5 is guessing, 1.0 is perfect).

| Model | AUC |
|---|---:|
| Guessing | 0.50 |
| Logistic regression | 0.82 |
| Gradient boosting | 0.84 |
| Neural network (PyTorch) | 0.85 |

The biggest predictor of a blunder is how little time is left on the clock. The site uses logistic regression because its predictions were the most accurate in the time-pressure range, even though its overall AUC is a little lower.

**AI coach accuracy.** The share of numbers and moves in the coach's reports that could not be backed up by the data, across 5 players.

| Setup | Unsupported claims |
|---|---:|
| Claude reading raw game files | 14% |
| Claude with computed facts and tools | 2% |
| Same, plus the checker and one fix | 0% |

When I checked a raw report by hand, most of its claims were true but impossible to verify, and one win-loss record was simply wrong. Giving the coach computed facts makes every claim checkable.

**Game search.** The coach can search your games by meaning, for example "games where I threw away a winning position". I tested 13 questions with known right answers (precision@5: the share of the top 5 results that are correct).

| Search method | Precision@5 |
|---|---:|
| Random | 0.17 |
| Keyword matching | 0.41 |
| AI embeddings | 0.35 |
| Both combined | 0.45 |

Embeddings understand rewording ("got flagged" finds games lost on time) but confuse who did what ("my king got mated" also finds games where I mated someone). Keywords handle that case, so the coach uses both.

## What I learned

- **Small samples lie.** My Scotch Game as Black looked terrible at 21% over 12 games. The model only marked it "worth watching" because with 34 openings, one bad result is expected by luck. Sixteen games later it was 38%, which is normal.
- **Test against real data early.** Running on my own games exposed a statistics bug that squashed real effects to almost zero, and a blunder baseline that compared me with myself.
- **Check the checker.** My claim checker had three bugs of its own. One rejected correct game links, so the coach deleted good information to make it happy.
- **Measure before trusting the hype.** AI embeddings alone did worse than plain keyword search. Combining them did best.
- **Two versions keep each other honest.** I wrote the analysis in Python and again in TypeScript for the browser. Testing that both give the same answers caught a rounding difference and a solver that stopped too early.

## Tech used

| Area | Tools |
|---|---|
| Languages | Python, TypeScript |
| Machine learning | scikit-learn, PyTorch, a hierarchical Bayesian model, sentence embeddings |
| AI | Claude API, tool use, MCP, retrieval (embeddings plus BM25), evals |
| Data | DuckDB (also in the browser), MySQL, pandas |
| Chess | Stockfish (native and WebAssembly), python-chess, chess.js |
| App | FastAPI, Docker, GitHub Pages, GitHub Actions |

## Run it locally

You need Python 3.11+, Node 18+, and Stockfish (`brew install stockfish`).

```bash
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
(cd web && npm install && npm run build)
.venv/bin/uvicorn server:app --port 8765
```

Then open http://localhost:8765. For the AI coach, either log in to [Claude Code](https://claude.com/claude-code) or put `ANTHROPIC_API_KEY=...` in a `.env` file (see `.env.example`).

To run everything with MySQL instead, set the passwords in `.env` and run `docker compose up --build`.

Tests: `.venv/bin/python -m pytest -q` (Python) and `cd web && npm test` (TypeScript).

## More detail

[docs/methods.md](docs/methods.md) has the full write-up: the statistical model, the evals and how they were scored, the MySQL setup, the three ways the coach runs, deployment, and every design decision with its reasoning.

## License note

The browser demo serves [Stockfish.js](https://github.com/nmrugg/stockfish.js) (GPL-3.0) unmodified as a separate file.
