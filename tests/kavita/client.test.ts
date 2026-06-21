import assert from "node:assert/strict";
import test from "node:test";

import { KavitaClient, KavitaRequestError, type KavitaRequest } from "../../src/Kavita/client.js";

test("constructs current Kavita book and reader endpoints with sanitized auth", async () => {
  const requests: { url: string; method: string; headers?: Record<string, string> }[] = [];
  const client = new KavitaClient({
    baseUrl: "http://localhost:5000/api",
    apiKey: "secret-key",
    transport: async (request) => {
      requests.push(request);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      };
    },
  });

  await client.testConnection();
  await client.getBookInfo(12);
  await client.getBookChapters(12);
  await client.getBookPage(12, 3);
  await client.markChapterRead({ seriesId: 7, chapterId: 12 });

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url}`),
    [
      "GET http://localhost:5000/api/Account",
      "GET http://localhost:5000/api/Book/12/book-info",
      "GET http://localhost:5000/api/Book/12/chapters",
      "GET http://localhost:5000/api/Book/12/book-page?page=3",
      "POST http://localhost:5000/api/Reader/mark-chapter-read",
    ],
  );
  assert.equal(requests[0]?.headers?.["x-api-key"], "secret-key");
  assert.equal(requests[0]?.headers?.Authorization, undefined);
});

test("builds authenticated image URLs only for the configured Kavita host", () => {
  const client = new KavitaClient({
    baseUrl: "https://kavita.example.test",
    apiKey: "secret-key",
    transport: async () => ({ status: 200, headers: {}, body: "" }),
  });

  assert.equal(
    client.getImagePageUrl({ chapterId: 55, page: 2, extractPdf: true }),
    "https://kavita.example.test/api/Reader/image?chapterId=55&page=2&extractPdf=true&apiKey=secret-key",
  );
  assert.equal(
    client.getSeriesCoverUrl(42),
    "https://kavita.example.test/api/Image/series-cover?seriesId=42&apiKey=secret-key",
  );
});

test("uses current Kavita REST routes for browse and search", async () => {
  const requests: KavitaRequest[] = [];
  const client = new KavitaClient({
    baseUrl: "https://kavita.example.test/api",
    apiKey: "secret-key",
    transport: async (request) => {
      requests.push(request);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify([]),
      };
    },
  });

  await client.getAllSeries(0, 40);
  await client.getOnDeck(0, 40);
  await client.getRecentlyUpdated(0, 40);
  await client.getNewlyAdded(0, 40);
  await client.searchSeries("chainsaw man", 0, 40);

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url}`),
    [
      "POST https://kavita.example.test/api/Series/all-v2?pageNumber=0&pageSize=40",
      "POST https://kavita.example.test/api/Series/on-deck?pageNumber=0&pageSize=40",
      "POST https://kavita.example.test/api/Series/recently-updated-series?pageNumber=0&pageSize=40",
      "POST https://kavita.example.test/api/Series/recently-added-v2?pageNumber=0&pageSize=40",
      "GET https://kavita.example.test/api/Search/search?queryString=chainsaw%20man&includeChapterAndFiles=false",
    ],
  );
  assert.equal(requests[0]?.body, JSON.stringify({ statements: [], combination: 0 }));
  assert.equal(requests[1]?.body, undefined);
  assert.equal(requests[2]?.body, undefined);
  assert.equal(requests[3]?.body, JSON.stringify({ statements: [], combination: 0 }));
});

test("treats missing book resources as unavailable without weakening other endpoints", async () => {
  const requests: KavitaRequest[] = [];
  const client = new KavitaClient({
    baseUrl: "https://kavita.example.test",
    apiKey: "secret-key",
    transport: async (request) => {
      requests.push(request);
      if (request.url.includes("/book-resources")) {
        return {
          status: 400,
          headers: { "content-type": "text/plain" },
          body: "File was not found in book",
        };
      }
      return {
        status: 400,
        headers: { "content-type": "text/plain" },
        body: "File was not found in book",
      };
    },
  });

  assert.equal(await client.getBookResource(65572, "item/style/style-reset.css"), undefined);
  await assert.rejects(client.getBookPage(65572, 0), KavitaRequestError);
  assert.equal(requests[0]?.url.includes("apiKey="), false);
});

test("keeps authentication, retryable, and server resource failures fatal", async () => {
  for (const status of [401, 403, 429, 500]) {
    const client = new KavitaClient({
      baseUrl: "https://kavita.example.test",
      apiKey: "secret-key",
      transport: async () => ({
        status,
        headers: { "content-type": "text/plain" },
        body: "Nope",
      }),
    });

    await assert.rejects(
      client.getBookResource(55, "images/cover.jpg"),
      (error: unknown) =>
        error instanceof KavitaRequestError &&
        error.status === status &&
        error.path === "/Book/55/book-resources" &&
        !error.message.includes("secret-key") &&
        !error.message.includes("apiKey"),
    );
  }
});
