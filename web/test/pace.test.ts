// The adaptive worker count for background profile builds.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Pace, startingWorkers } from "../src/browser/pace";

test("a build starts from the remembered count, else the usual count, within 1..max", () => {
  assert.equal(startingWorkers(8, null), 8);
  assert.equal(startingWorkers(3, null), 3);
  assert.equal(startingWorkers(8, 5), 5);
  assert.equal(startingWorkers(3, 7), 3);
  assert.equal(startingWorkers(3, 0), 1);
});

test("a stutter drops a worker for the rest of the build, and a burst counts once", () => {
  const clock = { t: 0 };
  const p = new Pace({ max: 8, start: 8, now: () => clock.t });
  p.stall(); p.stall(); p.stall();
  assert.equal(p.active(), 7);
  clock.t += 5000; p.stall();
  assert.equal(p.active(), 6);
  for (let i = 0; i < 20; i++) { clock.t += 5000; p.stall(); }
  assert.equal(p.active(), 1, "never below one worker");
});

test("after a stutter the lower count is remembered; a calm build wins one back, up to the usual count", () => {
  const clock = { t: 0 };
  const stuttered = new Pace({ max: 8, start: 8, now: () => clock.t });
  stuttered.stall();
  assert.equal(stuttered.remember, 7);
  // the next builds on this device, with no stutter, climb back one at a time
  let remembered = stuttered.remember;
  const seen = [];
  for (let build = 0; build < 3; build++) {
    const p = new Pace({ max: 8, start: startingWorkers(8, remembered) });
    seen.push(p.active());
    remembered = p.remember;
  }
  assert.deepEqual(seen, [7, 8, 8]);
  assert.equal(remembered, 8);
});

test("a device that never stutters keeps the usual count, so nobody is slower than before", () => {
  const p = new Pace({ max: 8, start: startingWorkers(8, null) });
  assert.equal(p.active(), 8);
  assert.equal(p.remember, 8);
});

test("one worker is all a one-core machine gets", () => {
  const p = new Pace({ max: 1, start: 4 });
  assert.equal(p.active(), 1);
  p.stall();
  assert.equal(p.active(), 1);
  assert.equal(p.remember, 1);
});

test("builds running together share one set of slots, and never use more than the budget", async () => {
  const { SharedPace } = await import("../src/browser/pace");
  const clock = { t: 0 };
  const shared = new SharedPace(new Pace({ max: 8, start: 1, now: () => clock.t }));
  const blitz = shared.join(), rapid = shared.join();
  // a budget of one: two builds get one slot between them, not one each
  await blitz.acquire();
  let rapidGot = false;
  const waiting = rapid.acquire().then(() => { rapidGot = true; });
  await Promise.resolve();
  assert.equal(shared.inUse, 1);
  assert.equal(rapidGot, false, "the second build waits for the slot");
  blitz.release();
  await waiting;
  assert.equal(rapidGot, true);
  assert.equal(shared.inUse, 1);
  rapid.release();
  assert.equal(shared.inUse, 0);
  rapid.leave(); rapid.leave();
  assert.equal(shared.builds, 1, "leaving twice counts once");
});

test("a stutter lowers the slots for every build, and slots given back above it stay empty", async () => {
  const { SharedPace } = await import("../src/browser/pace");
  const clock = { t: 0 };
  const shared = new SharedPace(new Pace({ max: 4, start: 4, now: () => clock.t }));
  const a = shared.join(), b = shared.join();
  await a.acquire(); await a.acquire(); await b.acquire(); await b.acquire();
  assert.equal(shared.inUse, 4);
  shared.pace.stall(); clock.t += 5000; shared.pace.stall();   // down to 2
  let more = 0;
  const p1 = a.acquire().then(() => { more++; });
  a.release(); a.release();
  await Promise.resolve();
  assert.equal(more, 0, "still at the new limit of 2");
  b.release();
  await p1;
  assert.equal(more, 1);
  assert.equal(shared.inUse, 2);
});

test("a cancelled build stops waiting for a slot", async () => {
  const { SharedPace } = await import("../src/browser/pace");
  const shared = new SharedPace(new Pace({ max: 1, start: 1 }));
  const a = shared.join(), b = shared.join();
  await a.acquire();
  const abort = new AbortController();
  const waiting = b.acquire(abort.signal);
  abort.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  a.release();
  assert.equal(shared.inUse, 0, "the slot was not handed to the cancelled build");
});
