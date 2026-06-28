import assert from "node:assert/strict";
import test from "node:test";

import { progressEventsEndpoint } from "../../src/Kavita/progress-bridge.js";

test("builds progress bridge event endpoint when Paperback runtime has no URL constructor", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "URL");
  Object.defineProperty(globalThis, "URL", { configurable: true, value: undefined });
  try {
    assert.equal(
      progressEventsEndpoint("http://192.168.50.138:5265/"),
      "http://192.168.50.138:5265/api/progress-events",
    );
    assert.equal(
      progressEventsEndpoint("https://read.negev.red/mock?token=secret#debug"),
      "https://read.negev.red/mock/api/progress-events",
    );
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "URL", descriptor);
    }
  }
});
