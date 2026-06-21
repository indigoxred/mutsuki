import assert from "node:assert/strict";
import test from "node:test";

import type { KavitaRequest } from "../../src/Kavita/client.js";
import { DEFAULT_KAVITA_SETTINGS, KavitaSettingsForm } from "../../src/Kavita/settings.js";

test("novel rendering mode defaults to full EPUB rendering", () => {
  assert.equal(DEFAULT_KAVITA_SETTINGS.novelRenderingMode, "full-epub");
});

test("settings test connection probes the current account endpoint", async () => {
  const requests: KavitaRequest[] = [];
  installApplicationStub({
    scheduleRequest: async (request: KavitaRequest) => {
      requests.push(request);
      return [
        { status: 200, headers: { "content-type": "application/json" } },
        new TextEncoder().encode("{}").buffer,
      ];
    },
  });

  const form = new KavitaSettingsForm();
  Object.defineProperty(form, "reloadForm", { value: () => undefined });

  await form.handleTestConnection();

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url}`),
    ["GET https://kavita.example.test/api/Account"],
  );
  assert.equal(requests[0]?.headers?.["x-api-key"], "secret-key");
});

function installApplicationStub(input: {
  scheduleRequest: (request: KavitaRequest) => Promise<unknown>;
}): void {
  Object.defineProperty(globalThis, "Application", {
    configurable: true,
    value: {
      getState: () => ({ ...DEFAULT_KAVITA_SETTINGS, baseUrl: "https://kavita.example.test" }),
      getSecureState: () => "secret-key",
      setState: () => undefined,
      setSecureState: () => undefined,
      Selector: () => undefined,
      scheduleRequest: input.scheduleRequest,
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
    },
  });
}
