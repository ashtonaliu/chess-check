# Plan: Lichess support

Status: not started.

Chess Check only works for Chess.com players today. This plan adds Lichess to the extension and the
demo, so a Lichess player gets the same recap, patterns and review queue after each game they finish.
Most of the analysis already works for Lichess: Phase A parses and labels Lichess games, and the
neural find-rate model was trained on both sites and takes the site as an input
(`source: "lichess"` in `neuralFindRate.ts`, with all six Lichess speeds). The new work is getting
games from Lichess, deciding when a Lichess game is finished, and keeping the two sites apart in
storage.

| Part | What | Main number |
|---|---|---|
| 1 | A site adapter layer, Chess.com only, no change in behavior | All current tests pass unchanged |
| 2 | Lichess fair-play rules | Every Lichess address in the guard tests is classed correctly |
| 3 | Lichess game parsing | Parsed games match the Phase A parser on the same games |
| 4 | Lichess in the extension | Recap time on a finished Lichess game, cold and warm |
| 5 | Lichess in the demo | Time to analyze 150 Lichess games in the browser |
| 6 | Write-up and release 0.9.0 | README results for Lichess |

## Ground rules

- **Branches and pull requests.** Codex works on `codex/lichess-<topic>` branches and Gemini on
  `gemini/lichess-<topic>`, each from current `origin/main`. Keep each PR under about 800 changed
  lines, excluding fixtures. Commits and PR descriptions are written as Ashton, with no
  Co-Authored-By trailers, "Generated with" lines, session links or emoji footers.
- **CI stays green.** Every PR must pass:
  ```
  .venv/bin/python -m ruff check . && .venv/bin/python -m pytest -q
  cd web && npx tsc --noEmit && npm test && npm run test:wasm
  cd engine-core && cargo fmt --check && cargo test --release && cargo clippy --all-targets -- -D warnings
  bash scripts/build_extension.sh
  ```
  If `test:wasm` or the extension build cannot run in your sandbox, say so in the PR. Do not skip
  them silently.
- **Fair play comes first.** Nothing about a game may be computed or shown while it is in play, on
  either site. The rules for Lichess are below and are decided before any code. Never play a game on
  either site, never open a game in progress, and test only with finished games.
- **No behavior change for Chess.com users.** Part 1 must not change what a Chess.com user sees.
  Stored profiles, review queues and settings from 0.8.x must keep working after the update.
- **Data.** Lichess game data is CC0, so small fixtures exported from finished public games are
  fine. Record each fixture's game URL in the test that uses it. Do not commit real usernames
  beyond what the fixture itself contains.
- **Writing.** Follow the existing voice: first person, plain, specific numbers, few contractions,
  American spelling, no em dashes, no ellipses, and no "not X, but Y".

## Facts to confirm first

The first PR (Part 1) confirms these and corrects this document where they are wrong. They come
from the Lichess API spec (github.com/lichess-org/api) as of November 2026.

1. `GET /game/export/{id}` returns JSON with `Accept: application/json`. **It also serves games in
   progress, delayed by 3 moves.** A game exists in the API before it is finished.
2. Game `status` is one of `created`, `started`, `aborted`, `mate`, `resign`, `stalemate`,
   `timeout`, `draw`, `outoftime`, `cheat`, `noStart`, `unknownFinish`,
   `insufficientMaterialClaim` and `variantEnd`. I expect `created` and `started` to mean the game is
   not over. Confirm this on a finished game and from the Lichess source (`chess.Status` in
   lila), never on a game in progress.
3. `GET /api/games/user/{username}` streams NDJSON with `Accept: application/x-ndjson` and leaves
   out games in progress by default (`ongoing=false`, `finished=true`). Use `clocks=true`,
   `opening=true`, `perfType` and `max`. The documented limit is 20 games per second without
   sign-in, and the API asks for one request at a time and a one-minute wait after a 429.
4. The JSON fields are `players.white.rating`, `players.white.ratingDiff` (and the same for black),
   `speed`, `clock.initial` and `clock.increment`, `status`, `winner`, `moves`, `clocks`
   (centiseconds), `opening.eco` and `opening.name`, `createdAt` and `lastMoveAt` (I expect
   milliseconds), `variant` and `initialFen`. Confirm whether `rating` is the rating before the game
   and whether `moves` is SAN.
5. A player's own address during a game is `lichess.org/{12-character id}`. The first 8 characters
   are the game ID that spectators see. Addresses can end in `/white` or `/black`.
6. How the page exposes the signed-in username. Read only that, the same way the Chess.com content
   script reads only the username.

## Part 1: site adapter layer (Codex)

Move everything that is specific to Chess.com behind one interface, with Chess.com as the only
implementation. Something like:

```ts
interface Site {
  id: "chesscom" | "lichess";
  matches(url: URL): boolean;
  gameIdFromPage(url: string): string | null;
  isPlayPage(url: URL): boolean;
  signedInUser(doc: Document): string | null;
  /** The game if the site reports it finished, "pending" if it is not, null if it is not this player's. */
  finishedGame(id: string, user: string, signal: AbortSignal): Promise<Game | "pending" | null>;
  history(user: string, timeClass: string, max: number, signal: AbortSignal): Promise<Game[]>;
}
```

- Add `site` to `Game`. Every storage key that holds a profile, a recap or a review queue includes
  the site. Keys written by 0.8.x have no site and are read as `chesscom`, with a test that loads a
  0.8.x storage snapshot and gets the same profile and queue back.
