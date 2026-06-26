import { DatabaseSync } from "node:sqlite";

import type { BridgeOutboxItem, OutboxStore } from "./outbox.js";
import type { BridgeTrackingMode } from "./policy.js";

export interface SeriesMappingRecord {
  kavitaSeriesId: number;
  kavitaLibraryId?: number;
  malId: number;
  matchMethod: string;
  confidence: number;
  locked: boolean;
  chapterOffset: number;
  volumeOffset: number;
  trackingMode: BridgeTrackingMode;
  lastObservedChapter: number;
  lastObservedVolume: number;
  lastPushedChapter: number;
  lastPushedVolume: number;
}

export interface ReviewRecord {
  kavitaSeriesId: number;
  title: string;
  reason: string;
  candidatesJson: string;
  createdAt?: string;
}

export interface AuditRecord {
  type: "match" | "progress" | "outbox" | "review" | "system";
  kavitaSeriesId?: number;
  message: string;
  dataJson?: string;
}

export class SqliteBridgeStore implements OutboxStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS series_mappings (
        kavita_series_id INTEGER PRIMARY KEY,
        kavita_library_id INTEGER,
        mal_id INTEGER NOT NULL,
        match_method TEXT NOT NULL,
        confidence REAL NOT NULL,
        locked INTEGER NOT NULL,
        chapter_offset INTEGER NOT NULL,
        volume_offset INTEGER NOT NULL,
        tracking_mode TEXT NOT NULL,
        last_observed_chapter INTEGER NOT NULL DEFAULT 0,
        last_observed_volume INTEGER NOT NULL DEFAULT 0,
        last_pushed_chapter INTEGER NOT NULL DEFAULT 0,
        last_pushed_volume INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS review_queue (
        kavita_series_id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        candidates_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS mal_outbox (
        id TEXT PRIMARY KEY,
        kavita_series_id INTEGER NOT NULL,
        mal_id INTEGER NOT NULL,
        update_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        dedup_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        kavita_series_id INTEGER,
        message TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  async upsertSeriesMapping(record: SeriesMappingRecord): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO series_mappings (
            kavita_series_id, kavita_library_id, mal_id, match_method, confidence, locked,
            chapter_offset, volume_offset, tracking_mode, last_observed_chapter,
            last_observed_volume, last_pushed_chapter, last_pushed_volume, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(kavita_series_id) DO UPDATE SET
            kavita_library_id = excluded.kavita_library_id,
            mal_id = excluded.mal_id,
            match_method = excluded.match_method,
            confidence = excluded.confidence,
            locked = excluded.locked,
            chapter_offset = excluded.chapter_offset,
            volume_offset = excluded.volume_offset,
            tracking_mode = excluded.tracking_mode,
            last_observed_chapter = excluded.last_observed_chapter,
            last_observed_volume = excluded.last_observed_volume,
            last_pushed_chapter = excluded.last_pushed_chapter,
            last_pushed_volume = excluded.last_pushed_volume,
            updated_at = CURRENT_TIMESTAMP
        `,
      )
      .run(
        record.kavitaSeriesId,
        record.kavitaLibraryId ?? null,
        record.malId,
        record.matchMethod,
        record.confidence,
        record.locked ? 1 : 0,
        record.chapterOffset,
        record.volumeOffset,
        record.trackingMode,
        record.lastObservedChapter,
        record.lastObservedVolume,
        record.lastPushedChapter,
        record.lastPushedVolume,
      );
  }

  async getSeriesMapping(kavitaSeriesId: number): Promise<SeriesMappingRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM series_mappings WHERE kavita_series_id = ?")
      .get(kavitaSeriesId) as MappingRow | undefined;
    return row ? mappingFromRow(row) : undefined;
  }

  async listSeriesMappings(): Promise<SeriesMappingRecord[]> {
    return (
      this.db
        .prepare("SELECT * FROM series_mappings ORDER BY kavita_series_id")
        .all() as unknown as MappingRow[]
    ).map(mappingFromRow);
  }

  async enqueueReview(record: ReviewRecord): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO review_queue (kavita_series_id, title, reason, candidates_json)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(kavita_series_id) DO UPDATE SET
            title = excluded.title,
            reason = excluded.reason,
            candidates_json = excluded.candidates_json
        `,
      )
      .run(record.kavitaSeriesId, record.title, record.reason, record.candidatesJson);
  }

  async listReviews(): Promise<Required<ReviewRecord>[]> {
    return (
      this.db
        .prepare("SELECT * FROM review_queue ORDER BY created_at, kavita_series_id")
        .all() as unknown as ReviewRow[]
    ).map((row) => ({
      kavitaSeriesId: row.kavita_series_id,
      title: row.title,
      reason: row.reason,
      candidatesJson: row.candidates_json,
      createdAt: row.created_at,
    }));
  }

  async audit(record: AuditRecord): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO audit_log (type, kavita_series_id, message, data_json) VALUES (?, ?, ?, ?)",
      )
      .run(record.type, record.kavitaSeriesId ?? null, record.message, record.dataJson ?? null);
  }

  async listAuditLogs(limit = 100): Promise<(AuditRecord & { createdAt: string })[]> {
    return (
      this.db
        .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
        .all(limit) as unknown as AuditRow[]
    ).map((row) => ({
      type: row.type as AuditRecord["type"],
      kavitaSeriesId: row.kavita_series_id ?? undefined,
      message: row.message,
      dataJson: row.data_json ?? undefined,
      createdAt: row.created_at,
    }));
  }

  async findByDedupKey(dedupKey: string): Promise<BridgeOutboxItem | undefined> {
    const row = this.db.prepare("SELECT * FROM mal_outbox WHERE dedup_key = ?").get(dedupKey) as
      | OutboxRow
      | undefined;
    return row ? outboxFromRow(row) : undefined;
  }

  async insert(item: BridgeOutboxItem): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO mal_outbox (
            id, kavita_series_id, mal_id, update_json, reason, dedup_key, status,
            attempts, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        item.id,
        item.kavitaSeriesId,
        item.malId,
        JSON.stringify(item.update),
        item.reason,
        item.dedupKey,
        item.status,
        item.attempts,
        item.lastError ?? null,
        item.createdAt,
        item.updatedAt,
      );
  }

  async pending(limit: number): Promise<BridgeOutboxItem[]> {
    return (
      this.db
        .prepare("SELECT * FROM mal_outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?")
        .all(limit) as unknown as OutboxRow[]
    ).map(outboxFromRow);
  }

  async update(item: BridgeOutboxItem): Promise<void> {
    this.db
      .prepare(
        `
          UPDATE mal_outbox
          SET update_json = ?, status = ?, attempts = ?, last_error = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        JSON.stringify(item.update),
        item.status,
        item.attempts,
        item.lastError ?? null,
        item.updatedAt,
        item.id,
      );
  }
}

interface MappingRow {
  kavita_series_id: number;
  kavita_library_id: number | null;
  mal_id: number;
  match_method: string;
  confidence: number;
  locked: number;
  chapter_offset: number;
  volume_offset: number;
  tracking_mode: BridgeTrackingMode;
  last_observed_chapter: number;
  last_observed_volume: number;
  last_pushed_chapter: number;
  last_pushed_volume: number;
}

interface ReviewRow {
  kavita_series_id: number;
  title: string;
  reason: string;
  candidates_json: string;
  created_at: string;
}

interface AuditRow {
  type: string;
  kavita_series_id: number | null;
  message: string;
  data_json: string | null;
  created_at: string;
}

interface OutboxRow {
  id: string;
  kavita_series_id: number;
  mal_id: number;
  update_json: string;
  reason: string;
  dedup_key: string;
  status: BridgeOutboxItem["status"];
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function mappingFromRow(row: MappingRow): SeriesMappingRecord {
  return {
    kavitaSeriesId: row.kavita_series_id,
    kavitaLibraryId: row.kavita_library_id ?? undefined,
    malId: row.mal_id,
    matchMethod: row.match_method,
    confidence: row.confidence,
    locked: row.locked === 1,
    chapterOffset: row.chapter_offset,
    volumeOffset: row.volume_offset,
    trackingMode: row.tracking_mode,
    lastObservedChapter: row.last_observed_chapter,
    lastObservedVolume: row.last_observed_volume,
    lastPushedChapter: row.last_pushed_chapter,
    lastPushedVolume: row.last_pushed_volume,
  };
}

function outboxFromRow(row: OutboxRow): BridgeOutboxItem {
  return {
    id: row.id,
    kavitaSeriesId: row.kavita_series_id,
    malId: row.mal_id,
    update: JSON.parse(row.update_json) as BridgeOutboxItem["update"],
    reason: row.reason,
    dedupKey: row.dedup_key,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
