// The review queue's scheduling, seeding and limits.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Recap } from "../src/browser/recap";
import { addItems, applyReviewRates, dueItems, grade, itemFromRecap, itemsFromBlunders, MAX_ITEMS, nextDue, patchItems,
  pendingReviewRates, reviewRate, type ReviewItem } from "../src/browser/reviewQueue";
import type { BlunderRec } from "../src/browser/tactics";
import { reviewFindRate } from "../src/extension/reviewFindRate";

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
  assert.equal(reviewRate(it), null);
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
  ], games.map(g => ({ ...g, myRating: 1800, timeClass: "blitz" })), NOW);
  assert.deepEqual(items.map(i => [i.id, i.label]), [["3:7", "4...Nf3"], ["1:20", "11.Nf3"]]);
  assert.ok(items.every(i => i.neuralFindRate === undefined && i.rating === 1800));
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

test("due positions most players find come first; unrated ones count as typical", () => {
  const blitz = (id: string, findRate: number | null, due: number, rating = 1500) =>
    item(id, { due, neuralFindRate: findRate, rating, timeClass: "blitz" });
  const q = [
    blitz("1:1", 0.55, NOW - 90),                        // hard: most players miss it
    blitz("2:1", 0.95, NOW - 10),                        // a habit to fix
    item("3:1", { due: NOW - 50, timeClass: "rapid", neuralFindRate: 0.99, rating: 1500 }),  // not blitz: typical
    blitz("4:1", 0.95, NOW - 40, 900),                   // rating outside the model: typical
    blitz("5:1", 0.9, NOW + DAY),                        // not due yet
  ];
  assert.deepEqual(dueItems(q, NOW).map(i => i.id), ["2:1", "3:1", "4:1", "1:1"]);
});

test("saved logistic rates are refreshed by the shipped neural model without resetting a review", () => {
  const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const legacy = { ...item("1:1", { fen, best: "Nf3", rating: 1600, timeClass: "blitz", step: 2, due: NOW - 1 }),
    findRate: 0.99 };
  const ready = item("2:1", { fen, best: "Nf3", rating: 1700, timeClass: "blitz", neuralFindRate: 0.8 });
  const rapid = item("3:1", { fen, best: "Nf3", rating: 1700, timeClass: "rapid" });
  assert.equal(reviewRate(legacy), null);
  assert.deepEqual(dueItems([legacy, ready], NOW).map(i => i.id), [ready.id, legacy.id]);

  const queue = [legacy, ready, rapid, { ...legacy, id: "4:1", rating: 2001 }, { ...legacy, id: "5:1", done: true }];
  const requests = pendingReviewRates(queue);
  assert.deepEqual(requests.map(req => req.id), [legacy.id]);
  const [request] = requests;
  const rate = reviewFindRate(request);
  assert.ok(rate !== null && rate > 0 && rate < 1);
  assert.equal(reviewFindRate({ ...request, timeClass: "rapid" }), null);
  assert.equal(reviewFindRate({ ...request, rating: 1299 }), null);
  assert.equal(reviewFindRate({ ...request, rating: 1900 }), null);
  assert.ok(reviewFindRate({ ...request, rating: 1300 }) !== null);
  assert.ok(reviewFindRate({ ...request, rating: 1899 }) !== null);

  const latest = grade(queue, legacy.id, true, NOW);
  const updated = applyReviewRates(latest, { [legacy.id]: rate, [ready.id]: 0.1 });
  assert.equal(reviewRate(updated[0]), rate);
  assert.equal(updated[0].step, 3);
  assert.equal(updated[0].due, NOW + 21 * DAY);
  assert.equal(updated[1], ready);
  assert.deepEqual(pendingReviewRates(updated), []);
});

test("review rate limits enforce per-site and per-speed calibrated rating bounds", () => {
  const fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
  const req = (timeClass: string, rating: number) => ({ id: "1:1", fen, best: "Nc6", rating, timeClass });

  // Chess.com: only blitz 1300-1899 is calibrated; other speeds are refused.
  assert.equal(reviewFindRate(req("blitz", 1299), "chesscom"), null);
  assert.ok(reviewFindRate(req("blitz", 1300), "chesscom") !== null);
  assert.ok(reviewFindRate(req("blitz", 1899), "chesscom") !== null);
  assert.equal(reviewFindRate(req("blitz", 1900), "chesscom"), null);
  for (const speed of ["ultraBullet", "bullet", "rapid", "classical", "daily"]) {
    assert.equal(reviewFindRate(req(speed, 1600), "chesscom"), null, `chesscom ${speed} refused`);
  }

  // Lichess: calibrated per speed, daily refused.
  const lichessBounds: [string, number, number][] = [
    ["ultraBullet", 2000, 2199],
    ["bullet", 1500, 2199],
    ["blitz", 1100, 2299],
    ["rapid", 1300, 2199],
    ["classical", 1200, 1799],
  ];
  for (const [speed, lo, hi] of lichessBounds) {
    assert.equal(reviewFindRate(req(speed, lo - 1), "lichess"), null, `lichess ${speed} below ${lo}`);
    const lowRate = reviewFindRate(req(speed, lo), "lichess");
    const highRate = reviewFindRate(req(speed, hi), "lichess");
    assert.ok(lowRate !== null && lowRate > 0 && lowRate < 1, `lichess ${speed} at ${lo}`);
    assert.ok(highRate !== null && highRate > 0 && highRate < 1, `lichess ${speed} at ${hi}`);
    assert.equal(reviewFindRate(req(speed, hi + 1), "lichess"), null, `lichess ${speed} above ${hi}`);
  }
  assert.equal(reviewFindRate(req("daily", 1600), "lichess"), null, "lichess daily refused");

  // Speed is passed through to the neural model rather than hardcoded to blitz.
  const lichessBlitz = reviewFindRate(req("blitz", 2050), "lichess");
  const lichessUltra = reviewFindRate(req("ultraBullet", 2050), "lichess");
  assert.ok(lichessBlitz !== null && lichessUltra !== null && lichessBlitz !== lichessUltra);

  // Queue helpers infer site from the game URL so Lichess speeds work without a separate site argument.
  const lichessUrl = (id: string) => ["https:", "", "lichess.org", "game", id].join("/");
  const lichessRapid = item("abc12345:12", { url: lichessUrl("abc12345"), fen, best: "Nc6", rating: 2150, timeClass: "rapid" });
  const lichessBlitzHigh = item("def67890:12", { url: lichessUrl("def67890"), fen, best: "Nc6", rating: 2299, timeClass: "blitz" });
  const lichessDaily = item("ghi11111:12", { url: lichessUrl("ghi11111"), fen, best: "Nc6", rating: 1600, timeClass: "daily" });
  const chesscomHigh = item("999:12", { fen, best: "Nc6", rating: 1900, timeClass: "blitz" });
  const pending = pendingReviewRates([lichessRapid, lichessBlitzHigh, lichessDaily, chesscomHigh]);
  assert.deepEqual(pending.map(r => r.id), [lichessRapid.id, lichessBlitzHigh.id]);

  const applied = applyReviewRates([lichessRapid, lichessDaily], { [lichessRapid.id]: 0.82, [lichessDaily.id]: 0.5 });
  assert.equal(reviewRate(applied[0]), 0.82);
  assert.equal(reviewRate(applied[1]), null);
});
