import {
  ButtonRow,
  Form,
  LabelRow,
  OAuthButtonRow,
  Section,
  type FormSectionElement,
} from "@paperback/types";

import {
  DEFAULT_MAL_CLIENT_ID,
  MAL_AUTHORIZE_ENDPOINT,
  MAL_TOKEN_ENDPOINT,
  getMalAccessToken,
  setMalTokens,
} from "../auth.js";

export class MALSettingsForm extends Form {
  override getSections(): FormSectionElement<unknown>[] {
    const signedIn = getMalAccessToken() !== undefined;
    return [
      Section({ id: "auth", header: "MyAnimeList" }, [
        signedIn
          ? LabelRow("status", { title: "Status", subtitle: "Signed in" })
          : OAuthButtonRow("login", {
              title: "Sign In",
              authorizeEndpoint: MAL_AUTHORIZE_ENDPOINT,
              responseType: {
                type: "pkce",
                tokenEndpoint: MAL_TOKEN_ENDPOINT,
                pkceCodeLength: 64,
                pkceCodeMethod: "plain",
                formEncodeGrant: true,
              },
              clientId:
                (Application.getState("malClientId") as string | undefined) ??
                DEFAULT_MAL_CLIENT_ID,
              onSuccess: Application.Selector(this as MALSettingsForm, "handleLoginSuccess"),
            }),
        signedIn
          ? ButtonRow("logout", {
              title: "Sign Out",
              onSelect: Application.Selector(this as MALSettingsForm, "handleLogout"),
            })
          : undefined,
      ]),
    ];
  }

  async handleLoginSuccess(refreshToken: string, accessToken: string): Promise<void> {
    setMalTokens(refreshToken, accessToken);
    this.reloadForm();
  }

  async handleLogout(): Promise<void> {
    setMalTokens(undefined, undefined);
    this.reloadForm();
  }
}
