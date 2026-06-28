import type { MalSearchCandidate } from "../matching.js";
import type { BridgeReadEventRecord } from "../progress-events.js";
import type { BridgeObservedSeries } from "../sync.js";

export interface TitleResolverInput {
  event: BridgeReadEventRecord;
  series: BridgeObservedSeries;
  titleVariants: string[];
}

export interface DiscoveredMalCandidate {
  malId: number;
  provenance: string[];
}

export interface TitleCandidateResolver {
  discoverCandidates(input: TitleResolverInput): Promise<DiscoveredMalCandidate[]>;
}

export interface MalCandidateHydrator {
  getMangaById?(malId: number): Promise<MalSearchCandidate | undefined>;
}

export function composeTitleResolvers(resolvers: TitleCandidateResolver[]): TitleCandidateResolver {
  return {
    discoverCandidates: async (input) => {
      const byId = new Map<number, Set<string>>();
      for (const resolver of resolvers) {
        const candidates = await resolver.discoverCandidates(input).catch(() => []);
        for (const candidate of candidates) {
          const provenance = byId.get(candidate.malId) ?? new Set<string>();
          for (const source of candidate.provenance) provenance.add(source);
          byId.set(candidate.malId, provenance);
        }
      }
      return [...byId.entries()].map(([malId, provenance]) => ({
        malId,
        provenance: [...provenance],
      }));
    },
  };
}

export function titleVariantsFromExternalEvent(event: BridgeReadEventRecord): string[] {
  const values = new Set<string>();
  const add = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    for (const variant of titleVariantsFromString(trimmed)) values.add(variant);
  };

  add(event.sourceTitle);
  add(event.sourcePrimaryTitle);
  for (const title of event.sourceAltTitles ?? []) add(title);
  add(slugTitleFromUrl(event.sourceShareUrl));
  add(slugTitleFromUrl(event.sourceThumbnailUrl));

  return [...values].slice(0, 20);
}

export function titleVariantsFromString(value: string): string[] {
  const variants = new Set<string>();
  const add = (next: string): void => {
    const cleaned = next.replace(/\s+/gu, " ").trim();
    if (cleaned.length > 1) variants.add(cleaned);
  };

  add(value);
  add(value.replace(/[_-]+/gu, " "));
  add(value.replace(/[’']/gu, "'"));
  add(value.replace(/\s*[:：]\s*.+$/u, ""));
  add(value.replace(/\s*\([^)]*\)\s*/gu, " "));
  add(value.replace(/\s*\[[^\]]*\]\s*/gu, " "));
  return [...variants];
}

export async function hydrateAndMergeCandidates(input: {
  officialCandidates: MalSearchCandidate[];
  discoveredCandidates: DiscoveredMalCandidate[];
  hydrator: MalCandidateHydrator;
}): Promise<MalSearchCandidate[]> {
  const merged = new Map<number, MalSearchCandidate>();
  const provenance = new Map<number, Set<string>>();

  const remember = (candidate: MalSearchCandidate): void => {
    const existing = merged.get(candidate.malId);
    const sources = provenance.get(candidate.malId) ?? new Set<string>();
    for (const source of candidate.provenance ?? ["mal-official-search"]) sources.add(source);
    provenance.set(candidate.malId, sources);
    merged.set(candidate.malId, {
      ...existing,
      ...candidate,
      altTitles: uniqueStrings([...(existing?.altTitles ?? []), ...(candidate.altTitles ?? [])]),
      authors: uniqueStrings([...(existing?.authors ?? []), ...(candidate.authors ?? [])]),
    });
  };

  for (const candidate of input.officialCandidates) {
    remember({ ...candidate, provenance: candidate.provenance ?? ["mal-official-search"] });
  }

  for (const discovered of input.discoveredCandidates) {
    const hydrated = await input.hydrator.getMangaById?.(discovered.malId).catch(() => undefined);
    remember({
      ...(hydrated ?? {
        malId: discovered.malId,
        title: `MAL ${discovered.malId}`,
      }),
      malId: discovered.malId,
      provenance: discovered.provenance,
    });
  }

  return [...merged.values()].map((candidate) => ({
    ...candidate,
    provenance: [...(provenance.get(candidate.malId) ?? new Set<string>())],
  }));
}

function slugTitleFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const path = value.split(/[?#]/u)[0] ?? "";
  const segment = path.split("/").filter(Boolean).at(-1);
  if (!segment) return undefined;
  return decodeURIComponentSafe(segment)
    .replace(/\.(?:avif|gif|jpe?g|png|webp|html?)$/iu, "")
    .replace(/[-_]+/gu, " ");
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function uniqueStrings(values: (string | undefined)[]): string[] | undefined {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
  return unique.length > 0 ? unique : undefined;
}
