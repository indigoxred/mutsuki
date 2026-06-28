export type BridgeReadEventSource = "mutsuki-kavita-source" | "paperback-progress-bridge";

export type BridgeReadingSourceKind = "kavita" | "external" | "unknown";

export type KavitaMirrorMode = "disabled" | "kavita-source-only" | "approved-external-mappings";

export interface BridgeReadEventRecord {
  schemaVersion: 1 | 2 | 3;
  eventSource: BridgeReadEventSource;
  readingSourceId: string;
  readingSourceName: string;
  readingSourceKind: BridgeReadingSourceKind;
  actionId: string;
  occurredAt: string;
  receivedAt: string;
  sourceMangaId: string;
  sourceChapterId: string;
  sourceTitle: string;
  sourcePrimaryTitle?: string;
  sourceAltTitles?: string[];
  sourceAuthor?: string;
  sourceArtist?: string;
  sourceShareUrl?: string;
  sourceThumbnailUrl?: string;
  sourceExternalIds?: Record<string, string | number>;
  sourceDescription?: string;
  sourceOriginalMetadataJson?: string;
  sourceChapterNumber: number;
  sourceChapterVolume?: number;
  kavitaSeriesId?: number;
  kavitaChapterId?: number;
  chapterKind: "manga" | "book";
  rawEventJson: string;
}

export interface SourcePolicyRecord {
  readingSourceId: string;
  readingSourceName: string;
  malEnabled: boolean;
  kavitaMirrorMode: KavitaMirrorMode;
}

export const DEFAULT_SOURCE_POLICY: Omit<
  SourcePolicyRecord,
  "readingSourceId" | "readingSourceName"
> = {
  malEnabled: true,
  kavitaMirrorMode: "disabled",
};

export function parseBridgeReadEvent(input: unknown): BridgeReadEventRecord {
  if (!isRecord(input)) throw new Error("Event must be an object.");
  const legacySource =
    input.source === "paperback-progress-provider"
      ? "paperback-progress-provider"
      : input.source === "paperback-mutsuki"
        ? "paperback-mutsuki"
        : undefined;
  const eventSource = eventSourceFromUnknown(input.eventSource, legacySource);
  const kavitaSeriesId = optionalPositiveInteger(input.kavitaSeriesId);
  const chapterSourceId = optionalString(input.chapterSourceId);
  const readingSourceId =
    optionalString(input.readingSourceId) ??
    chapterSourceId ??
    (eventSource === "mutsuki-kavita-source" || kavitaSeriesId !== undefined
      ? "Kavita"
      : "unknown");
  const sourceMangaId =
    optionalString(input.sourceMangaId) ??
    optionalString(input.chapterMangaId) ??
    requiredString(input.mangaId, "mangaId");
  const sourceChapterId =
    optionalString(input.sourceChapterId) ??
    requiredString(input.paperbackChapterId, "paperbackChapterId");
  const sourceChapterNumber =
    optionalFiniteNumber(input.sourceChapterNumber) ??
    requiredFiniteNumber(input.chapterNum, "chapterNum");
  const sourceTitle =
    optionalString(input.sourceTitleForMatching) ??
    optionalString(input.sourceTitle) ??
    optionalString(input.sourcePrimaryTitle) ??
    optionalString(input.trackedTitle) ??
    optionalString(input.title) ??
    "";
  const sourcePrimaryTitle = optionalString(input.sourcePrimaryTitle);

  return {
    schemaVersion: input.schemaVersion === 3 ? 3 : input.schemaVersion === 2 ? 2 : 1,
    eventSource,
    readingSourceId,
    readingSourceName: optionalString(input.readingSourceName) ?? readingSourceId,
    readingSourceKind: readingSourceKind(input.readingSourceKind, readingSourceId, eventSource),
    actionId: requiredString(input.actionId, "actionId"),
    occurredAt: requiredString(input.occurredAt, "occurredAt"),
    receivedAt: requiredString(input.receivedAt, "receivedAt"),
    sourceMangaId,
    sourceChapterId,
    sourceTitle,
    sourcePrimaryTitle,
    sourceAltTitles: optionalStringArray(input.sourceAltTitles),
    sourceAuthor: optionalString(input.sourceAuthor),
    sourceArtist: optionalString(input.sourceArtist),
    sourceShareUrl: optionalString(input.sourceShareUrl),
    sourceThumbnailUrl: optionalString(input.sourceThumbnailUrl),
    sourceExternalIds: optionalExternalIds(input.sourceExternalIds),
    sourceDescription: optionalString(input.sourceDescription),
    sourceOriginalMetadataJson: optionalString(input.sourceOriginalMetadataJson),
    sourceChapterNumber,
    sourceChapterVolume:
      optionalFiniteNumber(input.sourceChapterVolume) ?? optionalFiniteNumber(input.chapterVolume),
    kavitaSeriesId,
    kavitaChapterId: optionalPositiveInteger(input.kavitaChapterId),
    chapterKind: input.chapterKind === "book" ? "book" : "manga",
    rawEventJson: JSON.stringify(redactEvent(input)),
  };
}

