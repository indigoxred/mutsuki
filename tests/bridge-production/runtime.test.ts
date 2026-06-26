import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bridgeConfigFromEnv } from "../../apps/kavita-mal-bridge/src/config.js";
import {
  assertBridgeSyncReady,
  effectiveBridgeConfig,
  refreshStoredMalTokenIfNeeded,
} from "../../apps/kavita-mal-bridge/src/runtime.js";
import { SqliteBridgeStore } from "../../apps/kavita-mal-bridge/src/storage.js";

test("effective bridge config uses persisted setup values and stored MAL OAuth token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-runtime-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();

  try {
    await store.saveSetting("kavitaBaseUrl", "https://read.example.test");
    await store.saveSetting("kavitaApiKey", "stored-kavita-key");
    await store.saveSetting("dryRun", "false");
    await store.saveSetting("pollIntervalSeconds", "900");
    await store.saveOAuthTokens({
      accessToken: "stored-mal-access",
      refreshToken: "stored-mal-refresh",
      expiresAt: "2026-06-26T01:00:00.000Z",
      tokenType: "Bearer",
    });

    const config = await effectiveBridgeConfig(
      bridgeConfigFromEnv({
        MUTSUKI_BRIDGE_DB: join(directory, "bridge.sqlite"),
        KAVITA_BASE_URL: "https://env.example.test",
        KAVITA_API_KEY: "env-kavita-key",
        MAL_ACCESS_TOKEN: "env-mal-access",
        MUTSUKI_BRIDGE_DRY_RUN: "true",
      }),
      store,
    );

    assert.equal(config.kavitaBaseUrl, "https://read.example.test");
    assert.equal(config.kavitaApiKey, "stored-kavita-key");
    assert.equal(config.malAccessToken, "stored-mal-access");
    assert.equal(config.dryRun, false);
    assert.equal(config.pollIntervalSeconds, 900);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sync readiness requires configured Kavita and authorized MAL", () => {
  assert.throws(
    () => assertBridgeSyncReady(bridgeConfigFromEnv({})),
    /Kavita URL or API key is not configured/u,
  );

  assert.throws(
    () =>
      assertBridgeSyncReady(
        bridgeConfigFromEnv({
          KAVITA_BASE_URL: "https://read.example.test",
          KAVITA_API_KEY: "kavita-key",
        }),
      ),
    /MAL OAuth token is not configured/u,
  );

  assert.doesNotThrow(() =>
    assertBridgeSyncReady(
      bridgeConfigFromEnv({
        KAVITA_BASE_URL: "https://read.example.test",
        KAVITA_API_KEY: "kavita-key",
        MAL_ACCESS_TOKEN: "mal-access",
      }),
    ),
  );
});

test("expired stored MAL OAuth token refreshes before sync uses it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-runtime-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();

  try {
    await store.saveSetting("malClientId", "client-id");
    await store.saveSetting("malClientSecret", "client-secret");
    await store.saveOAuthTokens({
      accessToken: "expired-access",
      refreshToken: "refresh-token",
      expiresAt: "2026-06-26T00:00:00.000Z",
      tokenType: "Bearer",
    });

    await refreshStoredMalTokenIfNeeded({
      baseConfig: bridgeConfigFromEnv({}),
      store,
      now: () => new Date("2026-06-26T00:01:00.000Z"),
      transport: async (request) => {
        assert.match(request.body, /grant_type=refresh_token/u);
        assert.match(request.body, /refresh_token=refresh-token/u);
        return {
          status: 200,
          body: JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "fresh-refresh",
            expires_in: 3600,
            token_type: "Bearer",
          }),
        };
      },
    });

    assert.equal((await store.getOAuthTokens())?.accessToken, "fresh-access");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
