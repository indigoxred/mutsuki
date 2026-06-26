import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMalAuthorizationRequest,
  exchangeMalAuthorizationCode,
  refreshMalAccessToken,
} from "../../apps/kavita-mal-bridge/src/oauth.js";

test("MAL OAuth start builds a PKCE authorization URL and stores verifier metadata", () => {
  const request = buildMalAuthorizationRequest({
    clientId: "client-id",
    redirectUri: "http://localhost:6768/api/mal/oauth/callback",
    now: () => new Date("2026-06-26T00:00:00.000Z"),
    randomBytes: () => Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijkl"),
  });

  assert.match(request.authorizationUrl, /^https:\/\/myanimelist\.net\/v1\/oauth2\/authorize/u);
  assert.equal(request.stateRecord.state.length > 20, true);
  assert.equal(request.stateRecord.codeVerifier.length >= 43, true);
  assert.equal(
    new URL(request.authorizationUrl).searchParams.get("code_challenge_method"),
    "plain",
  );
});

test("MAL OAuth code exchange posts the saved verifier to the token endpoint", async () => {
  const requests: { url: string; body: string }[] = [];
  const tokens = await exchangeMalAuthorizationCode({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
    code: "auth-code",
    codeVerifier: "verifier",
    now: () => new Date("2026-06-26T00:00:00.000Z"),
    transport: async (request) => {
      requests.push({ url: request.url, body: request.body });
      return {
        status: 200,
        body: JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      };
    },
  });

  assert.equal(requests[0]?.url, "https://myanimelist.net/v1/oauth2/token");
  assert.match(requests[0]?.body ?? "", /grant_type=authorization_code/u);
  assert.match(requests[0]?.body ?? "", /code_verifier=verifier/u);
  assert.equal(tokens.accessToken, "access");
  assert.equal(tokens.expiresAt, "2026-06-26T01:00:00.000Z");
});

test("MAL OAuth refresh uses refresh_token grant", async () => {
  const tokens = await refreshMalAccessToken({
    clientId: "client-id",
    clientSecret: "",
    refreshToken: "refresh",
    now: () => new Date("2026-06-26T00:00:00.000Z"),
    transport: async (request) => {
      assert.match(request.body, /grant_type=refresh_token/u);
      return {
        status: 200,
        body: JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 1800,
          token_type: "Bearer",
        }),
      };
    },
  });

  assert.equal(tokens.accessToken, "new-access");
  assert.equal(tokens.refreshToken, "new-refresh");
});
