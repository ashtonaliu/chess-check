// Wording of the recap's revealed answer.
import assert from "node:assert/strict";
import { test } from "node:test";

import { tacticSentence } from "../src/ui/recapCard";

test("the answer names each tactic with an article, grouped by what happened", () => {
  assert.equal(tacticSentence([{ kind: "missed", motif: "fork" }, { kind: "missed", motif: "skewer" }]),
    " You missed a fork and a skewer.");
  assert.equal(tacticSentence([{ kind: "allowed", motif: "fork" }, { kind: "missed", motif: "discoveredAttack" }]),
    " You allowed a fork and missed a discovered attack.");
  assert.equal(tacticSentence([]), "");
});
