// Follow mode: stopping is final, and a recap that fails is retried instead of being skipped.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Follower, MAX_ATTEMPTS, type Profile } from "../src/browser/follow";
import type { Game } from "../src/browser/games";
import type { Recap } from "../src/browser/recap";

const profile: Profile = { username: "me", timeClass: "blitz", rows: [], openings: [], tactics: null };
const game = (id: string, endTime: number) => ({ url: `https://www.chess.com/game/live/${id}`, endTime, opponent: "them" }) as Game;
const fakeRecap = (g: Game) => ({ url: g.url }) as Recap;

class TestFollower extends Follower {
  failNext = 0;
  recap(g: Game): Promise<Recap> {
    if (this.failNext > 0) { this.failNext--; return Promise.reject(new Error("engine failed")); }
    return Promise.resolve(fakeRecap(g));
  }
}

test("stopping while the first fetch is pending is final", async () => {
  let release!: (games: Game[]) => void;
  const pending = new Promise<Game[]>(r => { release = r; });
  const statuses: string[] = [], recaps: Recap[] = [];
  const f = new TestFollower(profile, "", r => recaps.push(r), s => statuses.push(s), () => pending);
  const started = f.start();
  f.stop();
  release([game("1", 100)]);
  await started;
  assert.equal(f.running, false);
  assert.deepEqual(recaps, []);
  assert.deepEqual(statuses, ["stopped"]);
});

test("a failed recap is retried on the next check, then skipped after repeated failures", async () => {
  const recaps: Recap[] = [];
  const games = [game("2", 200)];
  const f = new TestFollower(profile, "", r => recaps.push(r), () => {}, async () => games);
  f.failNext = 1;
  await f.check();
  assert.equal(recaps.length, 0);
  await f.check();                       // retried, and delivered this time
  assert.deepEqual(recaps.map(r => r.url), [games[0].url]);
  await f.check();                       // delivered games are not shown twice
  assert.equal(recaps.length, 1);

  const bad = [game("3", 300)];
  const g = new TestFollower(profile, "", r => recaps.push(r), () => {}, async () => bad);
  g.failNext = 99;
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await g.check();
  assert.equal(g.failNext, 99 - MAX_ATTEMPTS);   // tried MAX_ATTEMPTS times, then left alone
  g.stop();
});
