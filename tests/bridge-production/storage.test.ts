import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { enqueueMalUpdate, processOutboxOnce } from "../../apps/kavita-mal-bridge/src/outbox.js";
import { SqliteBridgeStore } from "../../apps/kavita-mal-bridge/src/storage.js";

test("SQLite store persists mappings, outbox items, review queue, and audit logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-bridge-"));
  const dbPath = join(directory, "bridge.sqlite");
  try {
    const store = new SqliteBridgeStore(dbPath);
    store.migrate();

    await store.upsertSeriesMapping({
      kavitaSeriesId: 44,
      kavitaLibraryId: 3,
      title: "Mapped Story",
      malId: 123,
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
    await store.enqueueReview({
      kavitaSeriesId: 45,
      title: "Ambiguous",
      reason: "ambiguous-or-low-confidence",
      candidatesJson: "[]",
    });
    await store.ignoreSeries({
      kavitaSeriesId: 46,
      title: "Do Not Track",
      reason: "manual-ignore",
    });
    await store.audit({
      type: "match",
      kavitaSeriesId: 44,
      message: "Matched via MAL URL",
    });
    await store.saveSetting("kavitaBaseUrl", "https://read.example.test");
    await store.saveOAuthState({
      state: "state-1",
      codeVerifier: "verifier-1",
      createdAt: "2026-06-26T00:00:00.000Z",
    });
    await store.saveOAuthTokens({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-06-26T01:00:00.000Z",
      tokenType: "Bearer",
    });

    const reopened = new SqliteBridgeStore(dbPath);
    reopened.migrate();

    assert.equal((await reopened.getSeriesMapping(44))?.malId, 123);
    assert.equal((await reopened.getSeriesMapping(44))?.title, "Mapped Story");
    await reopened.recordPushedProgress(44, { num_chapters_read: 12, num_volumes_read: 3 });
    await reopened.recordPushedProgress(44, { num_chapters_read: 11, num_volumes_read: 2 });
    const pushed = await reopened.getSeriesMapping(44);
    assert.equal(pushed?.lastPushedChapter, 12);
    assert.equal(pushed?.lastPushedVolume, 3);
    await enqueueMalUpdate(reopened, {
      kavitaSeriesId: 44,
      malId: 123,
      update: { num_chapters_read: 12 },
      reason: "progress-sync",
    });
    await processOutboxOnce({
      store: reopened,
      dryRun: true,
      updateMal: async () => {
        throw new Error("dry-run should not call MAL");
      },
    });
    const outbox = await reopened.listOutbox(10);
    const outboxCounts = await reopened.outboxCounts();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]?.status, "pending");
    assert.equal(outboxCounts.pending, 1);
    assert.equal(outboxCounts.succeeded, 0);
    assert.equal((await reopened.listReviews()).length, 1);
    assert.equal(await reopened.isSeriesIgnored(46), true);
    assert.equal((await reopened.listIgnoredSeries())[0]?.title, "Do Not Track");
    await reopened.restoreIgnoredSeries(46);
    assert.equal(await reopened.isSeriesIgnored(46), false);
    assert.equal((await reopened.listAuditLogs()).length, 1);
    assert.equal(await reopened.getSetting("kavitaBaseUrl"), "https://read.example.test");
    assert.equal((await reopened.getOAuthState("state-1"))?.codeVerifier, "verifier-1");
    assert.equal((await reopened.getOAuthTokens())?.accessToken, "access-token");

    store.close();
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
