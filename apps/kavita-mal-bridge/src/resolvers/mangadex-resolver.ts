import type { BridgeConfig } from "../config.js";
import type { SqliteBridgeStore } from "../storage.js";
import type {
  DiscoveredMalCandidate,
  TitleCandidateResolver,
  TitleResolverInput,
} from "./title-resolver.js";
import {
  ResolverFetchError,
  resolverErrorFromStatus,
  resolverFailureFromError,
} from "./jikan-resolver.js";

export interface MangaDexResolverTransport {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export function createMangaDexResolver(input: {
  config: BridgeConfig;
  store: SqliteBridgeStore;
  transport?: MangaDexResolverTransport;
}): TitleCandidateResolver {
  return {
    discoverCandidates: async (resolverInput) => {
      if (!isMangaDexEvent(resolverInput)) return [];
      const mangaId = mangaDexId(resolverInput);
      if (!mangaId) {
        await recordDiagnostic(input, resolverInput, {
          cacheKey: "missing-mangadex-id",
          outcome: "disabled",
          candidates: [],
          cacheHit: false,
          cached: false,
          cacheable: false,
          message: "MangaDex event did not include a usable title UUID.",
        });
        return [];
      }

      const cacheKey = mangaId.toLowerCase();
      const cached = await input.store.getResolverCache<DiscoveredMalCandidate[]>(
        "mangadex",
        cacheKey,
      );
      if (cached) {
        await recordDiagnostic(input, resolverInput, {
          cacheKey,
          outcome: cached.length > 0 ? "ok" : "ok-zero-candidates",
          candidates: cached,
          cacheHit: true,
          cached: false,
          cacheable: true,
        });
        return cached;
      }

      try {
        const enriched = await fetchMangaDexCandidates({ mangaId, ...input });
        await input.store.setResolverCache(
          "mangadex",
          cacheKey,
          enriched,
          new Date(Date.now() + input.config.resolverCacheTtlHours * 3_600_000),
        );
        await recordDiagnostic(input, resolverInput, {
          cacheKey,
          outcome: enriched.length > 0 ? "ok" : "ok-zero-candidates",
          candidates: enriched,
          cacheHit: false,
          cached: true,
          cacheable: true,
          message: `mangaId=${mangaId}`,
        });
        return enriched;
      } catch (error) {
        const failure = resolverFailureFromError(error);
        await recordDiagnostic(input, resolverInput, {
          cacheKey,
          outcome: failure.outcome,
          candidates: [],
          cacheHit: false,
          cached: false,
          cacheable: false,
          httpStatus: failure.status,
          message: failure.message,
        });
        return [];
      }
    },
  };
}

async function fetchMangaDexCandidates(input: {
  mangaId: string;
  config: BridgeConfig;
  transport?: MangaDexResolverTransport;
}): Promise<DiscoveredMalCandidate[]> {
  const url = `https://api.mangadex.org/manga/${encodeURIComponent(input.mangaId)}`;
  const response = await fetchWithTimeout(url, input.config, input.transport);
  if (!response.ok)
    throw resolverErrorFromStatus(response.status, "MangaDex metadata lookup failed.");
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ResolverFetchError(
      "parse-failed",
      response.status,
      "MangaDex response was not JSON.",
    );
  }

  const links = mangaDexLinks(json);
  const candidates: DiscoveredMalCandidate[] = [];
  const malId = positiveIntegerFromExternalId(links.mal);
  if (malId !== undefined) {
    candidates.push({
      malId,
      provenance: ["mangadex-enrichment", "mangadex-mal-id"],
    });
  }

  const aniListId = positiveIntegerFromExternalId(links.al ?? links.anilist);
  if (aniListId !== undefined) {
    const resolvedMalId = await resolveAniListIdToMalId(
      aniListId,
      input.config,
      input.transport,
    ).catch(() => undefined);
    if (resolvedMalId !== undefined) {
      candidates.push({
        malId: resolvedMalId,
        provenance: ["mangadex-enrichment", "mangadex-anilist-id", "mal-direct-lookup"],
      });
    }
  }

  return mergeDiscoveredCandidates(candidates);
}

