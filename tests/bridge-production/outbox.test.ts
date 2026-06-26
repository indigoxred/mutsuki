import assert from "node:assert/strict";
import test from "node:test";

import {
  enqueueMalUpdate,
  processOutboxOnce,
  type BridgeOutboxItem,
  type OutboxStore,
} from "../../apps/kavita-mal-bridge/src/outbox.js";

test("outbox enqueue is idempotent for the same desired MAL update", async () => {
  const store = new MemoryOutboxStore();

  const first = await enqueueMalUpdate(store, {
    kavitaSeriesId: 7,
    malId: 100,
    update: { num_chapters_read: 12 },
    reason: "progress-sync",
  });
  const second = await enqueueMalUpdate(store, {
    kavitaSeriesId: 7,
    malId: 100,
    update: { num_chapters_read: 12 },
    reason: "progress-sync",
  });

  assert.equal(first.id, second.id);
  assert.equal(store.items.length, 1);
});

test("outbox marks dry-run writes successful without calling MAL", async () => {
  const store = new MemoryOutboxStore();
  await enqueueMalUpdate(store, {
    kavitaSeriesId: 7,
    malId: 100,
    update: { num_chapters_read: 12 },
    reason: "progress-sync",
  });

  const result = await processOutboxOnce({
    store,
    dryRun: true,
    updateMal: async () => {
      throw new Error("should not be called");
    },
  });

  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(store.items[0]?.status, "succeeded");
  assert.equal(store.pushed.length, 0);
});

test("outbox records high-water pushed progress after successful MAL writes", async () => {
  const store = new MemoryOutboxStore();
  await enqueueMalUpdate(store, {
    kavitaSeriesId: 7,
    malId: 100,
    update: { num_chapters_read: 12, num_volumes_read: 3 },
    reason: "progress-sync",
  });

  const result = await processOutboxOnce({
    store,
    dryRun: false,
    updateMal: async () => ({ ok: true }),
  });

  assert.equal(result.succeeded, 1);
  assert.deepEqual(store.pushed, [
    {
      kavitaSeriesId: 7,
      update: { num_chapters_read: 12, num_volumes_read: 3 },
    },
  ]);
});

test("outbox keeps retryable MAL failures pending", async () => {
  const store = new MemoryOutboxStore();
  await enqueueMalUpdate(store, {
    kavitaSeriesId: 7,
    malId: 100,
    update: { num_chapters_read: 12 },
    reason: "progress-sync",
  });

  const result = await processOutboxOnce({
    store,
    dryRun: false,
    updateMal: async () => ({ ok: false, retryable: true }),
  });

  assert.equal(result.processed, 1);
  assert.equal(result.failed, 1);
  assert.equal(store.items[0]?.status, "pending");
  assert.equal(store.items[0]?.attempts, 1);
});

class MemoryOutboxStore implements OutboxStore {
  readonly items: BridgeOutboxItem[] = [];
  readonly pushed: { kavitaSeriesId: number; update: BridgeOutboxItem["update"] }[] = [];

  async findByDedupKey(dedupKey: string): Promise<BridgeOutboxItem | undefined> {
    return this.items.find((item) => item.dedupKey === dedupKey);
  }

  async insert(item: BridgeOutboxItem): Promise<void> {
    this.items.push(item);
  }

  async pending(limit: number): Promise<BridgeOutboxItem[]> {
    return this.items.filter((item) => item.status === "pending").slice(0, limit);
  }

  async update(item: BridgeOutboxItem): Promise<void> {
    const index = this.items.findIndex((existing) => existing.id === item.id);
    if (index >= 0) this.items[index] = item;
  }

  async recordPushedProgress(
    kavitaSeriesId: number,
    update: BridgeOutboxItem["update"],
  ): Promise<void> {
    this.pushed.push({ kavitaSeriesId, update });
  }
}
