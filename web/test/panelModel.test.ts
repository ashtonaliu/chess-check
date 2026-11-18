// What the cube and panel show, for the paths that were first checked by hand on Chess.com.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReviewItem } from "../src/browser/reviewQueue";
import {
  afterLookup, cubeLook, dueNow, markFind, markSeen, panelView, pollDelay, REOPEN, REVIEW, reviewCard, takeReopen,
  takeReview, wasSeen, whenNext, type Store,
} from "../src/extension/panelModel";

const NOW = 1_800_000_000_000, DAY = 86_400_000;
const HOME = "https://www.chess.com/home", PLAY = "https://www.chess.com/play/online";
const GAME = "https://www.chess.com/game/187502325560";
const item = (id: string, over: Partial<ReviewItem> = {}): ReviewItem => ({
  id, url: `https://www.chess.com/game/live/${id.split(":")[0]}`, ply: Number(id.split(":")[1]), label: "21.Bc1", san: "Bc1",
  best: "Rab1", loss: 39, tactics: [], opponent: "Refisch34", endTime: 1_799_800_000, step: 0, due: NOW - 1, ...over });
const queue = [item("111:40"), item("222:29"), item("333:50", { due: NOW + DAY })];

function memory(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: k => void data.delete(k) };
}

test("a game in progress shows nothing but the wait, and is checked every 5 seconds (daily: a minute)", () => {
  assert.deepEqual(afterLookup(null, GAME, "ashton-iwnl", [], null), { next: "pending", delay: 5_000 });
  assert.deepEqual(afterLookup({ finished: false, white: "a", black: "ashton-iwnl" }, GAME, "ashton-iwnl", [], null),
    { next: "pending", delay: 5_000 });
  assert.equal(pollDelay("https://www.chess.com/game/daily/9001"), 60_000);
  assert.deepEqual(dueNow(queue, GAME, "pending", NOW), []);
  assert.deepEqual(dueNow(queue, GAME, "loading", NOW), []);
  assert.deepEqual(cubeLook("pending", GAME, 2, false).classes, []);
});

test("once the game is over: your recap, the choice of player, or the review the page was opened for", () => {
  const g = { finished: true, white: "YodaRampage", black: "ashton-iwnl" };
  assert.deepEqual(afterLookup(g, GAME, "Ashton-IWNL", [], null), { next: "recap", viewer: "ashton-iwnl" });
  assert.deepEqual(afterLookup(g, GAME, null, ["yodarampage"], null), { next: "recap", viewer: "YodaRampage" });
  assert.deepEqual(afterLookup(g, GAME, "someone-else", [], null), { next: "choose" });
  assert.deepEqual(afterLookup(g, GAME, null, [], null), { next: "choose" });
  assert.deepEqual(afterLookup(g, GAME, "ashton-iwnl", [], "187502325560:43"),
    { next: "review", viewer: "ashton-iwnl", item: "187502325560:43" });
});

test("the play page never shows the count, the review or when the next one is due", () => {
  assert.deepEqual(dueNow(queue, PLAY, "idle", NOW), []);
  assert.equal(panelView("review", "idle", PLAY, 0), "game");
  assert.equal(whenNext([item("1:1", { due: NOW + DAY })], NOW, false), "");
  assert.deepEqual(cubeLook("idle", PLAY, 0, false), { classes: [], title: "Chess Check", count: "0" });
});

test("away from games the cube counts what is due and the panel opens on the review", () => {
  const due = dueNow(queue, HOME, "idle", NOW);
  assert.deepEqual(due.map(i => i.id), ["111:40", "222:29"]);
  assert.deepEqual(cubeLook("idle", HOME, due.length, false),
    { classes: ["due"], title: "Chess Check: 2 positions to review", count: "2" });
  assert.equal(cubeLook("idle", HOME, 14, false).count, "9+");
  assert.equal(panelView("game", "idle", HOME, 2), "review");
  assert.equal(panelView("game", "idle", HOME, 0), "game");
});

