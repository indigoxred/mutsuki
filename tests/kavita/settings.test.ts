import assert from "node:assert/strict";
import test from "node:test";

import type { KavitaRequest } from "../../src/Kavita/client.js";
import { DEFAULT_KAVITA_SETTINGS, KavitaSettingsForm } from "../../src/Kavita/settings.js";

test("novel rendering mode defaults to full EPUB rendering", () => {
  assert.equal(DEFAULT_KAVITA_SETTINGS.novelRenderingMode, "full-epub");
});

test("novel listing mode defaults to physical Kavita books", () => {
  assert.equal(DEFAULT_KAVITA_SETTINGS.novelListingMode, "physical-books");
  assert.equal(DEFAULT_KAVITA_SETTINGS.includePublisherExtras, false);
});

test("large EPUB handling defaults to automatic bounded splitting", () => {
  assert.equal(DEFAULT_KAVITA_SETTINGS.largeEpubHandling, "auto-split");
  assert.equal(DEFAULT_KAVITA_SETTINGS.targetSourcePagesPerPart, 96);
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

test("settings expose a direct diagnostic mock bridge test event action", () => {
  installApplicationStub({
    scheduleRequest: async () => {
      throw new Error("form inspection should not send requests");
    },
  });

  const form = new KavitaSettingsForm();
  const serialized = JSON.stringify(form.getSections());

  assert.match(serialized, /Send mock bridge test event/u);
});

test("settings mock bridge test action sends one sanitized synthetic event", async () => {
  const requests: KavitaRequest[] = [];
  installApplicationStub({
    scheduleRequest: async (request: KavitaRequest) => {
      requests.push(request);
      return [
        { status: 202, headers: { "content-type": "application/json" } },
        new TextEncoder().encode("{}").buffer,
      ];
    },
    state: {
      ...DEFAULT_KAVITA_SETTINGS,
      baseUrl: "https://kavita.example.test",
      progressBridgeUrl: "http://bridge.example.test",
    },
    secureState: (key) => (key === "kavitaProgressBridgeToken" ? "bridge-token" : "secret-key"),
  });

  const form = new KavitaSettingsForm();
  Object.defineProperty(form, "reloadForm", { value: () => undefined });

  await form.handleSendMockBridgeTestEvent();

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.url, "http://bridge.example.test/api/progress-events");
  assert.equal(requests[0]?.headers?.Authorization, "Bearer bridge-token");
  const payload = JSON.parse(requests[0]?.body ?? "{}") as { title?: string; actionId?: string };
  assert.equal(payload.actionId, "diagnostic-settings-test");
  assert.equal(payload.title, "Mutsuki diagnostic mock bridge test event");
  assert.equal(JSON.stringify(payload).includes("secret-key"), false);
  assert.equal(JSON.stringify(payload).includes("bridge-token"), false);
});

function installApplicationStub(input: {
  scheduleRequest: (request: KavitaRequest) => Promise<unknown>;
  state?: Partial<typeof DEFAULT_KAVITA_SETTINGS>;
  secureState?: (key: string) => string;
}): void {
  Object.defineProperty(globalThis, "Application", {
    configurable: true,
    value: {
      getState: () =>
        input.state ?? { ...DEFAULT_KAVITA_SETTINGS, baseUrl: "https://kavita.example.test" },
      getSecureState: input.secureState ?? (() => "secret-key"),
      setState: () => undefined,
      setSecureState: () => undefined,
      Selector: () => undefined,
      scheduleRequest: input.scheduleRequest,
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
    },
  });
}
