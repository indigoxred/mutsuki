import type { BridgeConfig } from "./config.js";
import { MalOAuthTokenError, refreshMalAccessToken, type OAuthTransport } from "./oauth.js";
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
    maxMalSearchesPerRun:
      settingPositiveInteger(settings.maxMalSearchesPerRun) ?? base.maxMalSearchesPerRun,
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
  const refreshed = await refreshStoredTokenOrHandleFailure({
    clientId,
    clientSecret: settings.malClientSecret ?? input.baseConfig.malClientSecret ?? "",
    refreshToken: tokens.refreshToken,
    now,
    transport: input.transport,
    store: input.store,
  });
  await input.store.saveOAuthTokens(refreshed);
  await input.store.audit({
    type: "system",
    message: "MAL OAuth token refreshed.",
  });
}

async function refreshStoredTokenOrHandleFailure(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  now: Date;
  transport?: OAuthTransport;
  store: SqliteBridgeStore;
}) {
  try {
    return await refreshMalAccessToken({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      refreshToken: input.refreshToken,
      now: () => input.now,
      transport: input.transport,
    });
  } catch (error) {
    if (!(error instanceof MalOAuthTokenError)) throw error;
    if (error.retryable) {
      await input.store.audit({
        type: "system",
        message: `MAL OAuth refresh failed with retryable status ${error.status}.`,
      });
      throw new Error(`MAL OAuth token refresh failed with retryable status ${error.status}.`);
    }

    await input.store.clearOAuthTokens();
    await input.store.audit({
      type: "system",
      message: "MAL OAuth refresh failed permanently; re-authorize MAL.",
    });
    throw new Error(
      "MAL OAuth authorization expired or was revoked. Re-authorize MAL before running sync.",
    );
  }
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

function settingPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? Math.min(parsed, 500) : undefined;
}
