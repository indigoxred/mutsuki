import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { enqueueMalUpdate, processOutboxOnce } from "../../apps/kavita-mal-bridge/src/outbox.js";
import {
  DEFAULT_SOURCE_POLICY,
  SqliteBridgeStore,
} from "../../apps/kavita-mal-bridge/src/storage.js";

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
    await store.appendReadEvent({
      schemaVersion: 2,
      eventSource: "paperback-progress-bridge",
      readingSourceId: "MangaDex",
      readingSourceName: "MangaDex",
      readingSourceKind: "external",
      actionId: "read-event-1",
      occurredAt: "2026-06-26T00:00:00.000Z",
      receivedAt: "2026-06-26T00:00:01.000Z",
      sourceMangaId: "mangadex-title-1",
      sourceChapterId: "chapter-1",
      sourceTitle: "External Story",
      sourceChapterNumber: 1,
      chapterKind: "manga",
      rawEventJson: "{}",
    });
    await store.upsertSourcePolicy({
      ...DEFAULT_SOURCE_POLICY,
      readingSourceId: "MangaDex",
      readingSourceName: "MangaDex",
      kavitaMirrorMode: "disabled",
    });
    await store.upsertExternalSeriesMapping({
      readingSourceId: "MangaDex",
      sourceMangaId: "mangadex-title-1",
      readingSourceName: "MangaDex",
      title: "External Story",
      malId: 321,
      matchMethod: "title-search",
      confidence: 0.95,
      locked: false,
      chapterOffset: 0,
      volumeOffset: 0,
      trackingMode: "chapter-and-volume",
      lastObservedChapter: 5,
      lastObservedVolume: 0,
      lastPushedChapter: 0,
      lastPushedVolume: 0,
    });
    await store.enqueueExternalReview({
      readingSourceId: "WeebCentral",
      sourceMangaId: "weeb-title-1",
      readingSourceName: "WeebCentral",
      title: "Needs External Review",
      reason: "ambiguous-or-low-confidence",
      candidatesJson: "[]",
    });
    await store.ignoreExternalSeries({
      readingSourceId: "MangaDex",
      sourceMangaId: "ignored-title-1",
      readingSourceName: "MangaDex",
      title: "Ignored External Story",
      reason: "manual-ignore",
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
    const readEvents = await reopened.listReadEvents();
    assert.equal(readEvents.length, 1);
    assert.equal(readEvents[0]?.readingSourceId, "MangaDex");
    assert.equal(readEvents[0]?.readingSourceKind, "external");
    assert.equal(readEvents[0]?.sourceTitle, "External Story");
    const policy = await reopened.getSourcePolicy("MangaDex");
    assert.equal(policy?.malEnabled, true);
    assert.equal(policy?.kavitaMirrorMode, "disabled");
    assert.equal((await reopened.listExternalSeriesMappings())[0]?.malId, 321);
    assert.equal((await reopened.listExternalReviews())[0]?.title, "Needs External Review");
    assert.equal(await reopened.isExternalSeriesIgnored("MangaDex", "ignored-title-1"), true);
    assert.equal((await reopened.listExternalIgnoredSeries())[0]?.title, "Ignored External Story");
    await enqueueMalUpdate(reopened, {
      kavitaSeriesId: -77,
      targetType: "external",
      targetKey: "external:MangaDex:mangadex-title-1",
      targetTitle: "External Story",
      malId: 321,
      update: { num_chapters_read: 8 },
      reason: "paperback-external-read-event",
    });
    await processOutboxOnce({
      store: reopened,
      dryRun: false,
      updateMal: async () => ({ ok: true }),
    });
    const externalMapping = await reopened.getExternalSeriesMapping("MangaDex", "mangadex-title-1");
    assert.equal(externalMapping?.lastPushedChapter, 8);

    store.close();
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
