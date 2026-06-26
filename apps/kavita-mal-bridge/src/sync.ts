import {
  matchKavitaSeriesToMal,
  type KavitaSeriesCandidate,
  type MalSearchCandidate,
} from "./matching.js";
import { enqueueMalUpdate, processOutboxOnce } from "./outbox.js";
import {
  defaultTrackingPolicyForSeries,
  planBridgeMalUpdate,
  type BridgeMalProgressUpdate,
  type MalListProgress,
} from "./policy.js";
import type { SeriesMappingRecord, SqliteBridgeStore } from "./storage.js";

export interface BridgeObservedSeries extends KavitaSeriesCandidate {
  kavitaLibraryId?: number;
  contentType: "manga" | "novel" | undefined;
  completedChapter?: number;
  completedVolume?: number;
  isSpecial: boolean;
}

export interface BridgeKavitaClient {
  listSeries(): Promise<BridgeObservedSeries[]>;
}

export interface BridgeMalClient {
  searchManga(series: BridgeObservedSeries): Promise<MalSearchCandidate[]>;
  getCurrentProgress(malId: number): Promise<MalListProgress>;
  updateProgress(
    malId: number,
    update: BridgeMalProgressUpdate,
  ): Promise<{ ok: true } | { ok: false; retryable: boolean; message?: string }>;
}

export interface BridgeSyncResult {
  seriesSeen: number;
  autoMatched: number;
  reviewQueued: number;
  updatesQueued: number;
  outboxProcessed: number;
  outboxSucceeded: number;
  outboxFailed: number;
}

export async function runBridgeSyncOnce(input: {
  store: SqliteBridgeStore;
  kavita: BridgeKavitaClient;
  mal: BridgeMalClient;
  dryRun: boolean;
}): Promise<BridgeSyncResult> {
  const result: BridgeSyncResult = {
    seriesSeen: 0,
    autoMatched: 0,
    reviewQueued: 0,
    updatesQueued: 0,
    outboxProcessed: 0,
    outboxSucceeded: 0,
    outboxFailed: 0,
  };

  const series = await input.kavita.listSeries();
  result.seriesSeen = series.length;

  for (const item of series) {
    let mapping = await input.store.getSeriesMapping(item.kavitaSeriesId);
    if (!mapping) {
      mapping = await createMappingOrReview(input.store, input.mal, item);
      if (!mapping) {
        result.reviewQueued++;
        continue;
      }
      result.autoMatched++;
    }

    const policy = policyFromMapping(mapping, item.contentType);
    const current = await input.mal.getCurrentProgress(mapping.malId);
    const update = planBridgeMalUpdate({
      observed: {
        kavitaCompletedChapter: item.completedChapter,
        kavitaCompletedVolume: item.completedVolume,
        isSpecial: item.isSpecial,
      },
      current,
      policy,
    });

    await input.store.upsertSeriesMapping({
      ...mapping,
      lastObservedChapter: Math.max(mapping.lastObservedChapter, item.completedChapter ?? 0),
      lastObservedVolume: Math.max(mapping.lastObservedVolume, item.completedVolume ?? 0),
    });

    if (!update) continue;
    await enqueueMalUpdate(input.store, {
      kavitaSeriesId: item.kavitaSeriesId,
      malId: mapping.malId,
      update,
      reason: "kavita-progress-poll",
    });
    result.updatesQueued++;
  }

  const outboxResult = await processOutboxOnce({
    store: input.store,
    dryRun: input.dryRun,
    updateMal: (malId, update) => input.mal.updateProgress(malId, update),
  });
  result.outboxProcessed = outboxResult.processed;
  result.outboxSucceeded = outboxResult.succeeded;
  result.outboxFailed = outboxResult.failed;
  return result;
}

async function createMappingOrReview(
  store: SqliteBridgeStore,
  mal: BridgeMalClient,
  series: BridgeObservedSeries,
): Promise<SeriesMappingRecord | undefined> {
  let decision = matchKavitaSeriesToMal({ series, searchCandidates: [] });
  if (decision.status === "review" && decision.reason === "no-candidates") {
    decision = matchKavitaSeriesToMal({
      series,
      searchCandidates: await mal.searchManga(series),
    });
  }

  if (decision.status === "review") {
    await store.enqueueReview({
      kavitaSeriesId: series.kavitaSeriesId,
      title: series.title,
      reason: decision.reason,
      candidatesJson: JSON.stringify(decision.candidates),
    });
    await store.audit({
      type: "review",
      kavitaSeriesId: series.kavitaSeriesId,
      message: `Queued for review: ${decision.reason}`,
    });
    return undefined;
  }

  const policy = defaultTrackingPolicyForSeries(series.contentType);
  const record: SeriesMappingRecord = {
    kavitaSeriesId: series.kavitaSeriesId,
    kavitaLibraryId: series.kavitaLibraryId ?? series.libraryId,
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
  await store.upsertSeriesMapping(record);
  await store.audit({
    type: "match",
    kavitaSeriesId: series.kavitaSeriesId,
    message: `Auto-linked MAL ${decision.malId} via ${decision.matchMethod}`,
  });
  return record;
}

function policyFromMapping(
  mapping: SeriesMappingRecord,
  contentType: "manga" | "novel" | undefined,
): ReturnType<typeof defaultTrackingPolicyForSeries> {
  const defaults = defaultTrackingPolicyForSeries(contentType);
  return {
    ...defaults,
    trackingMode: mapping.trackingMode,
    chapterOffset: mapping.chapterOffset,
    volumeOffset: mapping.volumeOffset,
  };
}
