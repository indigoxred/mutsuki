import assert from "node:assert/strict";
import test from "node:test";

import { isSameOrigin, normalizeKavitaBaseUrl, toKavitaApiUrl } from "../../src/shared/url.js";

test("normalizes root and api Kavita URLs without duplicating api", () => {
  assert.equal(normalizeKavitaBaseUrl("http://localhost:5000"), "http://localhost:5000");
  assert.equal(normalizeKavitaBaseUrl("http://localhost:5000/"), "http://localhost:5000");
  assert.equal(normalizeKavitaBaseUrl("http://192.168.50.138:5000/"), "http://192.168.50.138:5000");
  assert.equal(normalizeKavitaBaseUrl("http://localhost:5000/api"), "http://localhost:5000");
  assert.equal(
    toKavitaApiUrl("http://localhost:5000/api", "/Book/12/book-info"),
    "http://localhost:5000/api/Book/12/book-info",
  );
});

test("normalizes LAN Kavita URLs when the runtime has no URL constructor", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "URL");
  Object.defineProperty(globalThis, "URL", { configurable: true, value: undefined });
  try {
    assert.equal(
      normalizeKavitaBaseUrl("http://192.168.50.138:5000/"),
      "http://192.168.50.138:5000",
    );
    assert.equal(
      toKavitaApiUrl("http://192.168.50.138:5000/api", "/Account/validate"),
      "http://192.168.50.138:5000/api/Account/validate",
    );
    assert.equal(
      isSameOrigin(
        "http://192.168.50.138:5000/",
        "http://192.168.50.138:5000/api/Library/libraries",
      ),
      true,
    );
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "URL", descriptor);
    }
  }
});

test("same origin checks prevent sending credentials to another host", () => {
  const baseUrl = normalizeKavitaBaseUrl("https://kavita.example.test/api");
  assert.equal(isSameOrigin(baseUrl, "https://kavita.example.test/api/Library/libraries"), true);
  assert.equal(isSameOrigin(baseUrl, "https://evil.example.test/api/Library/libraries"), false);
});

test("rejects blank or unsupported Kavita URLs", () => {
  assert.throws(() => normalizeKavitaBaseUrl(""), /Kavita URL is required/);
  assert.throws(() => normalizeKavitaBaseUrl("ftp://example.test"), /http or https/);
});
