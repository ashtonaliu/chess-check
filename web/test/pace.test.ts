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

test("builds running together share one budget, and a stutter eases all of them", async () => {
  const { SharedPace } = await import("../src/browser/pace");
  const clock = { t: 0 };
  const shared = new SharedPace(new Pace({ max: 8, start: 8, now: () => clock.t }));
  const blitz = shared.join();
  assert.equal(blitz.active(), 8, "alone it gets the whole budget");
  const rapid = shared.join();
  assert.equal(blitz.active() + rapid.active(), 8, "together they stay within it, not 16");
  shared.pace.stall();
  assert.ok(blitz.active() + rapid.active() <= 7, "the stutter reaches both builds");
  rapid.leave(); rapid.leave();
  assert.equal(shared.builds, 1, "leaving twice counts once");
  assert.equal(blitz.active(), 7);
  // never starved: each build keeps at least one worker
  const many = [shared.join(), shared.join(), shared.join(), shared.join(), shared.join(), shared.join(), shared.join(), shared.join()];
  assert.ok(many.every(b => b.active() >= 1));
});
