import assert from "node:assert/strict";
import test from "node:test";

import { BridgeScheduler } from "../../apps/kavita-mal-bridge/src/scheduler.js";

test("scheduler prevents overlapping sync runs", async () => {
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = new BridgeScheduler({
    intervalMs: 1000,
    runSync: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await blocker;
      active--;
    },
  });

  const first = scheduler.runNow();
  const second = scheduler.runNow();
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(maxActive, 1);
  assert.equal(firstResult.skipped, false);
  assert.equal(secondResult.skipped, true);
  assert.equal(scheduler.lastResult?.skipped, false);
});

test("scheduler can be rescheduled without losing its last result", async () => {
  const scheduler = new BridgeScheduler({
    intervalMs: 1000,
    runSync: async () => {},
  });

  await scheduler.runNow();
  scheduler.updateIntervalMs(2500);

  assert.equal(scheduler.currentIntervalMs, 2500);
  assert.equal(scheduler.lastResult?.skipped, false);
});
