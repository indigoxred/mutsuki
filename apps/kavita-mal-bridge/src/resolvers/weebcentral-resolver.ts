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

export interface WeebCentralResolverTransport {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export function createWeebCentralResolver(input: {
  config: BridgeConfig;
  store: SqliteBridgeStore;
  transport?: WeebCentralResolverTransport;
}): TitleCandidateResolver {
  return {
    discoverCandidates: async (resolverInput) => {
      if (!isWeebCentralEvent(resolverInput)) return [];
      const canonicalUrl = canonicalWeebCentralSeriesUrl(resolverInput);
      if (!canonicalUrl) {
        await recordDiagnostic(input, resolverInput, {
          cacheKey: "missing-series-url",
          outcome: "disabled",
          candidates: [],
          cacheHit: false,
          cached: false,
          cacheable: false,
          message: "WeebCentral event did not include a usable series URL or ID.",
        });
        return [];
      }

      const cacheKey = canonicalUrl.toLowerCase();
      const cached = await input.store.getResolverCache<DiscoveredMalCandidate[]>(
        "weebcentral",
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
        const enriched = await fetchWeebCentralCandidates({
          url: canonicalUrl,
          config: input.config,
          transport: input.transport,
        });
        await input.store.setResolverCache(
          "weebcentral",
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
          message: `canonical=${canonicalUrl}`,
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

async function fetchWeebCentralCandidates(input: {
  url: string;
  config: BridgeConfig;
  transport?: WeebCentralResolverTransport;
}): Promise<DiscoveredMalCandidate[]> {
  const response = await fetchWithTimeout(input.url, input.config, input.transport);
  if (!response.ok) {
    throw resolverErrorFromStatus(response.status, "WeebCentral enrichment failed.");
  }
  const html = await response.text().catch(() => {
    throw new ResolverFetchError(
      "parse-failed",
      response.status,
      "WeebCentral response could not be read.",
    );
  });
  const links = extractExternalLinks(html);
  const candidates: DiscoveredMalCandidate[] = [];
  for (const malId of links.malIds) {
    candidates.push({
      malId,
      provenance: ["weebcentral-enrichment", "weebcentral-mal-id"],
    });
  }
  for (const aniListId of links.aniListIds) {
    const malId = await resolveAniListIdToMalId(aniListId, input.config, input.transport).catch(
      () => undefined,
    );
    if (malId !== undefined) {
      candidates.push({
        malId,
        provenance: ["weebcentral-enrichment", "weebcentral-anilist-id", "mal-direct-lookup"],
      });
    }
  }
  return mergeDiscoveredCandidates(candidates);
}

async function resolveAniListIdToMalId(
  aniListId: number,
  config: BridgeConfig,
  transport?: WeebCentralResolverTransport,
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
  transport?: WeebCentralResolverTransport,
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
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

function isWeebCentralEvent(input: TitleResolverInput): boolean {
  if (/weeb\s*central/iu.test(input.event.readingSourceId)) return true;
  if (/weeb\s*central/iu.test(input.event.readingSourceName)) return true;
  return /https?:\/\/(?:www\.)?weebcentral\.com\//iu.test(input.event.sourceShareUrl ?? "");
}

function canonicalWeebCentralSeriesUrl(input: TitleResolverInput): string | undefined {
  const shareUrl = input.event.sourceShareUrl;
  if (shareUrl) {
    const match = /^https?:\/\/(?:www\.)?weebcentral\.com\/series\/([^/?#\s]+)/iu.exec(shareUrl);
    if (match?.[1]) return `https://weebcentral.com/series/${encodeURIComponent(match[1])}`;
  }
  const id = input.event.sourceMangaId.trim();
  if (/^[a-z0-9]{16,32}$/iu.test(id)) {
    return `https://weebcentral.com/series/${encodeURIComponent(id)}`;
  }
  return undefined;
}

function extractExternalLinks(html: string): { malIds: number[]; aniListIds: number[] } {
  const malIds = new Set<number>();
  const aniListIds = new Set<number>();
  for (const href of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/giu)) {
    const url = decodeHtmlEntities(href[1] ?? "");
    const mal = /myanimelist\.net\/manga\/(\d+)/iu.exec(url);
    const aniList = /anilist\.co\/manga\/(\d+)/iu.exec(url);
    const malId = positiveInteger(mal?.[1]);
    const aniListId = positiveInteger(aniList?.[1]);
    if (malId !== undefined) malIds.add(malId);
    if (aniListId !== undefined) aniListIds.add(aniListId);
  }
  return { malIds: [...malIds], aniListIds: [...aniListIds] };
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
    resolver: "weebcentral",
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

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}
