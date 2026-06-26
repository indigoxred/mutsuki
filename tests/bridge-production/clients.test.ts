import assert from "node:assert/strict";
import test from "node:test";

import {
  checkKavitaReadiness,
  checkMalReadiness,
  createKavitaClient,
} from "../../apps/kavita-mal-bridge/src/clients.js";
import { bridgeConfigFromEnv } from "../../apps/kavita-mal-bridge/src/config.js";

test("Kavita readiness uses a lightweight series probe without fetching volume progress", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url =
        input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
      seenUrls.push(url);
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["x-api-key"], "secret-key");
      if (url === "https://read.example.test/api/Series/all-v2?pageNumber=0&pageSize=1") {
        return new Response(JSON.stringify([{ id: 1, name: "Series", libraryId: 2 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`readiness made an expensive or unexpected request to ${url}`);
    };

    const result = await checkKavitaReadiness({
      ...bridgeConfigFromEnv({}),
      kavitaBaseUrl: "https://read.example.test",
      kavitaApiKey: "secret-key",
    });

    assert.equal(result.configured, true);
    assert.equal(result.ok, true);
    assert.equal(result.seriesSeen, 1);
    assert.deepEqual(seenUrls, [
      "https://read.example.test/api/Series/all-v2?pageNumber=0&pageSize=1",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kavita client derives read progress from current volume and chapter DTOs", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url =
        input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
      seenUrls.push(url);
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["x-api-key"], "secret-key");

      if (url === "https://read.example.test/api/Series/all-v2") {
        return new Response(
          JSON.stringify([
            {
              id: 42,
              name: "Kavita Progress Series",
              libraryId: 7,
              format: "Manga",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url === "https://read.example.test/api/Series/volumes?seriesId=42") {
        return new Response(
          JSON.stringify([
            {
              id: 100,
              minNumber: 1,
              maxNumber: 1,
              pages: 30,
              pagesRead: 30,
              chapters: [
                {
                  id: 1001,
                  minNumber: 1,
                  maxNumber: 1,
                  pages: 10,
                  pagesRead: 10,
                  isSpecial: false,
                },
                {
                  id: 1002,
                  minNumber: 1.5,
                  maxNumber: 1.5,
                  pages: 5,
                  pagesRead: 5,
                  isSpecial: true,
                },
              ],
            },
            {
              id: 101,
              minNumber: 2,
              maxNumber: 2,
              pages: 40,
              pagesRead: 12,
              chapters: [
                {
                  id: 1003,
                  minNumber: 2,
                  maxNumber: 2,
                  pages: 20,
                  pagesRead: 20,
                  isSpecial: false,
                },
                {
                  id: 1004,
                  minNumber: 3,
                  maxNumber: 3,
                  pages: 20,
                  pagesRead: 0,
                  isSpecial: false,
                },
              ],
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected URL ${url}`);
    };

    const series = await createKavitaClient({
      ...bridgeConfigFromEnv({}),
      kavitaBaseUrl: "https://read.example.test",
      kavitaApiKey: "secret-key",
    }).listSeries();

    assert.equal(series.length, 1);
    assert.equal(series[0]?.completedChapter, 2);
    assert.equal(series[0]?.completedVolume, 1);
    assert.deepEqual(seenUrls, [
      "https://read.example.test/api/Series/all-v2",
      "https://read.example.test/api/Series/volumes?seriesId=42",
    ]);
    assert.doesNotMatch(JSON.stringify(seenUrls), /secret-key/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kavita client keeps listing series when one volume progress request fails", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      const url =
        input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["x-api-key"], "secret-key");

      if (url === "https://read.example.test/api/Series/all-v2") {
        return new Response(
          JSON.stringify([
            { id: 1, name: "Transient Failure", libraryId: 7, format: "Manga" },
            { id: 2, name: "Healthy Series", libraryId: 7, format: "Manga" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url === "https://read.example.test/api/Series/volumes?seriesId=1") {
        return new Response("server error mentioning secret-key should not surface", {
          status: 500,
        });
      }

      if (url === "https://read.example.test/api/Series/volumes?seriesId=2") {
        return new Response(
          JSON.stringify([
            {
              id: 200,
              minNumber: 1,
              maxNumber: 1,
              pages: 10,
              pagesRead: 10,
              chapters: [
                {
                  id: 2001,
                  minNumber: 1,
                  maxNumber: 1,
                  pages: 10,
                  pagesRead: 10,
                  isSpecial: false,
                },
              ],
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected URL ${url}`);
    };

    const series = await createKavitaClient({
      ...bridgeConfigFromEnv({}),
      kavitaBaseUrl: "https://read.example.test",
      kavitaApiKey: "secret-key",
    }).listSeries();

    assert.equal(series.length, 2);
    assert.equal(series[0]?.title, "Transient Failure");
    assert.equal(series[0]?.completedChapter, undefined);
    assert.equal(series[0]?.completedVolume, undefined);
    assert.equal(series[1]?.title, "Healthy Series");
    assert.equal(series[1]?.completedChapter, 1);
    assert.equal(series[1]?.completedVolume, 1);
    assert.doesNotMatch(JSON.stringify(series), /secret-key/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kavita client derives standalone EPUB volume progress from sentinel special chapters", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      const url =
        input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["x-api-key"], "secret-key");

      if (url === "https://read.example.test/api/Series/all-v2") {
        return new Response(
          JSON.stringify([
            {
              id: 15003,
              name: "Baka to Tesuto to Syokanju:Volume10.5",
              libraryId: 7,
            },
            {
              id: 15662,
              name: "Baka to Tesuto to Syokanju:Volume2",
              libraryId: 7,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url === "https://read.example.test/api/Series/volumes?seriesId=15003") {
        return new Response(
          JSON.stringify([
            {
              id: 50802,
              minNumber: -100000,
              maxNumber: -100000,
              pages: 1,
              pagesRead: 1,
              chapters: [
                {
                  id: 67863,
                  minNumber: -100000,
                  maxNumber: -100000,
                  number: "-100000",
                  range: "Baka to Tesuto to Syokanju:Volume10.5",
                  pages: 1,
                  pagesRead: 1,
                  isSpecial: true,
                },
              ],
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url === "https://read.example.test/api/Series/volumes?seriesId=15662") {
        return new Response(
          JSON.stringify([
            {
              id: 52918,
              minNumber: -100000,
              maxNumber: -100000,
              pages: 1,
              pagesRead: 1,
              chapters: [
                {
                  id: 70018,
                  minNumber: -100000,
                  maxNumber: -100000,
                  number: "-100000",
                  range: "Baka to Tesuto to Syokanju:Volume2",
                  pages: 1,
                  pagesRead: 1,
                  totalReads: 1,
                  isSpecial: true,
                },
              ],
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected URL ${url}`);
    };

    const series = await createKavitaClient({
      ...bridgeConfigFromEnv({}),
      kavitaBaseUrl: "https://read.example.test",
      kavitaApiKey: "secret-key",
    }).listSeries();

    assert.equal(series[0]?.completedChapter, undefined);
    assert.equal(series[0]?.completedVolume, 10.5);
    assert.equal(series[0]?.contentType, "novel");
    assert.equal(series[1]?.completedChapter, undefined);
    assert.equal(series[1]?.completedVolume, 2);
    assert.equal(series[1]?.contentType, "novel");
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
