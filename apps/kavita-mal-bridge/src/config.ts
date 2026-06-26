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
