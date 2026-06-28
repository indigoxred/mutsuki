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
  if (!response.ok) return [];
  const json = (await response.json()) as unknown;
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
    const candidates =
      cached ??
      (await input
        .fetchQuery({ query, config: input.config, transport: input.transport })
        .catch(() => []));
    if (!cached) {
      await input.store.setResolverCache(
        input.resolver,
        cacheKey,
        candidates,
        new Date(Date.now() + input.config.resolverCacheTtlHours * 3_600_000),
      );
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
