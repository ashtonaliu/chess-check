// Chess.com's move encoding decodes to the same moves as the public archive's PGN.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Chess } from "chess.js";

import { decodeTcn } from "../src/browser/tcn";

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));

for (const [name, what] of [["187138001290", "an ordinary game"], ["promo", "an underpromotion to a rook"],
                            ["promo_capture", "a capturing promotion"]]) {
  test(`${what}: the move codes replay to the archive's moves`, () => {
    const cb = fixture(`callback_${name}.json`), arch = fixture(`archive_${name}.json`);
    const replay = new Chess();
    for (const m of decodeTcn(cb.game.moveList)) replay.move(m);
    const want = new Chess(); want.loadPgn(arch.pgn);
    assert.deepEqual(replay.history(), want.history());
  });
}
