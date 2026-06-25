import assert from "node:assert/strict";
import { type AddressInfo } from "node:net";
import test from "node:test";

import {
  createMemoryProgressEventStore,
  createMockProgressBridgeServer,
} from "../../apps/mock-progress-bridge/src/server.js";

test("mock progress bridge receives events and displays them", async () => {
  const store = createMemoryProgressEventStore();
  const server = createMockProgressBridgeServer({ store });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const event = {
      version: 1,
      source: "paperback-mutsuki",
      actionId: "read-1",
      occurredAt: "2026-06-23T00:00:00.000Z",
      receivedAt: "2026-06-23T00:00:00.000Z",
      mangaId: "kavita-series:7",
      paperbackChapterId: "kavita-chapter:55",
      kavitaSeriesId: 7,
      kavitaChapterId: 55,
      chapterKind: "manga",
      chapterNum: 12,
      chapterVolume: 3,
      isLastInVolume: false,
      shouldMarkKavitaRead: true,
      kavitaMarkedRead: true,
      title: "Chapter 12",
      listingMode: "",
      role: "",
    };

    const post = await fetch(`${baseUrl}/api/progress-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    assert.equal(post.status, 202);

    const list = await fetch(`${baseUrl}/api/progress-events`);
    assert.equal(list.status, 200);
    const payload = (await list.json()) as { events: (typeof event)[] };
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0]?.actionId, "read-1");

    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Mutsuki Progress Bridge/u);
    assert.match(html, /kavita-chapter:55/u);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error: Error | undefined) => (error ? reject(error) : resolve())),
    );
  }
});

test("mock progress bridge accepts generic Paperback tracker events", async () => {
  const store = createMemoryProgressEventStore();
  const server = createMockProgressBridgeServer({ store });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const event = {
      version: 1,
      source: "paperback-progress-provider",
      actionId: "generic-read-1",
      occurredAt: "2026-06-25T00:00:00.000Z",
      receivedAt: "2026-06-25T00:00:00.000Z",
      mangaId: "bridge-track:a-story",
      paperbackChapterId: "05bab466-2efc-488f-bea9-90ca849c4f11",
      chapterSourceId: "MangaDex",
      chapterMangaId: "mangadex-title-1",
      chapterKind: "manga",
      chapterNum: 1,
      isLastInVolume: false,
      shouldMarkKavitaRead: false,
      kavitaMarkedRead: false,
      title: "Chapter 1",
      listingMode: "tracker-bridge",
      role: "read-action",
    };

    const post = await fetch(`${baseUrl}/api/progress-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    assert.equal(post.status, 202);

    const list = await fetch(`${baseUrl}/api/progress-events`);
    const payload = (await list.json()) as { events: (typeof event)[] };
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0]?.chapterSourceId, "MangaDex");
    assert.equal(payload.events[0]?.chapterMangaId, "mangadex-title-1");

    const page = await fetch(baseUrl);
    const html = await page.text();
    assert.match(html, /MangaDex/u);
    assert.match(html, /05bab466-2efc-488f-bea9-90ca849c4f11/u);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error: Error | undefined) => (error ? reject(error) : resolve())),
    );
  }
});
