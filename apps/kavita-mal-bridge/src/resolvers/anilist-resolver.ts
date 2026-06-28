import type { BridgeConfig } from "../config.js";
import type { SqliteBridgeStore } from "../storage.js";
import type { DiscoveredMalCandidate, TitleCandidateResolver } from "./title-resolver.js";

export interface ResolverGraphqlTransport {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export function createAnilistResolver(input: {
  config: BridgeConfig;
  store: SqliteBridgeStore;
  transport?: ResolverGraphqlTransport;
}): TitleCandidateResolver {
  return {
    discoverCandidates: async (resolverInput) => {
      const results: DiscoveredMalCandidate[] = [];
      const seen = new Set<number>();
      for (const query of resolverInput.titleVariants.slice(0, 8)) {
        const cacheKey = query.toLowerCase();
        const cached = await input.store.getResolverCache<DiscoveredMalCandidate[]>(
          "anilist",
          cacheKey,
        );
        const candidates =
          cached ??
          (await fetchAnilistCandidates({
            query,
            config: input.config,
            transport: input.transport,
          }).catch(() => []));
        if (!cached) {
          await input.store.setResolverCache(
            "anilist",
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
    },
  };
}

async function fetchAnilistCandidates(input: {
  query: string;
  config: BridgeConfig;
  transport?: ResolverGraphqlTransport;
}): Promise<DiscoveredMalCandidate[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.config.resolverTimeoutMs);
  try {
    const response = await fetchResolver(input.transport, "https://graphql.anilist.co", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": input.config.resolverUserAgent,
      },
      body: JSON.stringify({
        query:
          "query ($search: String, $perPage: Int) { Page(page: 1, perPage: $perPage) { media(search: $search, type: MANGA) { idMal } } }",
        variables: {
          search: input.query,
          perPage: input.config.resolverMaxCandidatesPerQuery,
        },
      }),
    });
    if (!response.ok) return [];
    const json = (await response.json()) as unknown;
    const media =
      isRecord(json) && isRecord(json.data) && isRecord(json.data.Page)
        ? json.data.Page.media
        : undefined;
    if (!Array.isArray(media)) return [];
    return media.flatMap((item) => {
      if (!isRecord(item)) return [];
      const malId = positiveInteger(item.idMal);
      return malId === undefined ? [] : [{ malId, provenance: ["anilist-search"] }];
    });
  } finally {
    clearTimeout(timeout);
  }
}

function fetchResolver(
  transport: ResolverGraphqlTransport | undefined,
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
