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
  searchDeferred?: number;
  updatesQueued: number;
  outboxProcessed: number;
  outboxPreviewed?: number;
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
    searchDeferred: 0,
    updatesQueued: 0,
    outboxProcessed: 0,
    outboxPreviewed: 0,
    outboxSucceeded: 0,
    outboxFailed: 0,
  };

  const series = await input.kavita.listSeries();
  result.seriesSeen = series.length;

  for (const item of series) {
    if (await input.store.isSeriesIgnored(item.kavitaSeriesId)) continue;

    let mapping = await input.store.getSeriesMapping(item.kavitaSeriesId);
    if (!mapping) {
      const mappingResult = await createMappingOrReview(
        input.store,
        input.mal,
        item,
        input.externalIdResolver,
      );
      if (mappingResult.status === "deferred") {
        result.searchDeferred = (result.searchDeferred ?? 0) + 1;
        continue;
      }
      mapping = mappingResult.mapping;
      if (mappingResult.status === "review") {
        result.reviewQueued++;
        continue;
      }
      result.autoMatched++;
    }
    if (!mapping) continue;

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
  result.outboxPreviewed = outboxResult.previewed;
  result.outboxSucceeded = outboxResult.succeeded;
  result.outboxFailed = outboxResult.failed;
  return result;
}

async function createMappingOrReview(
  store: SqliteBridgeStore,
  mal: BridgeMalClient,
  series: BridgeObservedSeries,
  externalIdResolver: BridgeExternalIdResolver | undefined,
): Promise<
  | { status: "mapped"; mapping: SeriesMappingRecord }
  | { status: "review"; mapping?: undefined }
  | { status: "deferred"; mapping?: undefined }
> {
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
    let searchCandidates: MalSearchCandidate[];
    try {
      searchCandidates = await mal.searchManga(series);
    } catch (error) {
      const status = retryableMalSearchStatus(error);
      if (status === undefined) throw error;
      await store.audit({
        type: "system",
        kavitaSeriesId: series.kavitaSeriesId,
        message: `Deferred MAL search after retryable status ${status}.`,
      });
      return { status: "deferred" };
    }
    decision = matchKavitaSeriesToMal({
      series,
      searchCandidates,
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
    return { status: "review" };
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
  return { status: "mapped", mapping: record };
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

function retryableMalSearchStatus(error: unknown): number | undefined {
  const statusFromProperty =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
  const status =
    statusFromProperty !== undefined && Number.isFinite(statusFromProperty)
      ? statusFromProperty
      : statusFromMessage(error);
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) return status;
  return undefined;
}

function statusFromMessage(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /\bstatus\s+([0-9]{3})\b/iu.exec(message);
  return match?.[1] ? Number(match[1]) : undefined;
}