async function resolveAniListIdToMalId(
  aniListId: number,
  config: BridgeConfig,
  transport?: MangaDexResolverTransport,
): Promise<number | undefined> {
  const response = await fetchWithTimeout("https://graphql.anilist.co", config, transport, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": config.resolverUserAgent,
    },
    body: JSON.stringify({
      query: "query ($id: Int) { Media(id: $id, type: MANGA) { idMal } }",
      variables: { id: aniListId },
    }),
  });
  if (!response.ok) throw resolverErrorFromStatus(response.status, "AniList ID lookup failed.");
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ResolverFetchError("parse-failed", response.status, "AniList response was not JSON.");
  }
  const media = isRecord(json) && isRecord(json.data) ? json.data.Media : undefined;
  return isRecord(media) ? positiveInteger(media.idMal) : undefined;
}

async function fetchWithTimeout(
  url: string,
  config: BridgeConfig,
  transport?: MangaDexResolverTransport,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.resolverTimeoutMs);
  try {
    const requestInit: RequestInit = {
      method: "GET",
      ...init,
      signal: controller.signal,
      headers: init?.headers ?? {
        Accept: "application/json",
        "User-Agent": config.resolverUserAgent,
      },
    };
    return transport ? await transport.fetch(url, requestInit) : await fetch(url, requestInit);
  } catch (error) {
    if (isAbortError(error)) {
      throw new ResolverFetchError("timeout", undefined, "Resolver request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function mangaDexLinks(json: unknown): Record<string, unknown> {
  const data = isRecord(json) ? json.data : undefined;
  const attributes = isRecord(data) ? data.attributes : undefined;
  const links = isRecord(attributes) ? attributes.links : undefined;
  return isRecord(links) ? links : {};
}

function isMangaDexEvent(input: TitleResolverInput): boolean {
  if (/mangadex/iu.test(input.event.readingSourceId)) return true;
  if (/mangadex/iu.test(input.event.readingSourceName)) return true;
  return /https?:\/\/(?:www\.)?mangadex\.org\//iu.test(input.event.sourceShareUrl ?? "");
}

function mangaDexId(input: TitleResolverInput): string | undefined {
  const fromShare = input.event.sourceShareUrl
    ? /mangadex\.org\/title\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu.exec(
        input.event.sourceShareUrl,
      )?.[1]
    : undefined;
  if (fromShare) return fromShare;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    input.event.sourceMangaId,
  )
    ? input.event.sourceMangaId
    : undefined;
}

function mergeDiscoveredCandidates(candidates: DiscoveredMalCandidate[]): DiscoveredMalCandidate[] {
  const byId = new Map<number, Set<string>>();
  for (const candidate of candidates) {
    const provenance = byId.get(candidate.malId) ?? new Set<string>();
    for (const source of candidate.provenance) provenance.add(source);
    byId.set(candidate.malId, provenance);
  }
  return [...byId.entries()].map(([malId, provenance]) => ({
    malId,
    provenance: [...provenance],
  }));
}

async function recordDiagnostic(
  input: {
    store: SqliteBridgeStore;
  },
  resolverInput: TitleResolverInput,
  record: {
    cacheKey: string;
    outcome:
      | "ok"
      | "ok-zero-candidates"
      | "disabled"
      | "timeout"
      | "rate-limited"
      | "error"
      | "parse-failed";
    candidates: DiscoveredMalCandidate[];
    cacheHit: boolean;
    cached: boolean;
    cacheable: boolean;
    httpStatus?: number;
    message?: string;
  },
): Promise<void> {
  await input.store.recordResolverDiagnostic({
    readingSourceId: resolverInput.event.readingSourceId,
    sourceMangaId: resolverInput.event.sourceMangaId,
    sourceTitle: resolverInput.event.sourceTitle,
    schemaVersion: resolverInput.event.schemaVersion,
    titleVariantsJson: JSON.stringify(resolverInput.titleVariants.slice(0, 20)),
    resolver: "mangadex",
    enabled: true,
    cacheHit: record.cacheHit,
    cacheKey: record.cacheKey,
    httpStatus: record.httpStatus,
    outcome: record.outcome,
    candidateIdsJson: JSON.stringify(record.candidates.map((candidate) => candidate.malId)),
    candidateCount: record.candidates.length,
    cached: record.cached,
    cacheable: record.cacheable,
    message: record.message,
  });
}

function positiveIntegerFromExternalId(value: unknown): number | undefined {
  if (typeof value === "number") return positiveInteger(value);
  if (typeof value !== "string") return undefined;
  const direct = positiveInteger(value.trim());
  if (direct !== undefined) return direct;
  const match = /(?:myanimelist\.net\/manga\/|anilist\.co\/manga\/)(\d+)/iu.exec(value);
  return positiveInteger(match?.[1]);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}
