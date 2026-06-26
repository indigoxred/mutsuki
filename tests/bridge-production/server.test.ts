import assert from "node:assert/strict";
import test from "node:test";

import { createKavitaMalBridgeServer } from "../../apps/kavita-mal-bridge/src/server.js";
import { SqliteBridgeStore } from "../../apps/kavita-mal-bridge/src/storage.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("bridge server exposes status and unresolved review API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-server-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  await store.enqueueReview({
    kavitaSeriesId: 99,
    title: "Needs Review",
    reason: "ambiguous-or-low-confidence",
    candidatesJson: "[]",
  });

  const server = createKavitaMalBridgeServer({
    store,
    dryRun: true,
    schedulerStatus: () => ({
      intervalMs: 600_000,
      lastResult: {
        skipped: false,
        startedAt: "2026-06-26T00:00:00.000Z",
        finishedAt: "2026-06-26T00:00:01.000Z",
      },
    }),
    runSync: async () => ({
      seriesSeen: 0,
      autoMatched: 0,
      reviewQueued: 0,
      updatesQueued: 0,
      outboxProcessed: 0,
      outboxSucceeded: 0,
      outboxFailed: 0,
    }),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.equal(typeof address, "object");
    const port = address && typeof address === "object" ? address.port : 0;

    const status = await fetchJson(`http://127.0.0.1:${port}/api/status`);
    const reviews = await fetchJson(`http://127.0.0.1:${port}/api/unresolved-matches`);

    assert.equal(status.dryRun, true);
    assert.equal(status.scheduler.intervalSeconds, 600);
    assert.equal(status.scheduler.lastResult.skipped, false);
    assert.equal(reviews.items.length, 1);
    assert.equal(reviews.items[0].title, "Needs Review");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge server notifies scheduler when poll interval settings change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-server-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  const rescheduledIntervals: number[] = [];
  const server = createKavitaMalBridgeServer({
    store,
    dryRun: true,
    runSync: async () => ({
      seriesSeen: 0,
      autoMatched: 0,
      reviewQueued: 0,
      updatesQueued: 0,
      outboxProcessed: 0,
      outboxSucceeded: 0,
      outboxFailed: 0,
    }),
    onSettingsSaved: async () => {
      rescheduledIntervals.push(Number(await store.getSetting("pollIntervalSeconds")));
    },
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;

    await postJson(`http://127.0.0.1:${port}/api/settings`, {
      pollIntervalSeconds: 900,
    });

    assert.deepEqual(rescheduledIntervals, [900]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge server exposes readiness checks without leaking configured secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-server-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  await store.saveSetting("kavitaBaseUrl", "https://read.example.test");
  await store.saveSetting("kavitaApiKey", "secret-key");
  const server = createKavitaMalBridgeServer({
    store,
    dryRun: true,
    runSync: async () => ({
      seriesSeen: 0,
      autoMatched: 0,
      reviewQueued: 0,
      updatesQueued: 0,
      outboxProcessed: 0,
      outboxSucceeded: 0,
      outboxFailed: 0,
    }),
    checkReadiness: async () => ({
      kavita: { configured: true, ok: true, seriesSeen: 12 },
      mal: { oauthConfigured: true, authorized: true, ok: true },
    }),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;

    const readiness = await fetchJson(`http://127.0.0.1:${port}/api/readiness`);
    const text = JSON.stringify(readiness);

    assert.equal(readiness.kavita.ok, true);
    assert.equal(readiness.kavita.seriesSeen, 12);
    assert.equal(readiness.mal.authorized, true);
    assert.doesNotMatch(text, /secret-key/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge home page exposes setup, OAuth, and review approval controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-server-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  await store.enqueueReview({
    kavitaSeriesId: 77,
    title: "Needs Approval",
    reason: "ambiguous-or-low-confidence",
    candidatesJson: JSON.stringify([{ malId: 123, title: "Candidate" }]),
  });

  const server = createKavitaMalBridgeServer({
    store,
    dryRun: true,
    runSync: async () => ({
      seriesSeen: 0,
      autoMatched: 0,
      reviewQueued: 0,
      updatesQueued: 0,
      outboxProcessed: 0,
      outboxSucceeded: 0,
      outboxFailed: 0,
    }),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();

    assert.match(html, /name="kavitaBaseUrl"/u);
    assert.match(html, /\/api\/mal\/oauth\/start/u);
    assert.match(html, /\/api\/unresolved-matches\/77\/approve/u);
    assert.doesNotMatch(html, /secret-key/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge server can save settings and approve an unresolved MAL mapping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-server-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  await store.enqueueReview({
    kavitaSeriesId: 99,
    title: "Needs Review",
    reason: "ambiguous-or-low-confidence",
    candidatesJson: "[]",
  });
  const server = createKavitaMalBridgeServer({
    store,
    dryRun: true,
    runSync: async () => ({
      seriesSeen: 0,
      autoMatched: 0,
      reviewQueued: 0,
      updatesQueued: 0,
      outboxProcessed: 0,
      outboxSucceeded: 0,
      outboxFailed: 0,
    }),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;

    await postJson(`http://127.0.0.1:${port}/api/settings`, {
      kavitaBaseUrl: "https://read.example.test",
      kavitaApiKey: "secret-key",
      dryRun: true,
      pollIntervalSeconds: 600,
    });
    await postJson(`http://127.0.0.1:${port}/api/unresolved-matches/99/approve`, {
      malId: 12345,
      trackingMode: "volume-only",
      chapterOffset: 0,
      volumeOffset: 1,
    });

    assert.equal(await store.getSetting("kavitaBaseUrl"), "https://read.example.test");
    assert.equal((await store.getSeriesMapping(99))?.malId, 12345);
    assert.equal((await store.getSeriesMapping(99))?.locked, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge server can override an existing MAL mapping and tracking policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-server-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  await store.upsertSeriesMapping({
    kavitaSeriesId: 44,
    kavitaLibraryId: 3,
    malId: 111,
    matchMethod: "mal-url",
    confidence: 1,
    locked: false,
    chapterOffset: 0,
    volumeOffset: 0,
    trackingMode: "chapter-and-volume",
    lastObservedChapter: 10,
    lastObservedVolume: 2,
    lastPushedChapter: 8,
    lastPushedVolume: 1,
  });
  const server = createKavitaMalBridgeServer({
    store,
    dryRun: true,
    runSync: async () => ({
      seriesSeen: 0,
      autoMatched: 0,
      reviewQueued: 0,
      updatesQueued: 0,
      outboxProcessed: 0,
      outboxSucceeded: 0,
      outboxFailed: 0,
    }),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;

    await postJson(`http://127.0.0.1:${port}/api/mappings/44`, {
      malId: 222,
      trackingMode: "volume-only",
      chapterOffset: -1,
      volumeOffset: 2,
      locked: true,
    });

    const mapping = await store.getSeriesMapping(44);
    assert.equal(mapping?.malId, 222);
    assert.equal(mapping?.matchMethod, "manual-override");
    assert.equal(mapping?.locked, true);
    assert.equal(mapping?.trackingMode, "volume-only");
    assert.equal(mapping?.chapterOffset, -1);
    assert.equal(mapping?.volumeOffset, 2);
    assert.equal(mapping?.lastObservedChapter, 10);
    assert.equal(mapping?.lastPushedChapter, 8);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge server starts and completes MAL OAuth with persisted settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-server-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  await store.saveSetting("malClientId", "client-id");
  await store.saveSetting("malClientSecret", "client-secret");
  await store.saveSetting("malRedirectUri", "http://127.0.0.1/callback");
  const tokenRequests: string[] = [];

  const server = createKavitaMalBridgeServer({
    store,
    dryRun: true,
    runSync: async () => ({
      seriesSeen: 0,
      autoMatched: 0,
      reviewQueued: 0,
      updatesQueued: 0,
      outboxProcessed: 0,
      outboxSucceeded: 0,
      outboxFailed: 0,
    }),
    oauthTransport: async (request) => {
      tokenRequests.push(request.body);
      return {
        status: 200,
        body: JSON.stringify({
          access_token: "access-from-callback",
          refresh_token: "refresh-from-callback",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      };
    },
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;

    const start = await fetch(`http://127.0.0.1:${port}/api/mal/oauth/start`, {
      redirect: "manual",
    });
    assert.equal(start.status, 302);
    const location = start.headers.get("location");
    assert.ok(location);
    const state = new URL(location).searchParams.get("state");
    assert.ok(state);
    assert.equal((await store.getOAuthState(state))?.state, state);

    const callback = await fetch(
      `http://127.0.0.1:${port}/api/mal/oauth/callback?state=${state}&code=auth-code`,
    );
    assert.equal(callback.status, 200);
    assert.match(tokenRequests[0] ?? "", /code=auth-code/u);
    assert.equal((await store.getOAuthTokens())?.accessToken, "access-from-callback");
    assert.equal(await store.getOAuthState(state), undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}
