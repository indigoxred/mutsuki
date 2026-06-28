import { matchKavitaSeriesToMal, type MalSearchCandidate } from "./matching.js";
import { enqueueMalUpdate } from "./outbox.js";
import {
  defaultTrackingPolicyForSeries,
  planBridgeMalUpdate,
  type BridgeMalProgressUpdate,
  type MalListProgress,
} from "./policy.js";
import type { BridgeReadEventRecord, SourcePolicyRecord } from "./progress-events.js";
import type { ExternalSeriesMappingRecord, SqliteBridgeStore } from "./storage.js";
import type { BridgeObservedSeries } from "./sync.js";

export interface ExternalReadEventMalClient {
  searchManga(series: BridgeObservedSeries): Promise<MalSearchCandidate[]>;
  getCurrentProgress(malId: number): Promise<MalListProgress>;
  updateProgress(
    malId: number,
    update: BridgeMalProgressUpdate,
  ): Promise<{ ok: true } | { ok: false; retryable: boolean; message?: string }>;
}

export type ExternalReadEventProcessResult =
  | { status: "queued"; malId: number; outboxId: string }
  | { status: "review"; reason: string }
  | {
      status: "skipped";
      reason:
        | "not-external-event"
        | "source-policy-disabled"
        | "external-series-ignored"
        | "review-pending"
        | "no-progress-update";
    };

export async function processExternalReadEvent(input: {
  store: SqliteBridgeStore;
  mal: ExternalReadEventMalClient;
  event: BridgeReadEventRecord;
  policy: SourcePolicyRecord;
}): Promise<ExternalReadEventProcessResult> {
  const { event, policy, store } = input;
  if (event.readingSourceKind !== "external") {
    return { status: "skipped", reason: "not-external-event" };
  }
  if (!policy.malEnabled) {
    await store.audit({
      type: "progress",
      message: `Skipped external read event from ${event.readingSourceId}; MAL disabled for source.`,
      dataJson: JSON.stringify(eventAuditData(event)),
    });
    return { status: "skipped", reason: "source-policy-disabled" };
  }
  if (await store.isExternalSeriesIgnored(event.readingSourceId, event.sourceMangaId)) {
    return { status: "skipped", reason: "external-series-ignored" };
  }

  let mapping = await store.getExternalSeriesMapping(event.readingSourceId, event.sourceMangaId);
  if (!mapping) {
    if (await store.getExternalReview(event.readingSourceId, event.sourceMangaId)) {
      return { status: "skipped", reason: "review-pending" };
    }
    const result = await createExternalMappingOrReview(input);
    if (result.status === "review") return result;
    mapping = result.mapping;
  }

  const policyForMapping = {
    ...defaultTrackingPolicyForSeries("manga" as const),
    trackingMode: mapping.trackingMode,
    chapterOffset: mapping.chapterOffset,
    volumeOffset: mapping.volumeOffset,
  };
  const current = await input.mal.getCurrentProgress(mapping.malId);
  const update = planBridgeMalUpdate({
    observed: {
      kavitaCompletedChapter: event.sourceChapterNumber,
      kavitaCompletedVolume: event.sourceChapterVolume,
      isSpecial: false,
    },
    current,
    policy: policyForMapping,
  });

  await store.upsertExternalSeriesMapping({
    ...mapping,
    lastObservedChapter: Math.max(mapping.lastObservedChapter, event.sourceChapterNumber),
    lastObservedVolume: Math.max(mapping.lastObservedVolume, event.sourceChapterVolume ?? 0),
  });

  if (!update) {
    await store.audit({
      type: "progress",
      message: `External read event from ${event.readingSourceId} produced no MAL progress update.`,
      dataJson: JSON.stringify(eventAuditData(event)),
    });
    return { status: "skipped", reason: "no-progress-update" };
  }

  const targetKey = externalTargetKey(event.readingSourceId, event.sourceMangaId);
  const queued = await enqueueMalUpdate(store, {
    kavitaSeriesId: legacyExternalSeriesId(targetKey),
    targetType: "external",
    targetKey,
    targetTitle: mapping.title,
    malId: mapping.malId,
    update,
    reason: "paperback-external-read-event",
  });
  if (queued.wasCreated) {
    await store.audit({
      type: "progress",
      message: `Queued MAL progress update from ${event.readingSourceId} read event.`,
      dataJson: JSON.stringify({
        ...eventAuditData(event),
        malId: mapping.malId,
        update,
        targetKey,
      }),
    });
  }
  return { status: "queued", malId: mapping.malId, outboxId: queued.id };
}