test("the dot marks a recap you have not opened, in this tab", () => {
  const s = memory();
  assert.deepEqual(cubeLook("ready", GAME, 0, wasSeen(s, "187502325560")).classes, ["ready"]);
  markSeen(s, "187502325560");
  assert.deepEqual(cubeLook("ready", GAME, 0, wasSeen(s, "187502325560")).classes, ["ready", "seen"]);
  assert.equal(wasSeen(s, "999"), false);
  for (let i = 0; i < 30; i++) markSeen(s, String(i));
  assert.ok(s.data.get("chess-check-seen")!.split(",").length <= 21, "the list stays short");
  // a game page never shows the review count, even with positions due
  assert.ok(!cubeLook("ready", GAME, 3, false).classes.includes("due"));
});

test("'Next review' only when nothing is due now (it once said tomorrow while 4 were due)", () => {
  assert.equal(whenNext(queue, NOW, true), "");
  assert.equal(whenNext([item("1:1", { due: NOW + DAY / 2 })], NOW, true), "Next review tomorrow.");
  assert.equal(whenNext([item("1:1", { due: NOW + 3 * DAY })], NOW, true), "Next review in 3 days.");
  assert.equal(whenNext([item("1:1", { done: true })], NOW, true), "");
});

test("Find it on the board from a review card reopens that card after the page loads, once", () => {
  const s = memory();
  markFind(s, "review", "187502325560", "222:29");
  assert.equal(s.data.get(REVIEW), "222:29");
  assert.equal(s.data.has(REOPEN), false, "a review link does not also reopen the recap");
  assert.equal(takeReview(s, "111"), null, "another game's page leaves it");
  assert.equal(takeReview(s, "222"), "222:29");
  assert.equal(takeReview(s, "222"), null, "only once");
});

test("Find it on the board from a recap reopens the recap, once", () => {
  const s = memory();
  markFind(s, "game", "187502325560", null);
  assert.equal(takeReopen(s, "999"), false);
  assert.equal(takeReopen(s, "187502325560"), true);
  assert.equal(takeReopen(s, "187502325560"), false);
  markFind(s, "game", null, null);
  assert.equal(s.data.size, 0, "nothing to reopen without a game on the page");
});

test("storage that throws (blocked by the page) leaves the panel closed instead of breaking", () => {
  const broken: Store = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
  markFind(broken, "game", "1", null);
  assert.equal(takeReopen(broken, "1"), false);
  assert.equal(takeReview(broken, "1"), null);
  assert.equal(wasSeen(broken, "1"), false);
  markSeen(broken, "1");
});

test("review cards: the board link drops when the board already shows it, and the way back fits the card", () => {
  const due = dueNow(queue, HOME, "idle", NOW);
  const onItsPage = "https://www.chess.com/game/live/222?move=29";
  const first = reviewCard(due, "222:29", "finished", false, onItsPage, { found: 0, missed: 0 }, "");
  assert.ok(first.kind === "card" && first.here && first.position === 2 && first.total === 2);
  assert.equal(first.back, "show", "its own game's recap is offered");
  const other = reviewCard(due, "111:40", "finished", false, onItsPage, { found: 0, missed: 0 }, "");
  assert.ok(other.kind === "card" && !other.here);
  assert.equal(other.back, null, "not under another game's card");
  const sameGameOtherMove = reviewCard(due, "222:29", "finished", false, "https://www.chess.com/game/live/222?move=3", { found: 0, missed: 0 }, "");
  assert.ok(sameGameOtherMove.kind === "card" && !sameGameOtherMove.here);
  const fromRecap = reviewCard(due, null, "ready", true, GAME, { found: 0, missed: 0 }, "");
  assert.equal(fromRecap.back, "back");
  const done = reviewCard([], null, "finished", false, onItsPage, { found: 3, missed: 1 }, "Next review tomorrow.");
  assert.deepEqual(done, { kind: "done", summary: "That's all for now: 3 found, 1 missed. Next review tomorrow.", back: "show" });
  assert.deepEqual(reviewCard([], null, "idle", false, HOME, { found: 0, missed: 0 }, ""),
    { kind: "done", summary: "Nothing to review right now.", back: null });
});