export function defaultSourcePolicyForEvent(event: BridgeReadEventRecord): SourcePolicyRecord {
  return {
    readingSourceId: event.readingSourceId,
    readingSourceName: event.readingSourceName,
    malEnabled: true,
    kavitaMirrorMode: event.readingSourceKind === "kavita" ? "kavita-source-only" : "disabled",
  };
}

export function sourcePolicyFromInput(
  readingSourceId: string,
  input: Record<string, unknown>,
  existing?: SourcePolicyRecord,
): SourcePolicyRecord {
  return {
    readingSourceId,
    readingSourceName:
      optionalString(input.readingSourceName) ?? existing?.readingSourceName ?? readingSourceId,
    malEnabled:
      typeof input.malEnabled === "boolean" ? input.malEnabled : (existing?.malEnabled ?? true),
    kavitaMirrorMode: kavitaMirrorMode(input.kavitaMirrorMode, existing?.kavitaMirrorMode),
  };
}

function eventSourceFromUnknown(
  value: unknown,
  legacySource: string | undefined,
): BridgeReadEventSource {
  if (value === "mutsuki-kavita-source" || value === "paperback-progress-bridge") return value;
  return legacySource === "paperback-progress-provider"
    ? "paperback-progress-bridge"
    : "mutsuki-kavita-source";
}

function readingSourceKind(
  value: unknown,
  sourceId: string,
  eventSource: BridgeReadEventSource,
): BridgeReadingSourceKind {
  if (value === "kavita" || value === "external" || value === "unknown") return value;
  if (
    eventSource === "mutsuki-kavita-source" ||
    /^(?:kavita|mutsuki(?:\s|-)?kavita)$/iu.test(sourceId)
  ) {
    return "kavita";
  }
  return sourceId === "unknown" ? "unknown" : "external";
}

function kavitaMirrorMode(value: unknown, fallback?: KavitaMirrorMode): KavitaMirrorMode {
  return value === "disabled" ||
    value === "kavita-source-only" ||
    value === "approved-external-mappings"
    ? value
    : (fallback ?? "disabled");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}.`);
  return sanitizeShort(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? sanitizeShort(value) : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.flatMap((item) => {
    const sanitized = optionalString(item);
    return sanitized ? [sanitized] : [];
  });
  return strings.length > 0 ? strings.slice(0, 25) : undefined;
}

function optionalExternalIds(value: unknown): Record<string, string | number> | undefined {
  if (!isRecord(value)) return undefined;
  const ids: Record<string, string | number> = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    if (isSecretKey(key)) continue;
    if (typeof item === "number" && Number.isFinite(item)) {
      ids[sanitizeExternalIdKey(key)] = item;
    } else if (typeof item === "string" && item.trim()) {
      ids[sanitizeExternalIdKey(key)] = sanitizeShort(item);
    }
  }
  return Object.keys(ids).length > 0 ? ids : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function requiredFiniteNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}.`);
  return parsed;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeShort(value: string): string {
  return value
    .replace(/Bearer\s+[^&\s"')<>]+/giu, "Bearer redacted")
    .replace(/x-api-key[:=]\s*[^&\s"')<>]+/giu, "x-api-key=redacted")
    .replace(/apiKey=[^&\s"')<>]+/giu, "apiKey=redacted")
    .slice(0, 500);
}

function redactEvent(value: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|api.?key|authorization|secret/iu.test(key)) {
      redacted[key] = "redacted";
    } else if (typeof item === "string") {
      redacted[key] = sanitizeShort(item);
    } else if (Array.isArray(item)) {
      redacted[key] = item.map((child) =>
        typeof child === "string"
          ? sanitizeShort(child)
          : isRecord(child)
            ? redactEvent(child)
            : child,
      );
    } else if (isRecord(item)) {
      redacted[key] = redactEvent(item);
    } else {
      redacted[key] = item;
    }
  }
  return redacted;
}

function isSecretKey(key: string): boolean {
  return /token|api.?key|authorization|auth|secret|cookie|session|password/iu.test(key);
}

function sanitizeExternalIdKey(key: string): string {
  return key.replace(/[^\w.-]+/gu, "_").slice(0, 80);
}
