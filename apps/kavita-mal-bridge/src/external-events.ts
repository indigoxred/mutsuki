import { matchKavitaSeriesToMal, type MalSearchCandidate } from "./matching.js";
import { enqueueMalUpdate } from "./outbox.js";
import {
  defaultTrackingPolicyForSeries,
  planBridgeMalUpdate,
  type BridgeMalProgressUpdate,
  type MalListProgress,
} from "./policy.js";
import type { BridgeReadEventRecord, SourcePolicyRecord } from "./progress-events.js";
import {
  hydrateAndMergeCandidates,
  titleVariantsFromExternalEvent,
  type TitleCandidateResolver,
} from "./resolvers/title-resolver.js";
import type { ExternalSeriesMappingRecord, SqliteBridgeStore } from "./storage.js";
import type { BridgeObservedSeries } from "./sync.js";

export interface ExternalReadEventMalClient {
  searchManga(series: BridgeObservedSeries): Promise<MalSearchCandidate[]>;
  getMangaById?(malId: number): Promise<MalSearchCandidate | undefined>;
  getCurrentProgress(malId: number): Promise<MalListProgress>;
  updateProgress(
    malId: number,
    update: BridgeMalProgressUpdate,
  ): Promise<{ ok: true } | { ok: false; retryable: boolean; message?: string }>;
}

export type ExternalTitleResolver = TitleCandidateResolver;

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
  resolver?: ExternalTitleResolver;
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
    const pendingReview = await store.getExternalReview(event.readingSourceId, event.sourceMangaId);
    if (pendingReview && !shouldRefreshPendingExternalReview(event)) {
      return { status: "skipped", reason: "review-pending" };
    }
    if (pendingReview) {
      await store.audit({
        type: "review",
        message: `Refreshing pending external source match for ${event.readingSourceName}.`,
        dataJson: JSON.stringify(eventAuditData(event)),
      });
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
  resolver?: ExternalTitleResolver;
  event: BridgeReadEventRecord;
}): Promise<
  { status: "mapped"; mapping: ExternalSeriesMappingRecord } | { status: "review"; reason: string }
> {
  const series = observedSeriesFromExternalEvent(input.event);
  const titleVariants = titleVariantsFromExternalEvent(input.event);
  const deterministic = await validatedDeterministicMatch(input, series);
  if (deterministic) {
    return {
      status: "mapped",
      mapping: await saveExternalMapping(input, deterministic),
    };
  }
  const discoveredCandidates =
    titleVariants.length > 0
      ? await input.resolver
          ?.discoverCandidates({
            event: input.event,
            series,
            titleVariants,
          })
          .catch(() => [])
      : [];
  const discoveredDeterministic = await validatedResolverMatch(input, discoveredCandidates ?? []);
  if (discoveredDeterministic) {
    return {
      status: "mapped",
      mapping: await saveExternalMapping(input, discoveredDeterministic),
    };
  }
  const officialCandidates = await searchOfficialCandidates(input.mal, series, titleVariants);
  const searchCandidates = await hydrateAndMergeCandidates({
    officialCandidates,
    discoveredCandidates: discoveredCandidates ?? [],
    hydrator: input.mal,
  });
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

  return {
    status: "mapped",
    mapping: await saveExternalMapping(input, {
      malId: decision.malId,
      matchMethod: decision.matchMethod,
      confidence: decision.confidence,
    }),
  };
}

async function saveExternalMapping(
  input: {
    store: SqliteBridgeStore;
    event: BridgeReadEventRecord;
  },
  match: {
    malId: number;
    matchMethod: ExternalSeriesMappingRecord["matchMethod"];
    confidence: number;
  },
): Promise<ExternalSeriesMappingRecord> {
  const policy = defaultTrackingPolicyForSeries("manga");
  const mapping: ExternalSeriesMappingRecord = {
    readingSourceId: input.event.readingSourceId,
    sourceMangaId: input.event.sourceMangaId,
    readingSourceName: input.event.readingSourceName,
    title: externalTitle(input.event),
    malId: match.malId,
    matchMethod: match.matchMethod,
    confidence: match.confidence,
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
    message: `Auto-linked external source title to MAL ${match.malId} via ${match.matchMethod}.`,
    dataJson: JSON.stringify({
      ...eventAuditData(input.event),
      malId: match.malId,
      confidence: match.confidence,
    }),
  });
  return mapping;
}

