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

export interface EnqueuedMalUpdate extends BridgeOutboxItem {
  wasCreated: boolean;
}

export interface OutboxAuditRecord {
  kavitaSeriesId: number;
  malId: number;
  message: string;
  update: BridgeMalProgressUpdate;
  status: OutboxStatus;
  attempts: number;
  reason: string;
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
): Promise<EnqueuedMalUpdate> {
  const dedupKey = stableDedupKey(input);
  const existing = await store.findByDedupKey(dedupKey);
  if (existing) return { ...existing, wasCreated: false };
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
  return { ...item, wasCreated: true };
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
  audit?: (record: OutboxAuditRecord) => Promise<void>;
}): Promise<{ processed: number; previewed: number; succeeded: number; failed: number }> {
  const pending = await input.store.pending(input.limit ?? 25);
  let previewed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const item of pending) {
    if (input.dryRun) {
      await auditOutbox(input.audit, item, "Dry-run MAL update previewed.");
      previewed++;
      continue;
    }

    const result = await input.updateMal(item.malId, item.update);
    if (result.ok) {
      await input.store.recordPushedProgress?.(item.kavitaSeriesId, item.update);
      const updated = markSucceeded(item, input.now?.() ?? new Date(), "");
      await input.store.update(updated);
      await auditOutbox(input.audit, updated, "MAL update pushed.");
      succeeded++;
    } else if (!result.retryable) {
      const updated = markSucceeded(item, input.now?.() ?? new Date(), result.message);
      await input.store.update(updated);
      await auditOutbox(input.audit, updated, "Permanent MAL update failure recorded.");
      succeeded++;
    } else {
      const updated = markFailedRetryable(item, input.now?.() ?? new Date(), result.message);
      await input.store.update(updated);
      await auditOutbox(input.audit, updated, "Retryable MAL update failure.");
      failed++;
    }
  }

  return { processed: pending.length, previewed, succeeded, failed };
}

async function auditOutbox(
  audit: ((record: OutboxAuditRecord) => Promise<void>) | undefined,
  item: BridgeOutboxItem,
  message: string,
): Promise<void> {
  await audit?.({
    kavitaSeriesId: item.kavitaSeriesId,
    malId: item.malId,
    message,
    update: item.update,
    status: item.status,
    attempts: item.attempts,
    reason: item.reason,
  });
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
