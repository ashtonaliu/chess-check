// Wording of the turning point and revealed answer.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Recap } from "../src/browser/recap";
import { createRecapView, describeTurningPoint, tacticSentence } from "../src/ui/recapCard";

test("the answer names each tactic with an article, grouped by what happened", () => {
  assert.equal(tacticSentence([{ kind: "missed", motif: "fork" }, { kind: "missed", motif: "skewer" }]),
    " You missed a fork and a skewer.");
  assert.equal(tacticSentence([{ kind: "allowed", motif: "fork" }, { kind: "missed", motif: "discoveredAttack" }]),
    " You allowed a fork and missed a discovered attack.");
  assert.equal(tacticSentence([]), "");
});

import { chesscomPages } from "../src/browser/sites/chesscomPages";
import { lichessPages } from "../src/browser/sites/lichessPages";

test("turning point copy gives both estimates when available", () => {
  const legacy = { loss: 32 } as NonNullable<Recap["turning"]>;
  assert.equal(describeTurningPoint({ ...legacy, chances: { before: 69.7, after: 38.2 } }),
    "dropped your estimated winning chances from 70% to 38%");
  assert.equal(describeTurningPoint(legacy), "cost 32 percentage points of estimated winning chances");
});

test("turning point move links to the board at that ply on both sites", () => {
  const origDoc = globalThis.document;
  const chessOrigin = chesscomPages.tabPatterns[0].replace("/*", "");
  const lichessOrigin = lichessPages.tabPatterns[0].replace("/*", "");
  try {
    const stubEl = () => ({
      className: "",
      hidden: false,
      innerHTML: "",
      classList: { toggle: () => {}, add: () => {} },
      querySelector: (sel: string) => sel.startsWith(".") ? stubEl() : null,
      addEventListener: () => {},
    });
    const turningEl = stubEl();
    const article = {
      className: "",
      innerHTML: "",
      querySelector: (sel: string) => sel === ".recap-turning" ? turningEl : stubEl(),
    };
    (globalThis as { document?: unknown }).document = { createElement: () => article };
    const mk = (url: string): Recap => ({
      url, color: "white", opponent: "opp", oppRating: 1500, myRating: 1500, timeClass: "blitz",
      endTime: 1, score: 0, expected: 0.5, surprise: -0.5, verdict: "Loss", how: "lost", odds: "exact",
      opening: { family: "Italian Game", name: "Italian Game", history: null, flag: null },
      turning: { ply: 14, label: "8.Ng5", san: "Ng5", best: "d4", loss: 28, fen: "8/8/8/8/8/8/8/8 w - - 0 1",
        phase: "middlegame", clockFrac: 0.7, tactics: [] },
      pattern: null, opponentNote: null,
    });
    const v1 = createRecapView({ sameTab: true });
    v1.update(mk(`${chessOrigin}/game/live/123456`));
    assert.ok(turningEl.innerHTML.includes(`href="${chessOrigin}/game/live/123456?move=14">8.Ng5</a>`), turningEl.innerHTML);
    const v2 = createRecapView({ sameTab: true });
    v2.update(mk(`${lichessOrigin}/game/abcdefgh`));
    assert.ok(turningEl.innerHTML.includes(`href="${lichessOrigin}/game/abcdefgh#14">8.Ng5</a>`), turningEl.innerHTML);
  } finally {
    (globalThis as { document?: unknown }).document = origDoc;
  }
});
