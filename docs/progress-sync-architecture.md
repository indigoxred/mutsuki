# Mutsuki Progress Sync Architecture

## Goal

Mutsuki should use Kavita as the authoritative reading-progress source:

1. Paperback reads a Mutsuki Kavita chapter.
2. Paperback emits a reliable read-completion signal for the original source, or for an
   automatically associated provider.
3. Mutsuki Kavita marks the exact Kavita chapter/book read.
4. A separate bridge polls Kavita progress and updates MyAnimeList.

The Paperback extension must not write directly to MyAnimeList in this automatic workflow. The
existing Mutsuki MyAnimeList tracker can remain available for manual users, but it should not be
used at the same time as the bridge for the same title.

## Current Feasibility Status

Paperback 0.9 exposes `MangaProgressProviding.processChapterReadActionQueue()` in
`@paperback/types` `1.0.0-alpha.92`. Mutsuki Kavita implements that provider shape, and unit tests
prove its downstream queue processor can map read actions to Kavita identifiers already preserved in
chapter IDs and `additionalInfo`.

Live Paperback testing has not proven the critical first step. Paperback marks chapters complete
locally, but it does not invoke Mutsuki Kavita's `processChapterReadActionQueue()` for the original
content source in the observed sessions. See `docs/paperback-read-event-blocker.md`.

The source extension contains provisional code which, if Paperback supplies actions, would:

- mark manga/archive/PDF chapters read in Kavita with `/api/Reader/mark-chapter-read`;
- mark EPUB/light-novel physical books read only when the whole-book entry or final split segment is
  completed;
- acknowledge successful and failed queued read actions explicitly;
- deduplicate duplicate queue items for the same Kavita series/chapter pair;
- optionally post a sanitized progress event to a local mock bridge receiver.

This code is not a completed automatic sync feature until the runtime queue callback is proven on
device.

The mock bridge is in `apps/mock-progress-bridge`. It receives events at
`POST /api/progress-events`, stores them as JSONL, and displays them at `/`.

## Why The Mock Bridge Exists First

The riskiest unknown is whether Paperback source extensions receive reliable completed-read actions
for the Kavita source itself. Current live evidence says they do not. The mock bridge now proves only
the independent iOS/Paperback-to-bridge network path through the settings action.

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
   docker compose -f docker-compose.example.yml up
   ```

2. In Paperback, configure Mutsuki Kavita:

   - Progress bridge URL: `http://<docker-host-ip>:<mapped-port>`
   - Progress bridge token: blank unless `MUTSUKI_BRIDGE_TOKEN` is set

3. Tap **Send mock bridge test event** in Mutsuki Kavita settings.

4. Open `http://<docker-host-ip>:<mapped-port>`.

Expected result:

- the bridge receives one synthetic diagnostic event.

This proves network reachability only.

To test the blocked read-event boundary:

1. Enable Mutsuki Kavita debug logging.
2. Confirm startup logs contain `[MutsukiProgressRuntime]`.
3. Complete an ordinary image manga chapter.
4. Foreground/restart Paperback and wait for queue processing.
5. Look for `[MutsukiProgressQueue] ENTER`.

If the runtime marker appears but the queue marker does not, Paperback loaded the exported provider
object but did not dispatch read actions to the Kavita source.