async function createExternalMappingOrReview(input: {
  store: SqliteBridgeStore;
  mal: ExternalReadEventMalClient;
  event: BridgeReadEventRecord;
}): Promise<
  { status: "mapped"; mapping: ExternalSeriesMappingRecord } | { status: "review"; reason: string }
> {
  const series = observedSeriesFromExternalEvent(input.event);
  const searchCandidates = input.event.sourceTitle.trim()
    ? await input.mal.searchManga(series)
    : [];
  const decision = matchKavitaSeriesToMal({ series, searchCandidates });
  if (decision.status === "review") {
    await input.store.enqueueExternalReview({
      readingSourceId: input.event.readingSourceId,
      sourceMangaId: input.event.sourceMangaId,
      readingSourceName: input.event.readingSourceName,
      title: externalTitle(input.event),
      reason: decision.reason,
      candidatesJson: JSON.stringify(decision.candidates),
    });
    await input.store.audit({
      type: "review",
      message: `Queued external source match for review: ${input.event.readingSourceName}.`,
      dataJson: JSON.stringify({
        ...eventAuditData(input.event),
        reason: decision.reason,
      }),
    });
    return { status: "review", reason: decision.reason };
  }

  const policy = defaultTrackingPolicyForSeries("manga");
  const mapping: ExternalSeriesMappingRecord = {
    readingSourceId: input.event.readingSourceId,
    sourceMangaId: input.event.sourceMangaId,
    readingSourceName: input.event.readingSourceName,
    title: externalTitle(input.event),
    malId: decision.malId,
    matchMethod: decision.matchMethod,
    confidence: decision.confidence,
    locked: false,
    chapterOffset: policy.chapterOffset,
    volumeOffset: policy.volumeOffset,
    trackingMode: policy.trackingMode,
    lastObservedChapter: 0,
    lastObservedVolume: 0,
    lastPushedChapter: 0,
    lastPushedVolume: 0,
  };
  await input.store.upsertExternalSeriesMapping(mapping);
  await input.store.deleteExternalReview(input.event.readingSourceId, input.event.sourceMangaId);
  await input.store.audit({
    type: "match",
    message: `Auto-linked external source title to MAL ${decision.malId} via ${decision.matchMethod}.`,
    dataJson: JSON.stringify({
      ...eventAuditData(input.event),
      malId: decision.malId,
      confidence: decision.confidence,
    }),
  });
  return { status: "mapped", mapping };
}

function observedSeriesFromExternalEvent(event: BridgeReadEventRecord): BridgeObservedSeries {
  return {
    kavitaSeriesId: legacyExternalSeriesId(
      externalTargetKey(event.readingSourceId, event.sourceMangaId),
    ),
    title: externalTitle(event),
    contentType: "manga",
    mediaType: "manga",
    completedChapter: event.sourceChapterNumber,
    completedVolume: event.sourceChapterVolume,
    isSpecial: false,
  };
}

function externalTitle(event: BridgeReadEventRecord): string {
  return event.sourceTitle.trim() || event.sourceMangaId;
}

export function externalTargetKey(readingSourceId: string, sourceMangaId: string): string {
  return `external:${encodeURIComponent(readingSourceId)}:${encodeURIComponent(sourceMangaId)}`;
}

function legacyExternalSeriesId(targetKey: string): number {
  const hash = hashString(targetKey);
  const numeric = Number.parseInt(hash.slice(0, 7), 16);
  return -Math.max(1, numeric);
}

function eventAuditData(event: BridgeReadEventRecord): Record<string, unknown> {
  return {
    actionId: event.actionId,
    readingSourceId: event.readingSourceId,
    readingSourceKind: event.readingSourceKind,
    sourceMangaId: event.sourceMangaId,
    sourceChapterId: event.sourceChapterId,
    sourceChapterNumber: event.sourceChapterNumber,
    sourceChapterVolume: event.sourceChapterVolume,
  };
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
