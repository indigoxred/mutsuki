import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyBackfillRecord,
  filterBackfillRecords,
} from "../../apps/kavita-mal-bridge/src/backfill/filters.js";
import { parsePaperbackDebugLog } from "../../apps/kavita-mal-bridge/src/backfill/log-parser.js";
import { planBackfillPreview } from "../../apps/kavita-mal-bridge/src/backfill/planner.js";
import {
  parseHistoryProbeSubmission,
  type HistoryProbeEvent,
  type HistoryProbeSubmission,
} from "../../apps/kavita-mal-bridge/src/history-probe.js";
import { createKavitaMalBridgeServer } from "../../apps/kavita-mal-bridge/src/server.js";
import { SqliteBridgeStore } from "../../apps/kavita-mal-bridge/src/storage.js";

test("history probe endpoint stores sanitized records without enqueueing MAL writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-history-probe-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  const server = createKavitaMalBridgeServer({
    store,
    dryRun: true,
    runSync: async () => emptySyncResult(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;

    const payload: HistoryProbeSubmission = {
      schemaVersion: 1,
      probeRunId: "probe-run-1",
      source: "progress-bridge-settings-action",
      status: "sample-collected",
      createdAt: "2026-06-29T00:00:00.000Z",
      inspectedApis: [
        "Application.getState",
        "MangaProgressProviding.processChapterReadActionQueue",
      ],
      findings: [
        {
          code: "sample-collected",
          message:
            "Found diagnostic record at https://read.example.test/item?apiKey=secret with Authorization: Bearer token",
        },
      ],
      events: [
        {
          source: "Paperback",
          readingSourceId: "WeebCentral",
          sourceMangaId: "manga-1",
          sourceMangaTitle: "A Safe Title",
          sourceChapterId: "chapter-1",
          sourceChapterTitle: "Chapter 1",
          sourceChapterNumber: 1,
          completed: true,
          pagesRead: 20,
          totalPages: 20,
          completionPercent: 100,
          readAt: "2026-06-28T00:00:00.000Z",
          reliability: "reliable",
          rawRecordJson:
            '{"url":"https://img.example.test/p.jpg?apiKey=secret","headers":{"cookie":"abc","Authorization":"Bearer token"}}',
        },
      ],
    };

    const post = await fetch(`http://127.0.0.1:${port}/api/history-probe/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(post.status, 202);

    const status = await fetchJson(`http://127.0.0.1:${port}/api/history-probe/status`);
    const events = await fetchJson(`http://127.0.0.1:${port}/api/history-probe/events`);
    const outbox = await store.listOutbox(10);

    assert.equal(status.lastRun.probeRunId, "probe-run-1");
    assert.equal(status.lastRun.status, "sample-collected");
    assert.equal(status.recordCount, 1);
    assert.equal(status.reliability.reliable, 1);
    assert.equal(events.events.length, 1);
    assert.equal(events.events[0].sourceMangaTitle, "A Safe Title");
    assert.equal(events.events[0].completed, true);
    assert.doesNotMatch(JSON.stringify(events), /secret|Bearer token|cookie|apiKey=secret/iu);
    assert.equal(outbox.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("history API unavailable report is stored and exposed by status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-history-probe-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  const unavailable = parseHistoryProbeSubmission({
    schemaVersion: 1,
    probeRunId: "no-api-run",
    source: "progress-bridge-settings-action",
    status: "no-extension-accessible-history-api-found",
    createdAt: "2026-06-29T00:00:00.000Z",
    inspectedApis: ["Application", "MangaProgressProviding", "TrackedMangaChapterReadAction"],
    findings: [
      {
        code: "no-extension-accessible-history-api-found",
        message: "Installed Paperback types expose no local history reader.",
      },
    ],
    events: [],
  });

  try {
    await store.appendHistoryProbeSubmission(unavailable);
    const status = await store.historyProbeStatus();

    assert.equal(status.lastRun?.status, "no-extension-accessible-history-api-found");
    assert.equal(status.recordCount, 0);
    assert.equal(status.findings[0]?.code, "no-extension-accessible-history-api-found");
    assert.match(status.findings[0]?.message ?? "", /no local history reader/u);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Paperback debug log parser extracts only diagnostic candidates and redacts secrets", () => {
  const log = [
    "2026-06-28T00:00:00.000Z [PREFETCHER] PREFETCHING IMAGES FOR CHAPTER: [prefetch-chapter] Chapter 1",
    "2026-06-28T00:00:01.000Z Marked A Story - Vol. 2, Ch. 3 as COMPLETE",
    "2026-06-28T00:00:01.100Z Updated chapter progress for stable-chapter-3 to 10/10",
    "2026-06-28T00:00:02.000Z Updated chapter progress for accidental-click to 1/100",
    "2026-06-28T00:00:03.000Z Updated chapter progress for stable-chapter-3 to 10/10",
    "GET https://read.example.test/image.jpg?apiKey=secret Authorization: Bearer token Cookie: sess=abc",
  ].join("\n");

  const parsed = parsePaperbackDebugLog(log, { completionThresholdPercent: 80 });

  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0]?.sourceMangaTitle, "A Story");
  assert.equal(parsed.records[0]?.sourceChapterId, "stable-chapter-3");
  assert.equal(parsed.records[0]?.sourceChapterNumber, 3);
  assert.equal(parsed.records[0]?.sourceChapterVolume, 2);
  assert.equal(parsed.records[0]?.pagesRead, 10);
  assert.equal(parsed.records[0]?.totalPages, 10);
  assert.equal(parsed.records[0]?.completed, true);
  assert.equal(parsed.records[0]?.reliability, "weak");
  assert.equal(parsed.ignored.prefetch, 1);
  assert.equal(parsed.ignored.partialProgress, 1);
  assert.equal(parsed.ignored.duplicates, 1);
  assert.doesNotMatch(JSON.stringify(parsed), /secret|Bearer token|sess=abc|apiKey=secret/iu);
});

