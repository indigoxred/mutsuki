import type { BridgeConfig } from "./config.js";
import { refreshMalAccessToken, type OAuthTransport } from "./oauth.js";
import type { SqliteBridgeStore } from "./storage.js";

export async function effectiveBridgeConfig(
  base: BridgeConfig,
  store: SqliteBridgeStore,
): Promise<BridgeConfig> {
  const settings = await store.listSettings();
  const tokens = await store.getOAuthTokens();
  return {
    ...base,
    dryRun: settingBoolean(settings.dryRun, base.dryRun),
    kavitaBaseUrl: settings.kavitaBaseUrl ?? base.kavitaBaseUrl,
    kavitaApiKey: settings.kavitaApiKey ?? base.kavitaApiKey,
    malAccessToken: tokens?.accessToken ?? base.malAccessToken,
    malClientId: settings.malClientId ?? base.malClientId,
    malClientSecret: settings.malClientSecret ?? base.malClientSecret,
    malRedirectUri: settings.malRedirectUri ?? base.malRedirectUri,
    pollIntervalSeconds: settingNumber(settings.pollIntervalSeconds) ?? base.pollIntervalSeconds,
  };
}

export function assertBridgeSyncReady(config: BridgeConfig): void {
  if (!config.kavitaBaseUrl || !config.kavitaApiKey) {
    throw new Error("Kavita URL or API key is not configured.");
  }
  if (!config.malAccessToken) {
    throw new Error("MAL OAuth token is not configured. Authorize MAL before running sync.");
  }
}

export async function refreshStoredMalTokenIfNeeded(input: {
  baseConfig: BridgeConfig;
  store: SqliteBridgeStore;
  now?: () => Date;
  transport?: OAuthTransport;
}): Promise<void> {
  const tokens = await input.store.getOAuthTokens();
  if (!tokens) return;
  const now = input.now?.() ?? new Date();
  const expiresAt = new Date(tokens.expiresAt);
  if (!Number.isFinite(expiresAt.getTime())) return;
  if (expiresAt.getTime() - now.getTime() > 120_000) return;

  const settings = await input.store.listSettings();
  const clientId = settings.malClientId ?? input.baseConfig.malClientId;
  if (!clientId) return;
  const refreshed = await refreshMalAccessToken({
    clientId,
    clientSecret: settings.malClientSecret ?? input.baseConfig.malClientSecret,
    refreshToken: tokens.refreshToken,
    now: () => now,
    transport: input.transport,
  });
  await input.store.saveOAuthTokens(refreshed);
  await input.store.audit({
    type: "system",
    message: "MAL OAuth token refreshed.",
  });
}

function settingBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function settingNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 60 ? parsed : undefined;
}
