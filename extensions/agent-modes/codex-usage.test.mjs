import assert from "node:assert/strict";
import test from "node:test";
import { FiveHourWarningTracker } from "../codex-usage.ts";

function snapshot(usedPercent, resetAtMs, windowSeconds = 5 * 60 * 60) {
  return {
    primary: { usedPercent, resetAtMs, windowSeconds },
    resetCredits: 0,
    fetchedAt: Date.now(),
  };
}

test("five-hour warning fires at 10% remaining once per reset window", () => {
  const tracker = new FiveHourWarningTracker();
  const firstReset = Date.now() + 60 * 60_000;

  assert.equal(tracker.take(snapshot(89, firstReset)), undefined);
  assert.equal(tracker.take(snapshot(90, firstReset))?.usedPercent, 90);
  assert.equal(tracker.take(snapshot(97, firstReset)), undefined);

  const nextReset = firstReset + 5 * 60 * 60_000;
  assert.equal(tracker.take(snapshot(4, nextReset)), undefined);
  assert.equal(tracker.take(snapshot(91, nextReset))?.usedPercent, 91);
});

test("weekly usage never triggers the five-hour warning", () => {
  const tracker = new FiveHourWarningTracker();
  const weekly = snapshot(99, Date.now() + 24 * 60 * 60_000, 7 * 24 * 60 * 60);
  assert.equal(tracker.take(weekly), undefined);
});
