export interface BridgeConfig {
  port: number;
  databasePath: string;
  dryRun: boolean;
  kavitaBaseUrl: string;
  kavitaApiKey: string;
  malAccessToken: string;
  malClientId: string;
  malClientSecret: string;
  malRedirectUri: string;
  pollIntervalSeconds: number;
  maxMalSearchesPerRun: number;
  enableJikanResolver: boolean;
  enableAnilistResolver: boolean;
  resolverTimeoutMs: number;
  resolverCacheTtlHours: number;
  resolverMaxCandidatesPerQuery: number;
  resolverUserAgent: string;
}

export function bridgeConfigFromEnv(env: NodeJS.ProcessEnv): BridgeConfig {
  return {
    port: parsePort(env.PORT),
    databasePath: env.MUTSUKI_BRIDGE_DB ?? "/data/mutsuki-bridge.sqlite",
    dryRun: env.MUTSUKI_BRIDGE_DRY_RUN !== "false",
    kavitaBaseUrl: env.KAVITA_BASE_URL?.trim() ?? "",
    kavitaApiKey: env.KAVITA_API_KEY ?? "",
    malAccessToken: env.MAL_ACCESS_TOKEN ?? "",
    malClientId: env.MAL_CLIENT_ID ?? "",
    malClientSecret: env.MAL_CLIENT_SECRET ?? "",
    malRedirectUri: env.MAL_REDIRECT_URI ?? "",
    pollIntervalSeconds: parsePollInterval(env.MUTSUKI_BRIDGE_POLL_INTERVAL_SECONDS),
    maxMalSearchesPerRun: parseMaxMalSearches(env.MUTSUKI_BRIDGE_MAX_MAL_SEARCHES_PER_RUN),
    enableJikanResolver: env.ENABLE_JIKAN_RESOLVER !== "false",
    enableAnilistResolver: env.ENABLE_ANILIST_RESOLVER !== "false",
    resolverTimeoutMs: parseResolverTimeout(env.RESOLVER_TIMEOUT_MS),
    resolverCacheTtlHours: parseResolverCacheTtl(env.RESOLVER_CACHE_TTL_HOURS),
    resolverMaxCandidatesPerQuery: parseResolverMaxCandidates(
      env.RESOLVER_MAX_CANDIDATES_PER_QUERY,
    ),
    resolverUserAgent:
      env.RESOLVER_USER_AGENT?.trim() ??
      "Mutsuki Kavita MAL Bridge (https://github.com/indigoxred/mutsuki)",
  };
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "6768");
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65535) return 6768;
  return parsed;
}

function parsePollInterval(value: string | undefined): number {
  const parsed = Number(value ?? "1800");
  if (!Number.isSafeInteger(parsed) || parsed < 60) return 1800;
  return parsed;
}

function parseMaxMalSearches(value: string | undefined): number {
  const parsed = Number(value ?? "50");
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 50;
  return Math.min(parsed, 500);
}

function parseResolverTimeout(value: string | undefined): number {
  const parsed = Number(value ?? "5000");
  if (!Number.isSafeInteger(parsed) || parsed < 1000) return 5000;
  return Math.min(parsed, 30_000);
}

function parseResolverCacheTtl(value: string | undefined): number {
  const parsed = Number(value ?? "168");
  if (!Number.isFinite(parsed) || parsed <= 0) return 168;
  return Math.min(parsed, 24 * 30);
}

function parseResolverMaxCandidates(value: string | undefined): number {
  const parsed = Number(value ?? "8");
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 8;
  return Math.min(parsed, 25);
}