test("accidental-click filters keep records visible with reasons and never infer dropped", () => {
  const records = [
    historyRecord({ sourceMangaId: "manga-1", sourceChapterId: "chapter-1", pagesRead: 1 }),
    historyRecord({
      sourceMangaId: "manga-2",
      sourceChapterId: "chapter-1",
      pagesRead: 4,
      totalPages: 10,
      completionPercent: 40,
    }),
    historyRecord({ sourceMangaId: "manga-3", sourceChapterId: "chapter-1" }),
    historyRecord({ sourceMangaId: "manga-4", sourceChapterId: "chapter-1" }),
    historyRecord({
      sourceMangaId: "manga-4",
      sourceChapterId: "chapter-2",
      sourceChapterNumber: 2,
    }),
    historyRecord({
      sourceMangaId: "",
      sourceChapterId: "chapter-1",
      reliability: "weak",
    }),
  ];

  const filtered = filterBackfillRecords(records, {
    minDistinctCompletedChapters: 2,
    completionThresholdPercent: 80,
  });

  assert.equal(classifyBackfillRecord(records[0]!).classification, "filtered-single-page");
  assert.equal(
    filtered.find((item) => item.record.sourceMangaId === "manga-2")?.classification,
    "filtered-below-completion-threshold",
  );
  assert.equal(
    filtered.find((item) => item.record.sourceMangaId === "manga-3")?.classification,
    "filtered-too-few-chapters",
  );
  assert.equal(
    filtered.find(
      (item) =>
        item.record.sourceMangaId === "manga-4" && item.record.sourceChapterId === "chapter-1",
    )?.classification,
    "accepted",
  );
  assert.equal(
    filtered.find((item) => item.record.sourceMangaId === "")?.classification,
    "weak-identity",
  );
  assert.equal(
    filtered.some((item) => String(item.classification) === "dropped"),
    false,
  );
});

test("backfill planner previews only and never creates outbox rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-history-planner-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();

  try {
    const preview = planBackfillPreview({
      records: [
        historyRecord({
          sourceMangaId: "mapped",
          sourceChapterId: "chapter-3",
          sourceChapterNumber: 3,
        }),
        historyRecord({
          sourceMangaId: "ahead",
          sourceChapterId: "chapter-2",
          sourceChapterNumber: 2,
        }),
        historyRecord({ sourceMangaId: "", sourceChapterId: "chapter-1", reliability: "weak" }),
      ],
      mappings: new Map([
        ["WeebCentral:mapped", { malId: 100, currentChapter: 1, currentVolume: 0 }],
        ["WeebCentral:ahead", { malId: 200, currentChapter: 5, currentVolume: 0 }],
      ]),
      filterOptions: { minDistinctCompletedChapters: 1 },
    });

    assert.equal(
      preview.rows.find((row) => row.sourceMangaId === "mapped")?.status,
      "would-update",
    );
    assert.equal(
      preview.rows.find((row) => row.sourceMangaId === "mapped")?.wouldUpdate?.chapter,
      3,
    );
    assert.equal(
      preview.rows.find((row) => row.sourceMangaId === "ahead")?.status,
      "no-op-mal-ahead",
    );
    assert.equal(preview.rows.find((row) => row.sourceMangaId === "")?.status, "weak-identity");
    assert.equal((await store.listOutbox(10)).length, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("history backfill feasibility documentation exists with manual replay matrix", () => {
  const docPath = "docs/history-backfill-feasibility.md";
  assert.equal(existsSync(docPath), true);
  const doc = readFileSync(docPath, "utf8");
  assert.match(doc, /historical-before-association/u);
  assert.match(doc, /future-read control/u);
  assert.match(doc, /Reliable backfill criteria/u);
  assert.match(doc, /Do not build live MAL backfill writes/u);
});

function historyRecord(overrides: Partial<HistoryProbeEvent>): HistoryProbeEvent {
  return { ...baseHistoryRecord(), ...overrides };
}

function baseHistoryRecord(): HistoryProbeEvent {
  return {
    source: "Paperback",
    readingSourceId: "WeebCentral",
    sourceMangaId: "manga-1",
    sourceMangaTitle: "A Story",
    sourceChapterId: "chapter-1",
    sourceChapterTitle: "Chapter 1",
    sourceChapterNumber: 1,
    sourceChapterVolume: 0,
    completed: true,
    pagesRead: 20,
    totalPages: 20,
    completionPercent: 100,
    readAt: "2026-06-28T00:00:00.000Z",
    reliability: "reliable" as const,
    rawRecordJson: "{}",
  };
}

function emptySyncResult() {
  return {
    seriesSeen: 0,
    autoMatched: 0,
    reviewQueued: 0,
    updatesQueued: 0,
    outboxProcessed: 0,
    outboxSucceeded: 0,
    outboxFailed: 0,
  };
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}
