export interface BridgeConfig {
  port: number;
  databasePath: string;
  dryRun: boolean;
  kavitaBaseUrl: string;
  kavitaApiKey: string;
  malAccessToken: string;
}

export function bridgeConfigFromEnv(env: NodeJS.ProcessEnv): BridgeConfig {
  return {
    port: parsePort(env.PORT),
    databasePath: env.MUTSUKI_BRIDGE_DB ?? "/data/mutsuki-bridge.sqlite",
    dryRun: env.MUTSUKI_BRIDGE_DRY_RUN !== "false",
    kavitaBaseUrl: required(env.KAVITA_BASE_URL, "KAVITA_BASE_URL"),
    kavitaApiKey: required(env.KAVITA_API_KEY, "KAVITA_API_KEY"),
    malAccessToken: env.MAL_ACCESS_TOKEN ?? "",
  };
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "6768");
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65535) return 6768;
  return parsed;
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`${name} is required.`);
  return trimmed;
}
