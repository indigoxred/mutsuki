import { randomBytes as nodeRandomBytes } from "node:crypto";

import type { OAuthStateRecord, OAuthTokenRecord } from "./storage.js";

export interface OAuthTransportRequest {
  url: string;
  body: string;
}

export type OAuthTransport = (
  request: OAuthTransportRequest,
) => Promise<{ status: number; body: string }>;

export function buildMalAuthorizationRequest(input: {
  clientId: string;
  redirectUri: string;
  now?: () => Date;
  randomBytes?: () => Buffer;
}): { authorizationUrl: string; stateRecord: OAuthStateRecord } {
  const codeVerifier = base64Url(input.randomBytes?.() ?? nodeRandomBytes(48));
  const state = base64Url(input.randomBytes?.() ?? nodeRandomBytes(32));
  const url = new URL("https://myanimelist.net/v1/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", codeVerifier);
  url.searchParams.set("code_challenge_method", "plain");
  url.searchParams.set("state", state);
  return {
    authorizationUrl: url.toString(),
    stateRecord: {
      state,
      codeVerifier,
      createdAt: (input.now?.() ?? new Date()).toISOString(),
    },
  };
}

export async function exchangeMalAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  transport?: OAuthTransport;
  now?: () => Date;
}): Promise<OAuthTokenRecord> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  return tokenFromResponse(
    await (input.transport ?? defaultTransport)({
      url: "https://myanimelist.net/v1/oauth2/token",
      body: body.toString(),
    }),
    input.now?.() ?? new Date(),
  );
}

export async function refreshMalAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  transport?: OAuthTransport;
  now?: () => Date;
}): Promise<OAuthTokenRecord> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  return tokenFromResponse(
    await (input.transport ?? defaultTransport)({
      url: "https://myanimelist.net/v1/oauth2/token",
      body: body.toString(),
    }),
    input.now?.() ?? new Date(),
  );
}

async function defaultTransport(request: OAuthTransportRequest): Promise<{
  status: number;
  body: string;
}> {
  const response = await fetch(request.url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: request.body,
  });
  return { status: response.status, body: await response.text() };
}

function tokenFromResponse(
  response: { status: number; body: string },
  now: Date,
): OAuthTokenRecord {
  if (response.status !== 200) {
    throw new Error(`MAL OAuth token request failed with status ${response.status}.`);
  }
  const json = JSON.parse(response.body) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  if (!json.access_token || !json.refresh_token) {
    throw new Error("MAL OAuth response did not include access and refresh tokens.");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(now.getTime() + (json.expires_in ?? 0) * 1000).toISOString(),
    tokenType: json.token_type ?? "Bearer",
  };
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}
