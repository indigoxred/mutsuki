import assert from "node:assert/strict";
import test from "node:test";

import { createKavitaMalBridgeServer } from "../../apps/kavita-mal-bridge/src/server.js";
import { SqliteBridgeStore } from "../../apps/kavita-mal-bridge/src/storage.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("bridge server exposes status and unresolved review API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-server-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  await store.enqueueReview({
    kavitaSeriesId: 99,
    title: "Needs Review",
    reason: "ambiguous-or-low-confidence",
    candidatesJson: "[]",
  });

  const server = createKavitaMalBridgeServer({
    store,
    dryRun: true,
    runSync: async () => ({
      seriesSeen: 0,
      autoMatched: 0,
      reviewQueued: 0,
      updatesQueued: 0,
      outboxProcessed: 0,
      outboxSucceeded: 0,
      outboxFailed: 0,
    }),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.equal(typeof address, "object");
    const port = address && typeof address === "object" ? address.port : 0;

    const status = await fetchJson(`http://127.0.0.1:${port}/api/status`);
    const reviews = await fetchJson(`http://127.0.0.1:${port}/api/unresolved-matches`);

    assert.equal(status.dryRun, true);
    assert.equal(reviews.items.length, 1);
    assert.equal(reviews.items[0].title, "Needs Review");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}
