import type { BridgeMalProgressUpdate } from "./policy.js";

export type OutboxStatus = "pending" | "succeeded" | "failed";

export interface BridgeOutboxItem {
  id: string;
  kavitaSeriesId: number;
  malId: number;
  update: BridgeMalProgressUpdate;
  reason: string;
  dedupKey: string;
  status: OutboxStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxStore {
  findByDedupKey(dedupKey: string): Promise<BridgeOutboxItem | undefined>;
  insert(item: BridgeOutboxItem): Promise<void>;
  pending(limit: number): Promise<BridgeOutboxItem[]>;
  update(item: BridgeOutboxItem): Promise<void>;
  recordPushedProgress?(kavitaSeriesId: number, update: BridgeMalProgressUpdate): Promise<void>;
}

export async function enqueueMalUpdate(
  store: OutboxStore,
  input: {
    kavitaSeriesId: number;
    malId: number;
    update: BridgeMalProgressUpdate;
    reason: string;
    now?: Date;
  },
): Promise<BridgeOutboxItem> {
  const dedupKey = stableDedupKey(input);
  const existing = await store.findByDedupKey(dedupKey);
  if (existing) return existing;
  const now = (input.now ?? new Date()).toISOString();
  const item: BridgeOutboxItem = {
    id: `outbox:${hashString(dedupKey)}`,
    kavitaSeriesId: input.kavitaSeriesId,
    malId: input.malId,
    update: input.update,
    reason: input.reason,
    dedupKey,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  await store.insert(item);
  return item;
}

export async function processOutboxOnce(input: {
  store: OutboxStore;
  updateMal: (
    malId: number,
    update: BridgeMalProgressUpdate,
  ) => Promise<{ ok: true } | { ok: false; retryable: boolean; message?: string }>;
  dryRun: boolean;
  limit?: number;
  now?: () => Date;
}): Promise<{ processed: number; succeeded: number; failed: number }> {
  const pending = await input.store.pending(input.limit ?? 25);
  let succeeded = 0;
  let failed = 0;

  for (const item of pending) {
    if (input.dryRun) {
      await input.store.update(markSucceeded(item, input.now?.() ?? new Date(), "dry-run"));
      succeeded++;
      continue;
    }

    const result = await input.updateMal(item.malId, item.update);
    if (result.ok) {
      await input.store.recordPushedProgress?.(item.kavitaSeriesId, item.update);
      await input.store.update(markSucceeded(item, input.now?.() ?? new Date(), ""));
      succeeded++;
    } else if (!result.retryable) {
      await input.store.update(markSucceeded(item, input.now?.() ?? new Date(), result.message));
      succeeded++;
    } else {
      await input.store.update(
        markFailedRetryable(item, input.now?.() ?? new Date(), result.message),
      );
      failed++;
    }
  }

  return { processed: pending.length, succeeded, failed };
}

function markSucceeded(
  item: BridgeOutboxItem,
  now: Date,
  note: string | undefined,
): BridgeOutboxItem {
  return {
    ...item,
    status: "succeeded",
    lastError: note || undefined,
    updatedAt: now.toISOString(),
  };
}

function markFailedRetryable(
  item: BridgeOutboxItem,
  now: Date,
  message: string | undefined,
): BridgeOutboxItem {
  return {
    ...item,
    attempts: item.attempts + 1,
    lastError: sanitizeMessage(message ?? "Retryable MAL update failure."),
    updatedAt: now.toISOString(),
  };
}

function stableDedupKey(input: {
  kavitaSeriesId: number;
  malId: number;
  update: BridgeMalProgressUpdate;
}): string {
  const update = Object.keys(input.update)
    .sort()
    .map((key) => `${key}:${String(input.update[key as keyof BridgeMalProgressUpdate])}`)
    .join("|");
  return `${input.kavitaSeriesId}:${input.malId}:${update}`;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sanitizeMessage(message: string): string {
  return message.replace(/Bearer\s+\S+/giu, "Bearer redacted").slice(0, 240);
}
