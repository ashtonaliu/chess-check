// The review queue's scheduling, seeding and limits.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Recap } from "../src/browser/recap";
import { addItems, dueItems, grade, itemFromRecap, itemsFromBlunders, MAX_ITEMS, nextDue, patchItems, type ReviewItem } from "../src/browser/reviewQueue";
import type { BlunderRec } from "../src/browser/tactics";

const DAY = 86_400_000, NOW = 1_800_000_000_000;

const item = (id: string, over: Partial<ReviewItem> = {}): ReviewItem => ({
  id, url: `https://www.chess.com/game/live/${id.split(":")[0]}`, ply: Number(id.split(":")[1] ?? 0), label: "22...Qf5",
  san: "Qf5", best: "Bxf3+", loss: 60, tactics: [], opponent: "x", endTime: 1000, step: 0, due: NOW, ...over });

test("finding a position moves it up the ladder until it is learned; missing starts it over", () => {
  let q = [item("1:43")];
  const days = [3, 7, 21];
  let t = NOW;
  for (const d of days) {
    q = grade(q, "1:43", true, t);
    assert.equal(q[0].due, t + d * DAY);
    t = q[0].due;
  }
  q = grade(q, "1:43", true, t);
  assert.equal(q[0].done, true);
  assert.deepEqual(dueItems(q, t + 100 * DAY), []);
  assert.equal(nextDue(q), null);

  const missed = grade([item("2:10", { step: 2 })], "2:10", false, NOW);
  assert.equal(missed[0].step, 0);
  assert.equal(missed[0].due, NOW + DAY);
});

test("due positions come oldest first, and future ones wait", () => {
  const q = [item("1:1", { due: NOW - 5 }), item("2:1", { due: NOW + DAY }), item("3:1", { due: NOW - 50 })];
  assert.deepEqual(dueItems(q, NOW).map(i => i.id), ["3:1", "1:1"]);
  assert.equal(nextDue(q), NOW - 50);
});

test("the same position is never added twice, and a full queue drops learned then oldest", () => {
  assert.equal(addItems([item("1:43")], [item("1:43"), item("1:43")]).length, 1);
  const full = Array.from({ length: MAX_ITEMS }, (_, i) => item(`${i + 10}:1`, { endTime: 100 + i, done: i === 30 }));
  const after = addItems(full, [item("999:1", { endTime: 5000 })]);
  assert.equal(after.length, MAX_ITEMS);
  assert.ok(after.some(i => i.id === "999:1"));
  assert.ok(!after.some(i => i.id === "40:1"), "the learned position goes first");
});

test("a recap adds its turning point only when it was a real question, due tomorrow", () => {
  const base = { url: "https://www.chess.com/game/live/187502325560", opponent: "YodaRampage", endTime: 1700 } as Recap;
  const turning = { label: "22...Qf5", loss: 69, phase: "middlegame", best: "Bxf3+", fen: "", ply: 43, moveNo: 22, san: "Qf5",
                    tactics: [{ kind: "missed" as const, motif: "fork" }], clockFrac: null };
  const it = itemFromRecap({ ...base, turning: { ...turning, findRate: 0.65 } }, NOW)!;
  assert.equal(it.id, "187502325560:43");
  assert.equal(it.findRate, 0.65);
  assert.equal(itemFromRecap({ ...base, timeClass: "rapid", turning } as Recap, NOW)!.timeClass, "rapid");
  assert.equal(it.due, NOW + DAY);
  assert.equal(itemFromRecap({ ...base, turning: { ...turning, loss: 12 } }, NOW), null);
  assert.equal(itemFromRecap({ ...base, turning: { ...turning, best: "Qf5" } }, NOW), null);
  assert.equal(itemFromRecap({ ...base, turning, pending: { turning: true } }, NOW), null);
});

test("seeding takes your worst blunder per game, newest games first, due now", () => {
  const rec = (url: string, ply: number, loss: number, over: Partial<BlunderRec> = {}): BlunderRec => ({
    url, ply, move_no: Math.floor(ply / 2) + 1, san: "Nf3", is_me: true, phase: "middlegame", wp_loss: loss, piece: "knight",
    allowed: ["fork"], missed: [], lost: null, refutation: null, best: "e4", fen: "", ...over });
  const games = [1, 2, 3].map(n => ({ url: `https://www.chess.com/game/live/${n}`, opponent: `opp${n}`, endTime: n * 100 }));
  const items = itemsFromBlunders([
    rec(games[0].url, 10, 40), rec(games[0].url, 20, 70),            // game 1: the worse one wins
    rec(games[1].url, 5, 90, { is_me: false }),                      // the opponent's blunder
    rec(games[2].url, 7, 30), rec(games[2].url, 9, 15),              // under the threshold
    rec(games[1].url, 11, 50, { best: "Nf3" }),                      // no better move
  ], games.map(g => ({ ...g, myRating: 1800, timeClass: "blitz" })), NOW, undefined, (_fen, best, rating) => (best === "e4" && rating === 1800 ? 0.4 : null));
  assert.deepEqual(items.map(i => [i.id, i.label]), [["3:7", "4...Nf3"], ["1:20", "11.Nf3"]]);
  assert.ok(items.every(i => i.findRate === 0.4 && i.rating === 1800), "the find rate is worked out where chess.js is loaded");
  assert.ok(items.every(i => i.timeClass === "blitz"), "and the time control is kept, since the rate is shown for blitz only");
  assert.ok(items.every(i => i.due === NOW));
  assert.deepEqual(items[1].tactics, [{ kind: "allowed", motif: "fork" }]);
});

test("older entries get their position and rating from fresh copies, and nothing else changes", () => {
  const old = [item("1:43", { step: 2, due: NOW + 5 }), item("2:10", { fen: "kept", rating: 1500 })];
  const fresh = [item("1:43", { fen: "8/8/8/8/8/8/8/K6k w - - 0 1", rating: 1846, step: 0, due: 0 }), item("2:10", { fen: "new", rating: 1900 })];
  const out = patchItems(old, fresh);
  assert.equal(out[0].fen, "8/8/8/8/8/8/8/K6k w - - 0 1");
  assert.equal(out[0].rating, 1846);
  assert.equal(out[0].step, 2);
  assert.equal(out[0].due, NOW + 5);
  assert.equal(out[1].fen, "kept");
});

test("older entries also get their time control from fresh copies", () => {
  const out = patchItems([item("1:43", { fen: "x" })], [item("1:43", { fen: "y", timeClass: "blitz" })]);
  assert.equal(out[0].timeClass, "blitz");
  assert.equal(out[0].fen, "x", "what an entry already has is kept");
});
