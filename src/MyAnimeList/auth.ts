export const MAL_AUTHORIZE_ENDPOINT = "https://myanimelist.net/v1/oauth2/authorize";
export const MAL_TOKEN_ENDPOINT = "https://myanimelist.net/v1/oauth2/token";
export const DEFAULT_MAL_CLIENT_ID = "5a7227c9c7bc0f28fe4372d791f5971f";

export function getMalAccessToken(): string | undefined {
  return Application.getSecureState("malAccessToken") as string | undefined;
}

export function setMalTokens(
  refreshToken: string | undefined,
  accessToken: string | undefined,
): void {
  Application.setSecureState(accessToken, "malAccessToken");
  Application.setSecureState(refreshToken, "malRefreshToken");
}
