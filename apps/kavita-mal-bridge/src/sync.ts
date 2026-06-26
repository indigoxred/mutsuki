import {
  matchKavitaSeriesToMal,
  type KavitaSeriesCandidate,
  type MalSearchCandidate,
  type MatchMethod,
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
  listSeries(options?: { limit?: number }): Promise<BridgeObservedSeries[]>;
}

export interface BridgeMalClient {
  searchManga(series: BridgeObservedSeries): Promise<MalSearchCandidate[]>;
  getCurrentProgress(malId: number): Promise<MalListProgress>;
  updateProgress(
    malId: number,
    update: BridgeMalProgressUpdate,
  ): Promise<{ ok: true } | { ok: false; retryable: boolean; message?: string }>;
}

export interface BridgeExternalIdResolver {
  resolveMalId(
    series: BridgeObservedSeries,
  ): Promise<{ malId: number; matchMethod: MatchMethod; confidence: number } | undefined>;
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
  externalIdResolver?: BridgeExternalIdResolver;
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
    if (await input.store.isSeriesIgnored(item.kavitaSeriesId)) continue;

    let mapping = await input.store.getSeriesMapping(item.kavitaSeriesId);
    if (!mapping) {
      mapping = await createMappingOrReview(input.store, input.mal, item, input.externalIdResolver);
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
    const queued = await enqueueMalUpdate(input.store, {
      kavitaSeriesId: item.kavitaSeriesId,
      malId: mapping.malId,
      update,
      reason: "kavita-progress-poll",
    });
    if (queued.wasCreated) {
      result.updatesQueued++;
      await input.store.audit({
        type: "progress",
        kavitaSeriesId: item.kavitaSeriesId,
        message: `Queued MAL progress update for ${mapping.malId}.`,
        dataJson: JSON.stringify({
          malId: mapping.malId,
          update,
          reason: queued.reason,
        }),
      });
    }
  }

  const outboxResult = await processOutboxOnce({
    store: input.store,
    dryRun: input.dryRun,
    updateMal: (malId, update) => input.mal.updateProgress(malId, update),
    audit: (record) =>
      input.store.audit({
        type: "outbox",
        kavitaSeriesId: record.kavitaSeriesId,
        message: record.message,
        dataJson: JSON.stringify({
          malId: record.malId,
          update: record.update,
          status: record.status,
          attempts: record.attempts,
          reason: record.reason,
        }),
      }),
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
  externalIdResolver: BridgeExternalIdResolver | undefined,
): Promise<SeriesMappingRecord | undefined> {
  let decision = matchKavitaSeriesToMal({ series, searchCandidates: [] });
  if (decision.status === "review" && decision.reason === "no-candidates" && externalIdResolver) {
    const externalMatch = await externalIdResolver.resolveMalId(series).catch(() => undefined);
    if (externalMatch) {
      decision = {
        status: "matched",
        malId: externalMatch.malId,
        matchMethod: externalMatch.matchMethod,
        confidence: externalMatch.confidence,
      };
    }
  }
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
    title: series.title,
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