- The fair-play guard (`guard.ts`) asks the site for the page's safety key, so the cross-tab pause in
  `background.ts` works the same for both sites.
- No Lichess code in this PR. It is done when all current tests pass without being edited, apart
  from imports.

## Part 2: Lichess fair-play rules (Gemini)

Pure functions and tests only, in a new `web/src/extension/lichessGuard.ts`, so this can run in
parallel with Part 1. Part 4 wires them in.

The hard part is that **a Lichess game page has the same address while the game is played and after
it ends.** On Chess.com the Play page and the finished game have different addresses, so the address
alone tells most of the story. On Lichess it never does. The rules:

1. **Every Lichess game page starts paused.** It stays paused until `/game/export/{id}` reports a
   status other than `created` or `started`. Until then the cube shows nothing about the game, and
   the cross-tab pause applies, exactly as for an unconfirmed Chess.com game.
2. **Only the status is read.** The extension never uses moves, clocks or anything else from an
   export whose status is `created` or `started`.
3. **These pages count as play pages:** the home page and lobby (`/`), `/setup`, any
   `/tournament/`, `/swiss/` and `/simul/` page, since a game can start from them at any time, and
   `/tv`, which always shows games in progress.
4. **These pages are ordinary pages** where the review queue may show: `/analysis`, `/study/`,
   `/training` (puzzles) and `/@/{user}` profiles. If in doubt, a page is a play page.
5. **Game IDs.** `gameIdFromPage` returns the first 8 characters of an 8- or 12-character ID, with
   or without `/white` or `/black`. Paths like `/analysis/...` or `/@/name` never yield an ID.
6. **Status checks** go through the background worker one at a time, no more than once every 3
   seconds per tab, and wait a full minute after a 429.
7. **Aborted games** (`aborted`, `noStart`) get no recap and no error. They are finished but were
   never played.

Tests: a table of at least 30 addresses covering every rule above, plus status mapping for every
status value.

## Part 3: Lichess game parsing (Gemini)

Pure functions and tests only, in `web/src/browser/lichess.ts`. This can also run in parallel with
Part 1.

- `parseLichessGame(json, user): Game | null` maps one exported game to `Game`. It rejects any
  variant other than standard and any `initialFen`, and returns null for a game the user did not
  play or one still in progress.
- Ratings are the ratings going into the game. If `rating` turns out to include the game's change,
  subtract `ratingDiff`, as `gameFromCallback` does for Chess.com.
- `timeClass` is the Lichess `speed` as it is (`ultraBullet` to `classical`, and `correspondence`
  mapped to `daily`), since the neural model already takes these speeds. Profiles group by speed the
  same way Chess.com profiles group by time class.
- Results map to the same codes the recap uses for Chess.com: `win`, `resigned`, `timeout`,
  `checkmated`, the draw codes in `DRAWS`, and so on. Add a test for every Lichess status.
- Clocks come from `clocks` (centiseconds) and are written into the PGN as `[%clk]` comments, so the
  time-pressure analysis reads them the same way.
- `parseLichessNdjson(text, user)` reads a stream of games and skips bad lines with a count, never
  throwing on one bad game.
- **Parity check:** pick 20 finished games from the Lichess open database month Phase A used, fetch
  each one's JSON from `/game/export/{id}`, and check that `parseLichessGame` agrees with the Phase A
  ingest of the same games' PGN on moves, ratings, result and speed. Put the JSON and the expected
  values in `web/test/fixtures/`.

## Part 4: Lichess in the extension (Codex)

After Parts 1 to 3 are merged.

- Add the Lichess adapter, built from Parts 2 and 3.
- Add `https://lichess.org/*` to `host_permissions` and the content script `matches`. Add a
  justification line for it in `docs/store/listing.md`, and update the listing text and privacy
  section to name Lichess.
- History comes from `/api/games/user/{username}` with `max` set to the same 50 and 150 game targets
  Chess.com uses, one request at a time.
- An end-to-end test with a stubbed engine, like `web/test/wasm-archive.parity.ts`, that goes from a
  fixture's status check to a finished recap. A second test shows that a `started` status keeps the
  recap pending and never asks the engine for anything.
- **Live check:** on a finished Lichess game (any public game, never one in progress), the cube
  turns green and the recap fills in. Record the cold and warm recap times the same way the README
  records them for Chess.com.

## Part 5: Lichess in the demo (Gemini, optional)

- A site choice next to the username box on the demo page. Everything after fetching already works
  on `Game[]`.
- The Python side (`chesscheck/fetch.py`, `server.py`) can follow in its own PR. It is not needed for
  the extension.

## Part 6: write-up and release (Codex or me)

- A "Lichess" section in `docs/methods.md`: the fair-play rules, the parity check and the timings.
- A Lichess row in the README's results, and "works on Chess.com and Lichess" in the opening lines.
- Bump the extension to 0.9.0 and add "What's new in 0.9.0" to `docs/store/listing.md`.

## Order of work

| Step | Who | Depends on | Can run alongside |
|---|---|---|---|
| Part 1, adapter layer | Codex | nothing | Parts 2 and 3 |
| Part 2, fair-play rules | Gemini | nothing | Parts 1 and 3 |
| Part 3, parsing | Gemini | nothing | Parts 1 and 2 |
| Part 4, extension | Codex | 1, 2, 3 | Part 5 |
| Part 5, demo | Gemini | 1, 3 | Part 4 |
| Part 6, write-up and 0.9.0 | Codex or me | 4 | none |

Each PR description lists the steps it covered, what it measured, and anything in this document that
turned out to be wrong.
