import type { BridgeConfig } from "../config.js";
import type { SqliteBridgeStore } from "../storage.js";
import type {
  DiscoveredMalCandidate,
  TitleCandidateResolver,
  TitleResolverInput,
} from "./title-resolver.js";

export interface ResolverHttpTransport {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export class ResolverFetchError extends Error {
  constructor(
    readonly outcome: "timeout" | "rate-limited" | "error" | "parse-failed",
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

export function createJikanResolver(input: {
  config: BridgeConfig;
  store: SqliteBridgeStore;
  transport?: ResolverHttpTransport;
}): TitleCandidateResolver {
  return {
    discoverCandidates: (resolverInput) =>
      discoverWithCache({
        resolver: "jikan",
        input: resolverInput,
        config: input.config,
        store: input.store,
        transport: input.transport,
        fetchQuery: fetchJikanCandidates,
      }),
  };
}

async function fetchJikanCandidates(input: {
  query: string;
  config: BridgeConfig;
  transport?: ResolverHttpTransport;
}): Promise<DiscoveredMalCandidate[]> {
  const url = new URL("https://api.jikan.moe/v4/manga");
  url.searchParams.set("q", input.query);
  url.searchParams.set("limit", String(input.config.resolverMaxCandidatesPerQuery));
  const response = await fetchWithTimeout(url.toString(), input.config, input.transport);
  if (!response.ok) throw resolverErrorFromStatus(response.status, "Jikan search failed.");
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ResolverFetchError("parse-failed", response.status, "Jikan response was not JSON.");
  }
  if (!isRecord(json) || !Array.isArray(json.data)) return [];
  return json.data.flatMap((item) => {
    if (!isRecord(item)) return [];
    const malId = positiveInteger(item.mal_id);
    return malId === undefined ? [] : [{ malId, provenance: ["jikan-search"] }];
  });
}

export async function discoverWithCache(input: {
  resolver: string;
  input: TitleResolverInput;
  config: BridgeConfig;
  store: SqliteBridgeStore;
  transport?: ResolverHttpTransport;
  fetchQuery: (input: {
    query: string;
    config: BridgeConfig;
    transport?: ResolverHttpTransport;
  }) => Promise<DiscoveredMalCandidate[]>;
}): Promise<DiscoveredMalCandidate[]> {
  const results: DiscoveredMalCandidate[] = [];
  const seen = new Set<number>();
  for (const query of input.input.titleVariants.slice(0, 8)) {
    const cacheKey = query.toLowerCase();
    const cached = await input.store.getResolverCache<DiscoveredMalCandidate[]>(
      input.resolver,
      cacheKey,
    );
    let candidates: DiscoveredMalCandidate[] = cached ?? [];
    if (cached) {
      await recordResolverDiagnostic(input, {
        query,
        cacheKey,
        cacheHit: true,
        candidates,
        outcome: candidates.length > 0 ? "ok" : "ok-zero-candidates",
        cached: false,
        cacheable: true,
      });
    } else {
      try {
        candidates = await input.fetchQuery({
          query,
          config: input.config,
          transport: input.transport,
        });
      } catch (error) {
        const failure = resolverFailureFromError(error);
        await recordResolverDiagnostic(input, {
          query,
          cacheKey,
          cacheHit: false,
          candidates: [],
          outcome: failure.outcome,
          cached: false,
          cacheable: false,
          httpStatus: failure.status,
          message: failure.message,
        });
        continue;
      }
      await input.store.setResolverCache(
        input.resolver,
        cacheKey,
        candidates,
        new Date(Date.now() + input.config.resolverCacheTtlHours * 3_600_000),
      );
      await recordResolverDiagnostic(input, {
        query,
        cacheKey,
        cacheHit: false,
        candidates,
        outcome: candidates.length > 0 ? "ok" : "ok-zero-candidates",
        cached: true,
        cacheable: true,
      });
    }
    for (const candidate of candidates) {
      if (seen.has(candidate.malId)) continue;
      seen.add(candidate.malId);
      results.push(candidate);
    }
  }
  return results;
}

export async function fetchWithTimeout(
  url: string,
  config: BridgeConfig,
  transport?: ResolverHttpTransport,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.resolverTimeoutMs);
  try {
    return await fetchResolver(transport, url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": config.resolverUserAgent,
      },
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new ResolverFetchError("timeout", undefined, "Resolver request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function fetchResolver(
  transport: ResolverHttpTransport | undefined,
  url: string,
  init: RequestInit,
): Promise<Response> {
  return transport ? transport.fetch(url, init) : fetch(url, init);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolverErrorFromStatus(status: number, message: string): ResolverFetchError {
  if (status === 429) return new ResolverFetchError("rate-limited", status, message);
  return new ResolverFetchError("error", status, message);
}

export function resolverFailureFromError(error: unknown): {
  outcome: ResolverFetchError["outcome"];
  status?: number;
  message: string;
} {
  if (error instanceof ResolverFetchError) {
    return {
      outcome: error.outcome,
      status: error.status,
      message: error.message,
    };
  }
  if (isAbortError(error)) {
    return { outcome: "timeout", message: "Resolver request timed out." };
  }
  return {
    outcome: "error",
    message: error instanceof Error ? error.message : "Resolver request failed.",
  };
}

async function recordResolverDiagnostic(
  input: Parameters<typeof discoverWithCache>[0],
  record: {
    query: string;
    cacheKey: string;
    cacheHit: boolean;
    candidates: DiscoveredMalCandidate[];
    outcome: "ok" | "ok-zero-candidates" | ResolverFetchError["outcome"];
    cached: boolean;
    cacheable: boolean;
    httpStatus?: number;
    message?: string;
  },
): Promise<void> {
  await input.store.recordResolverDiagnostic({
    readingSourceId: input.input.event.readingSourceId,
    sourceMangaId: input.input.event.sourceMangaId,
    sourceTitle: input.input.event.sourceTitle,
    schemaVersion: input.input.event.schemaVersion,
    titleVariantsJson: JSON.stringify(input.input.titleVariants.slice(0, 20)),
    resolver: input.resolver,
    enabled: true,
    cacheHit: record.cacheHit,
    cacheKey: record.cacheKey,
    httpStatus: record.httpStatus,
    outcome: record.outcome,
    candidateIdsJson: JSON.stringify(record.candidates.map((candidate) => candidate.malId)),
    candidateCount: record.candidates.length,
    cached: record.cached,
    cacheable: record.cacheable,
    message: record.message ?? `query=${record.query}`,
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}