function observedSeriesFromExternalEvent(event: BridgeReadEventRecord): BridgeObservedSeries {
  return {
    kavitaSeriesId: legacyExternalSeriesId(
      externalTargetKey(event.readingSourceId, event.sourceMangaId),
    ),
    title: externalTitle(event),
    altTitles: event.sourceAltTitles,
    authors: [event.sourceAuthor, event.sourceArtist].filter((value): value is string =>
      Boolean(value),
    ),
    webLinks: event.sourceShareUrl ? [event.sourceShareUrl] : undefined,
    externalIds: event.sourceExternalIds,
    contentType: "manga",
    mediaType: "manga",
    completedChapter: event.sourceChapterNumber,
    completedVolume: event.sourceChapterVolume,
    isSpecial: false,
  };
}

async function validatedDeterministicMatch(
  input: {
    mal: ExternalReadEventMalClient;
    event: BridgeReadEventRecord;
  },
  series: BridgeObservedSeries,
): Promise<
  | {
      malId: number;
      matchMethod: ExternalSeriesMappingRecord["matchMethod"];
      confidence: number;
    }
  | undefined
> {
  const malId = deterministicMalIdFromSeries(series);
  if (malId !== undefined) {
    const hydrated = await input.mal.getMangaById?.(malId).catch(() => undefined);
    if (hydrated) {
      return {
        malId,
        matchMethod: methodForSource(input.event.readingSourceId, "mal-id"),
        confidence: 1,
      };
    }
  }

  const aniListId = deterministicAniListIdFromSeries(series);
  if (aniListId !== undefined) {
    const resolvedMalId = await resolveAniListMalId(aniListId).catch(() => undefined);
    const hydrated =
      resolvedMalId === undefined
        ? undefined
        : await input.mal.getMangaById?.(resolvedMalId).catch(() => undefined);
    if (resolvedMalId !== undefined && hydrated) {
      return {
        malId: resolvedMalId,
        matchMethod: methodForSource(input.event.readingSourceId, "anilist-id"),
        confidence: 1,
      };
    }
  }

  return undefined;
}

async function validatedResolverMatch(
  input: {
    mal: ExternalReadEventMalClient;
  },
  discoveredCandidates: { malId: number; provenance: string[] }[],
): Promise<
  | {
      malId: number;
      matchMethod: ExternalSeriesMappingRecord["matchMethod"];
      confidence: number;
    }
  | undefined
> {
  for (const candidate of discoveredCandidates) {
    const method = deterministicMethodFromProvenance(candidate.provenance);
    if (!method) continue;
    const hydrated = await input.mal.getMangaById?.(candidate.malId).catch(() => undefined);
    if (hydrated) {
      return {
        malId: candidate.malId,
        matchMethod: method,
        confidence: 1,
      };
    }
  }
  return undefined;
}

function deterministicMalIdFromSeries(series: BridgeObservedSeries): number | undefined {
  const direct = positiveIntegerFromUnknown(
    series.externalIds?.mal ??
      series.externalIds?.myanimelist ??
      series.externalIds?.myAnimeList ??
      series.externalIds?.malId,
  );
  if (direct !== undefined) return direct;
  for (const value of externalIdValues(series.externalIds)) {
    const match = /myanimelist\.net\/manga\/(\d+)/iu.exec(value);
    const id = positiveIntegerFromUnknown(match?.[1]);
    if (id !== undefined) return id;
  }
  for (const link of series.webLinks ?? []) {
    const match = /myanimelist\.net\/manga\/(\d+)/iu.exec(link);
    const id = positiveIntegerFromUnknown(match?.[1]);
    if (id !== undefined) return id;
  }
  return undefined;
}

