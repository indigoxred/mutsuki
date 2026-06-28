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
  assert.equal(config.enableJikanResolver, true);
  assert.equal(config.enableAnilistResolver, true);
  assert.equal(config.resolverTimeoutMs, 5000);
  assert.equal(config.resolverCacheTtlHours, 168);
  assert.equal(config.resolverMaxCandidatesPerQuery, 8);
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

test("bridge config supports resolver controls", () => {
  const config = bridgeConfigFromEnv({
    ENABLE_JIKAN_RESOLVER: "false",
    ENABLE_ANILIST_RESOLVER: "false",
    RESOLVER_TIMEOUT_MS: "9000",
    RESOLVER_CACHE_TTL_HOURS: "24",
    RESOLVER_MAX_CANDIDATES_PER_QUERY: "12",
    RESOLVER_USER_AGENT: "Mutsuki Test Agent",
  });

  assert.equal(config.enableJikanResolver, false);
  assert.equal(config.enableAnilistResolver, false);
  assert.equal(config.resolverTimeoutMs, 9000);
  assert.equal(config.resolverCacheTtlHours, 24);
  assert.equal(config.resolverMaxCandidatesPerQuery, 12);
  assert.equal(config.resolverUserAgent, "Mutsuki Test Agent");
});
