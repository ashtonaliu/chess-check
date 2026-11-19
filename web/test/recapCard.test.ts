// Wording of the turning point and revealed answer.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Recap } from "../src/browser/recap";
import { describeTurningPoint, tacticSentence } from "../src/ui/recapCard";

test("the answer names each tactic with an article, grouped by what happened", () => {
  assert.equal(tacticSentence([{ kind: "missed", motif: "fork" }, { kind: "missed", motif: "skewer" }]),
    " You missed a fork and a skewer.");
  assert.equal(tacticSentence([{ kind: "allowed", motif: "fork" }, { kind: "missed", motif: "discoveredAttack" }]),
    " You allowed a fork and missed a discovered attack.");
  assert.equal(tacticSentence([]), "");
});

test("turning point copy gives both estimates when available", () => {
  const legacy = { loss: 32 } as NonNullable<Recap["turning"]>;
  assert.equal(describeTurningPoint({ ...legacy, chances: { before: 69.7, after: 38.2 } }),
    "dropped your estimated winning chances from 70% to 38%");
  assert.equal(describeTurningPoint(legacy), "cost 32 percentage points of estimated winning chances");
});
