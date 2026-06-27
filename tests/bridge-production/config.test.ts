import assert from "node:assert/strict";
import test from "node:test";

import { bridgeConfigFromEnv } from "../../apps/kavita-mal-bridge/src/config.js";

test("bridge config can start without Kavita or MAL secrets so the setup UI is reachable", () => {
  const config = bridgeConfigFromEnv({
    PORT: "7000",
    MUTSUKI_BRIDGE_DB: "/tmp/bridge.sqlite",
  });

  assert.equal(config.port, 7000);
  assert.equal(config.databasePath, "/tmp/bridge.sqlite");
  assert.equal(config.dryRun, true);
  assert.equal(config.kavitaBaseUrl, "");
  assert.equal(config.kavitaApiKey, "");
  assert.equal(config.malAccessToken, "");
  assert.equal(config.maxMalSearchesPerRun, 50);
});

test("bridge config includes poll interval and MAL OAuth settings", () => {
  const config = bridgeConfigFromEnv({
    MUTSUKI_BRIDGE_POLL_INTERVAL_SECONDS: "900",
    MUTSUKI_BRIDGE_MAX_MAL_SEARCHES_PER_RUN: "25",
    MAL_CLIENT_ID: "client-id",
    MAL_CLIENT_SECRET: "client-secret",
    MAL_REDIRECT_URI: "http://bridge.local/api/mal/oauth/callback",
  });

  assert.equal(config.pollIntervalSeconds, 900);
  assert.equal(config.maxMalSearchesPerRun, 25);
  assert.equal(config.malClientId, "client-id");
  assert.equal(config.malClientSecret, "client-secret");
  assert.equal(config.malRedirectUri, "http://bridge.local/api/mal/oauth/callback");
});
