# Mutsuki Progress Sync Architecture

## Goal

Mutsuki should use Kavita as the authoritative reading-progress source:

1. Paperback reads a Mutsuki Kavita chapter.
2. Paperback queues a read action for the Kavita source extension.
3. Mutsuki Kavita marks the exact Kavita chapter/book read.
4. A separate bridge polls Kavita progress and updates MyAnimeList.

The Paperback extension must not write directly to MyAnimeList in this automatic workflow. The
existing Mutsuki MyAnimeList tracker can remain available for manual users, but it should not be
used at the same time as the bridge for the same title.

## Current Feasibility Slice

Paperback 0.9 exposes `MangaProgressProviding.processChapterReadActionQueue()` in
`@paperback/types` `1.0.0-alpha.92`. Mutsuki Kavita now implements that provider and uses the queued
read action payload to map back to Kavita identifiers already preserved in chapter IDs and
`additionalInfo`.

The source extension currently:

- marks manga/archive/PDF chapters read in Kavita with `/api/Reader/mark-chapter-read`;
- marks EPUB/light-novel physical books read only when the whole-book entry or final split segment is
  completed;
- acknowledges successful and failed queued read actions explicitly;
- deduplicates duplicate queue items for the same Kavita series/chapter pair;
- optionally posts a sanitized progress event to a local mock bridge receiver.

The mock bridge is in `apps/mock-progress-bridge`. It receives events at
`POST /api/progress-events`, stores them as JSONL, and displays them at `/`.

## Why The Mock Bridge Exists First

The riskiest unknown is whether Paperback source extensions receive reliable completed-read actions
for the Kavita source itself. The mock bridge proves that boundary before building the larger
Kavita-to-MAL service.

This mock bridge does not update MAL. It is intentionally dependency-free and Docker-hostable so it
can be run beside Kavita during device testing.

## Event Shape

Events are sanitized and contain only IDs and metadata needed by the later bridge:

- Paperback action id
- Paperback manga/chapter id
- Kavita series id
- Kavita chapter/book id
- chapter kind: `manga` or `book`
- chapter and volume numbers seen by Paperback
- listing mode, role, segment index/count
- whether the event should mark Kavita read
- whether Kavita was marked read

Events must not contain:

- Kavita API keys
- authenticated image/resource URLs
- raw EPUB text
- complete chapter HTML

## Future Production Bridge

The production bridge should be a separate package that builds on this event/progress model but uses
Kavita as the source of truth by polling Kavita progress. It should include:

- SQLite storage;
- Kavita API polling for libraries, series, metadata, and read progress;
- MAL OAuth;
- deterministic MAL ID/URL matching from existing Kavita external metadata;
- high-confidence fallback search matching;
- unresolved match review UI/API;
- monotonic high-water progress updates;
- offsets and tracking policies;
- retry/outbox tables for MAL writes;
- audit logging.

Default policies:

- manga: chapter-and-volume;
- light novels / physical EPUB books: volume-only unless chapter mapping is trustworthy;
- specials and decimal chapters ignored unless explicitly configured.

## Device Feasibility Test

1. Run the mock bridge:

   ```bash
   cd apps/mock-progress-bridge
   docker compose -f docker-compose.example.yml up --build
   ```

2. In Paperback, configure Mutsuki Kavita:

   - Progress bridge URL: `http://<docker-host-ip>:8080`
   - Progress bridge token: blank unless `MUTSUKI_BRIDGE_TOKEN` is set

3. Complete a manga chapter, PDF chapter, whole EPUB entry, and a split EPUB part.

4. Open `http://<docker-host-ip>:8080`.

Expected result:

- the bridge receives events for each completed Paperback read;
- Kavita is marked read for manga/PDF chapters, whole EPUB entries, and final EPUB split segments;
- non-final split EPUB segments appear as events but do not mark the physical Kavita book complete.
