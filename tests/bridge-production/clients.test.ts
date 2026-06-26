import assert from "node:assert/strict";
import test from "node:test";

import {
  checkKavitaReadiness,
  checkMalReadiness,
} from "../../apps/kavita-mal-bridge/src/clients.js";
import { bridgeConfigFromEnv } from "../../apps/kavita-mal-bridge/src/config.js";

test("Kavita readiness checks the configured series endpoint and reports extracted series count", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      const url =
        input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
      const headers = init?.headers as Record<string, string>;
      assert.equal(url, "https://read.example.test/api/Series/all-v2");
      assert.equal(headers["x-api-key"], "secret-key");
      return new Response(JSON.stringify([{ id: 1, name: "Series", libraryId: 2 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await checkKavitaReadiness({
      ...bridgeConfigFromEnv({}),
      kavitaBaseUrl: "https://read.example.test",
      kavitaApiKey: "secret-key",
    });

    assert.equal(result.configured, true);
    assert.equal(result.ok, true);
    assert.equal(result.seriesSeen, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MAL readiness verifies the stored OAuth token without leaking it in failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response("nope", {
        status: 401,
      });

    const result = await checkMalReadiness({
      ...bridgeConfigFromEnv({}),
      malClientId: "client-id",
      malRedirectUri: "http://localhost/callback",
      malAccessToken: "secret-mal-token",
    });

    assert.equal(result.oauthConfigured, true);
    assert.equal(result.authorized, true);
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /secret-mal-token/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
