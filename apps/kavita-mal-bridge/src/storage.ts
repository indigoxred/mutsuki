import { DatabaseSync } from "node:sqlite";

import type { BridgeOutboxItem, OutboxStore } from "./outbox.js";
import type { BridgeTrackingMode } from "./policy.js";
import {
  DEFAULT_SOURCE_POLICY,
  type BridgeReadEventRecord,
  type SourcePolicyRecord,
} from "./progress-events.js";

export { DEFAULT_SOURCE_POLICY };

export interface SeriesMappingRecord {
  kavitaSeriesId: number;
  kavitaLibraryId?: number;
  title?: string;
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

export interface IgnoredSeriesRecord {
  kavitaSeriesId: number;
  title: string;
  reason: string;
  createdAt?: string;
}

export interface AuditRecord {
  type: "match" | "progress" | "outbox" | "review" | "system";
  kavitaSeriesId?: number;
  message: string;
  dataJson?: string;
}

export interface OAuthStateRecord {
  state: string;
  codeVerifier: string;
  createdAt: string;
}

export interface OAuthTokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tokenType: string;
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
        title TEXT,
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
      CREATE TABLE IF NOT EXISTS ignored_series (
        kavita_series_id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS read_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        event_source TEXT NOT NULL,
        reading_source_id TEXT NOT NULL,
        reading_source_name TEXT NOT NULL,
        reading_source_kind TEXT NOT NULL,
        action_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        source_manga_id TEXT NOT NULL,
        source_chapter_id TEXT NOT NULL,
        source_title TEXT NOT NULL,
        source_chapter_number REAL NOT NULL,
        source_chapter_volume REAL,
        kavita_series_id INTEGER,
        kavita_chapter_id INTEGER,
        chapter_kind TEXT NOT NULL,
        raw_event_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS source_policies (
        reading_source_id TEXT PRIMARY KEY,
        reading_source_name TEXT NOT NULL,
        mal_enabled INTEGER NOT NULL,
        kavita_mirror_mode TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS bridge_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS mal_oauth_state (
        state TEXT PRIMARY KEY,
        code_verifier TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mal_oauth_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        token_type TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    this.addColumnIfMissing("series_mappings", "title", "TEXT");
  }

  close(): void {
    this.db.close();
  }

  async upsertSeriesMapping(record: SeriesMappingRecord): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO series_mappings (
            kavita_series_id, kavita_library_id, title, mal_id, match_method, confidence, locked,
            chapter_offset, volume_offset, tracking_mode, last_observed_chapter,
            last_observed_volume, last_pushed_chapter, last_pushed_volume, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(kavita_series_id) DO UPDATE SET
            kavita_library_id = excluded.kavita_library_id,
            title = excluded.title,
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
        record.title ?? null,
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

  async deleteReview(kavitaSeriesId: number): Promise<void> {
    this.db.prepare("DELETE FROM review_queue WHERE kavita_series_id = ?").run(kavitaSeriesId);
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

  async ignoreSeries(record: IgnoredSeriesRecord): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO ignored_series (kavita_series_id, title, reason, created_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(kavita_series_id) DO UPDATE SET
            title = excluded.title,
            reason = excluded.reason
        `,
      )
      .run(record.kavitaSeriesId, record.title, record.reason);
  }

  async isSeriesIgnored(kavitaSeriesId: number): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 AS ignored FROM ignored_series WHERE kavita_series_id = ?")
      .get(kavitaSeriesId) as { ignored: number } | undefined;
    return Boolean(row);
  }

  async listIgnoredSeries(): Promise<Required<IgnoredSeriesRecord>[]> {
    return (
      this.db
        .prepare("SELECT * FROM ignored_series ORDER BY created_at, kavita_series_id")
        .all() as unknown as IgnoredSeriesRow[]
    ).map((row) => ({
      kavitaSeriesId: row.kavita_series_id,
      title: row.title,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  async restoreIgnoredSeries(kavitaSeriesId: number): Promise<void> {
    this.db.prepare("DELETE FROM ignored_series WHERE kavita_series_id = ?").run(kavitaSeriesId);
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

  async appendReadEvent(record: BridgeReadEventRecord): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO read_events (
            schema_version, event_source, reading_source_id, reading_source_name,
            reading_source_kind, action_id, occurred_at, received_at, source_manga_id,
            source_chapter_id, source_title, source_chapter_number, source_chapter_volume,
            kavita_series_id, kavita_chapter_id, chapter_kind, raw_event_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        record.schemaVersion,
        record.eventSource,
        record.readingSourceId,
        record.readingSourceName,
        record.readingSourceKind,
        record.actionId,
        record.occurredAt,
        record.receivedAt,
        record.sourceMangaId,
        record.sourceChapterId,
        record.sourceTitle,
        record.sourceChapterNumber,
        record.sourceChapterVolume ?? null,
        record.kavitaSeriesId ?? null,
        record.kavitaChapterId ?? null,
        record.chapterKind,
        record.rawEventJson,
      );
  }

  async listReadEvents(limit = 100): Promise<BridgeReadEventRecord[]> {
    return (
      this.db
        .prepare("SELECT * FROM read_events ORDER BY id DESC LIMIT ?")
        .all(limit) as unknown as ReadEventRow[]
    ).map(readEventFromRow);
  }

  async readEventCount(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM read_events").get() as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  }

  async getSourcePolicy(readingSourceId: string): Promise<SourcePolicyRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM source_policies WHERE reading_source_id = ?")
      .get(readingSourceId) as SourcePolicyRow | undefined;
    return row ? sourcePolicyFromRow(row) : undefined;
  }

  async upsertSourcePolicy(record: SourcePolicyRecord): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO source_policies (
            reading_source_id, reading_source_name, mal_enabled, kavita_mirror_mode, updated_at
          ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(reading_source_id) DO UPDATE SET
            reading_source_name = excluded.reading_source_name,
            mal_enabled = excluded.mal_enabled,
            kavita_mirror_mode = excluded.kavita_mirror_mode,
            updated_at = CURRENT_TIMESTAMP
        `,
      )
      .run(
        record.readingSourceId,
        record.readingSourceName,
        record.malEnabled ? 1 : 0,
        record.kavitaMirrorMode,
      );
  }

  async ensureSourcePolicy(defaultPolicy: SourcePolicyRecord): Promise<SourcePolicyRecord> {
    const existing = await this.getSourcePolicy(defaultPolicy.readingSourceId);
    if (existing) return existing;
    await this.upsertSourcePolicy(defaultPolicy);
    return defaultPolicy;
  }

  async listSourcePolicies(): Promise<SourcePolicyRecord[]> {
    return (
      this.db
        .prepare("SELECT * FROM source_policies ORDER BY reading_source_name, reading_source_id")
        .all() as unknown as SourcePolicyRow[]
    ).map(sourcePolicyFromRow);
  }

  async saveSetting(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO bridge_settings (key, value, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `,
      )
      .run(key, value);
  }

  async getSetting(key: string): Promise<string | undefined> {
    const row = this.db.prepare("SELECT value FROM bridge_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  async listSettings(): Promise<Record<string, string>> {
    const rows = this.db
      .prepare("SELECT key, value FROM bridge_settings ORDER BY key")
      .all() as unknown as SettingRow[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  async saveOAuthState(record: OAuthStateRecord): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO mal_oauth_state (state, code_verifier, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(state) DO UPDATE SET code_verifier = excluded.code_verifier,
            created_at = excluded.created_at
        `,
      )
      .run(record.state, record.codeVerifier, record.createdAt);
  }

  async getOAuthState(state: string): Promise<OAuthStateRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM mal_oauth_state WHERE state = ?").get(state) as
      | OAuthStateRow
      | undefined;
    return row
      ? { state: row.state, codeVerifier: row.code_verifier, createdAt: row.created_at }
      : undefined;
  }

  async deleteOAuthState(state: string): Promise<void> {
    this.db.prepare("DELETE FROM mal_oauth_state WHERE state = ?").run(state);
  }

  async saveOAuthTokens(record: OAuthTokenRecord): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO mal_oauth_tokens (
            id, access_token, refresh_token, expires_at, token_type, updated_at
          ) VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            expires_at = excluded.expires_at,
            token_type = excluded.token_type,
            updated_at = CURRENT_TIMESTAMP
        `,
      )
      .run(record.accessToken, record.refreshToken, record.expiresAt, record.tokenType);
  }

  async getOAuthTokens(): Promise<OAuthTokenRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM mal_oauth_tokens WHERE id = 1").get() as
      | OAuthTokenRow
      | undefined;
    return row
      ? {
          accessToken: row.access_token,
          refreshToken: row.refresh_token,
          expiresAt: row.expires_at,
          tokenType: row.token_type,
        }
      : undefined;
  }

  async clearOAuthTokens(): Promise<void> {
    this.db.prepare("DELETE FROM mal_oauth_tokens WHERE id = 1").run();
  }

  async findByDedupKey(dedupKey: string): Promise<BridgeOutboxItem | undefined> {
    const row = this.db.prepare("SELECT * FROM mal_outbox WHERE dedup_key = ?").get(dedupKey) as
      | OutboxRow
      | undefined;
    return row ? outboxFromRow(row) : undefined;
  }

  async getOutboxItem(id: string): Promise<BridgeOutboxItem | undefined> {
    const row = this.db.prepare("SELECT * FROM mal_outbox WHERE id = ?").get(id) as
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

  async listOutbox(limit = 100): Promise<BridgeOutboxItem[]> {
    return (
      this.db
        .prepare("SELECT * FROM mal_outbox ORDER BY created_at DESC LIMIT ?")
        .all(limit) as unknown as OutboxRow[]
    ).map(outboxFromRow);
  }

  async outboxCounts(): Promise<Record<BridgeOutboxItem["status"], number>> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM mal_outbox GROUP BY status")
      .all() as unknown as { status: BridgeOutboxItem["status"]; count: number }[];
    return {
      pending: countForStatus(rows, "pending"),
      succeeded: countForStatus(rows, "succeeded"),
      failed: countForStatus(rows, "failed"),
    };
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

  async recordPushedProgress(
    kavitaSeriesId: number,
    update: BridgeOutboxItem["update"],
  ): Promise<void> {
    const chapter = update.num_chapters_read ?? 0;
    const volume = update.num_volumes_read ?? 0;
    this.db
      .prepare(
        `
          UPDATE series_mappings
          SET last_pushed_chapter = MAX(last_pushed_chapter, ?),
            last_pushed_volume = MAX(last_pushed_volume, ?),
            updated_at = CURRENT_TIMESTAMP
          WHERE kavita_series_id = ?
        `,
      )
      .run(chapter, volume, kavitaSeriesId);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
      name: string;
    }[];
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function countForStatus(
  rows: { status: BridgeOutboxItem["status"]; count: number }[],
  status: BridgeOutboxItem["status"],
): number {
  return rows.find((row) => row.status === status)?.count ?? 0;
}

interface MappingRow {
  kavita_series_id: number;
  kavita_library_id: number | null;
  title: string | null;
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

interface IgnoredSeriesRow {
  kavita_series_id: number;
  title: string;
  reason: string;
  created_at: string;
}

interface AuditRow {
  type: string;
  kavita_series_id: number | null;
  message: string;
  data_json: string | null;
  created_at: string;
}

interface ReadEventRow {
  schema_version: 1 | 2;
  event_source: BridgeReadEventRecord["eventSource"];
  reading_source_id: string;
  reading_source_name: string;
  reading_source_kind: BridgeReadEventRecord["readingSourceKind"];
  action_id: string;
  occurred_at: string;
  received_at: string;
  source_manga_id: string;
  source_chapter_id: string;
  source_title: string;
  source_chapter_number: number;
  source_chapter_volume: number | null;
  kavita_series_id: number | null;
  kavita_chapter_id: number | null;
  chapter_kind: BridgeReadEventRecord["chapterKind"];
  raw_event_json: string;
}

interface SourcePolicyRow {
  reading_source_id: string;
  reading_source_name: string;
  mal_enabled: number;
  kavita_mirror_mode: SourcePolicyRecord["kavitaMirrorMode"];
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

interface SettingRow {
  key: string;
  value: string;
}

interface OAuthStateRow {
  state: string;
  code_verifier: string;
  created_at: string;
}

interface OAuthTokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  token_type: string;
}

function mappingFromRow(row: MappingRow): SeriesMappingRecord {
  return {
    kavitaSeriesId: row.kavita_series_id,
    kavitaLibraryId: row.kavita_library_id ?? undefined,
    title: row.title ?? undefined,
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

function readEventFromRow(row: ReadEventRow): BridgeReadEventRecord {
  return {
    schemaVersion: row.schema_version,
    eventSource: row.event_source,
    readingSourceId: row.reading_source_id,
    readingSourceName: row.reading_source_name,
    readingSourceKind: row.reading_source_kind,
    actionId: row.action_id,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    sourceMangaId: row.source_manga_id,
    sourceChapterId: row.source_chapter_id,
    sourceTitle: row.source_title,
    sourceChapterNumber: row.source_chapter_number,
    sourceChapterVolume: row.source_chapter_volume ?? undefined,
    kavitaSeriesId: row.kavita_series_id ?? undefined,
    kavitaChapterId: row.kavita_chapter_id ?? undefined,
    chapterKind: row.chapter_kind,
    rawEventJson: row.raw_event_json,
  };
}

function sourcePolicyFromRow(row: SourcePolicyRow): SourcePolicyRecord {
  return {
    readingSourceId: row.reading_source_id,
    readingSourceName: row.reading_source_name,
    malEnabled: row.mal_enabled === 1,
    kavitaMirrorMode: row.kavita_mirror_mode,
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