function deterministicAniListIdFromSeries(series: BridgeObservedSeries): number | undefined {
  const direct = positiveIntegerFromUnknown(
    series.externalIds?.anilist ?? series.externalIds?.aniList ?? series.externalIds?.al,
  );
  if (direct !== undefined) return direct;
  for (const value of externalIdValues(series.externalIds)) {
    const match = /anilist\.co\/manga\/(\d+)/iu.exec(value);
    const id = positiveIntegerFromUnknown(match?.[1]);
    if (id !== undefined) return id;
  }
  for (const link of series.webLinks ?? []) {
    const match = /anilist\.co\/manga\/(\d+)/iu.exec(link);
    const id = positiveIntegerFromUnknown(match?.[1]);
    if (id !== undefined) return id;
  }
  return undefined;
}

async function resolveAniListMalId(aniListId: number): Promise<number | undefined> {
  const response = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: "query ($id: Int) { Media(id: $id, type: MANGA) { idMal } }",
      variables: { id: aniListId },
    }),
  });
  if (!response.ok) return undefined;
  const json = (await response.json()) as unknown;
  const data = isRecord(json) ? json.data : undefined;
  const media = isRecord(data) && isRecord(data.Media) ? data.Media : undefined;
  return positiveIntegerFromUnknown(media?.idMal);
}

function deterministicMethodFromProvenance(
  provenance: string[],
): ExternalSeriesMappingRecord["matchMethod"] | undefined {
  const sources = new Set(provenance);
  if (sources.has("weebcentral-mal-id")) return "weebcentral-mal-id";
  if (sources.has("weebcentral-anilist-id")) return "weebcentral-anilist-id";
  if (sources.has("mangadex-mal-id")) return "mangadex-mal-id";
  if (sources.has("mangadex-anilist-id")) return "mangadex-anilist-id";
  if (sources.has("source-mal-id")) return "source-mal-id";
  if (sources.has("source-anilist-id")) return "source-anilist-id";
  return undefined;
}

function methodForSource(
  readingSourceId: string,
  kind: "mal-id" | "anilist-id",
): ExternalSeriesMappingRecord["matchMethod"] {
  if (/mangadex/iu.test(readingSourceId)) {
    return kind === "mal-id" ? "mangadex-mal-id" : "mangadex-anilist-id";
  }
  if (/weeb\s*central|weebcentral/iu.test(readingSourceId)) {
    return kind === "mal-id" ? "weebcentral-mal-id" : "weebcentral-anilist-id";
  }
  return kind === "mal-id" ? "source-mal-id" : "source-anilist-id";
}

function externalIdValues(ids: Record<string, string | number | undefined> | undefined): string[] {
  return Object.values(ids ?? {}).flatMap((value) => (typeof value === "string" ? [value] : []));
}

function positiveIntegerFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function externalTitle(event: BridgeReadEventRecord): string {
  return (
    event.sourcePrimaryTitle?.trim() ||
    event.sourceTitle.trim() ||
    event.sourceAltTitles?.[0] ||
    event.sourceMangaId
  );
}

function shouldRefreshPendingExternalReview(event: BridgeReadEventRecord): boolean {
  return (
    event.schemaVersion >= 3 ||
    Boolean(event.sourcePrimaryTitle) ||
    Boolean(event.sourceAltTitles?.length) ||
    Boolean(event.sourceAuthor) ||
    Boolean(event.sourceArtist) ||
    Boolean(event.sourceShareUrl) ||
    Boolean(event.sourceExternalIds && Object.keys(event.sourceExternalIds).length > 0)
  );
}

async function searchOfficialCandidates(
  mal: ExternalReadEventMalClient,
  series: BridgeObservedSeries,
  titleVariants: string[],
): Promise<MalSearchCandidate[]> {
  const variants = titleVariants.length > 0 ? titleVariants : [series.title].filter(Boolean);
  const candidates: MalSearchCandidate[] = [];
  const seenTitles = new Set<string>();
  for (const variant of variants.slice(0, 8)) {
    const normalized = variant.trim().toLowerCase();
    if (!normalized || seenTitles.has(normalized)) continue;
    seenTitles.add(normalized);
    const results = await mal
      .searchManga({
        ...series,
        title: variant,
      })
      .catch(() => []);
    for (const candidate of results) {
      candidates.push({
        ...candidate,
        provenance: [...new Set([...(candidate.provenance ?? []), "mal-official-search"])],
      });
    }
  }
  return candidates;
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
