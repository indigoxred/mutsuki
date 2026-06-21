import assert from "node:assert/strict";
import test from "node:test";

import { KavitaClient } from "../../src/Kavita/client.js";

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

  await client.getBookInfo(12);
  await client.getBookChapters(12);
  await client.getBookPage(12, 3);
  await client.markChapterRead({ seriesId: 7, chapterId: 12 });

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url}`),
    [
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
});
