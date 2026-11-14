// A recap game built from Chess.com's game endpoint matches the same game from the public archive,
// except for the ratings, which the endpoint lets us read as they were before the game.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { gameFromCallback, timeClassOf } from "../src/browser/callbackGame";
import { parseGame } from "../src/browser/games";

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));

for (const [name, user] of [["187138001290", "ashton-iwnl"], ["promo", "ashton-iwnl"], ["promo_capture", "ashton-iwnl"]]) {
  test(`game ${name}: the endpoint gives the archive's game, with pre-game ratings`, () => {
    const cb = fixture(`callback_${name}.json`), raw = fixture(`archive_${name}.json`);
    const want = parseGame(raw, user)!;
    const got = gameFromCallback(cb, user, "live", [want])!;
    // (the ECO code is left out: the endpoint and the archive can disagree, A84 against A40 here)
    for (const k of ["url", "color", "score", "timeClass", "timeControl", "opening", "family", "endTime",
                     "opponent", "result", "oppResult", "moves"] as const) {
      assert.deepEqual(got[k], want[k], k);
    }
    // the archive stores ratings after the game; the endpoint's change undoes it exactly
    const [cw, cbk] = [cb.game.ratingChangeWhite, cb.game.ratingChangeBlack];
    const myChange = want.color === "white" ? cw : cbk, oppChange = want.color === "white" ? cbk : cw;
    assert.equal(got.myRating, want.myRating - myChange);
    assert.equal(got.oppRating, want.oppRating - oppChange);
    // clocks survive into the PGN the analysis reads
    const clk = (p: string) => [...p.matchAll(/\[%clk ([^\]]+)\]/g)].map(m => m[1]);
    assert.deepEqual(clk(got.pgn).map(parseFloat), clk(want.pgn).map(parseFloat));
    assert.deepEqual(clk(got.pgn).length, want.moves.length);
  });
}

test("an unfinished game, or one the user did not play, gives nothing", () => {
  const cb = fixture("callback_187138001290.json");
  assert.equal(gameFromCallback({ game: { ...cb.game, isFinished: false } }, "ashton-iwnl", "live", []), null);
  assert.equal(gameFromCallback(cb, "someone-else", "live", []), null);
});

test("without a matching past game the opening is named by its ECO code", () => {
  const g = gameFromCallback(fixture("callback_187138001290.json"), "dallen6", "live", [])!;
  assert.equal(g.family, "ECO A84");
  assert.equal(g.color, "black");
  assert.equal(g.score, 0);
});

test("time classes follow Chess.com's estimated game length", () => {
  assert.equal(timeClassOf("60"), "bullet");
  assert.equal(timeClassOf("120+1"), "bullet");
  assert.equal(timeClassOf("180"), "blitz");
  assert.equal(timeClassOf("180+2"), "blitz");
  assert.equal(timeClassOf("600"), "rapid");
  assert.equal(timeClassOf("1/86400"), "daily");
});
