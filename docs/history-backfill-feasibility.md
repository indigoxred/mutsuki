# History Backfill Feasibility

This is a diagnostic probe, not a production MAL backfill feature. Do not build live MAL backfill
writes until historical read data is proven structured, stable, and safe.

## Current Versions

- Mutsuki Progress Bridge: 0.1.9 diagnostic build
- Mutsuki Kavita: 0.1.18 or later
- Paperback types/toolchain inspected locally: `@paperback/types@1.0.0-alpha.92` and
  `@paperback/toolchain@1.0.0-alpha.92`
- Primary live reading source under test: WeebCentral `1.0.0-alpha.22`

## API And Type Inspection Results

The installed Paperback extension types expose:

- `MangaProgressProviding.getMangaProgressManagementForm(sourceManga)`
- `MangaProgressProviding.getMangaProgress(sourceManga)`
- `MangaProgressProviding.processChapterReadActionQueue(actions)`
- `TrackedMangaChapterReadAction` with tracker-queue action identity, source manga/chapter IDs,
  chapter number, volume, creation date, and retry metadata
- `MangaProgress` with `sourceManga`, `lastReadChapter`, optional `lastReadTime`, and optional
  rating
- `Application.getState`, `Application.setState`, secure state, networking, web view, and selector
  helpers
- `SourceManga` database-maintained counters: `chapterCount`, `newChapterCount`,
  `unreadChapterCount`

The installed public extension types do **not** expose:

- local history reads
- `LocalHistoryService`
- saved-library read history
- complete chapter history
- arbitrary chapter-progress database access
- historical tracker action queue replay controls
- export or backup readers

Therefore, based on the public extension contract, there is no extension-accessible API for reading
historical Paperback progress. The Progress Bridge settings action **Probe Paperback history access**
sends this result to the bridge as:

`no-extension-accessible-history-api-found`

This result is stored separately under `/api/history-probe/*` and never queues MAL writes.

## Public API Questions

- Is there a public extension API for reading historical progress?
  - No public API was found in `@paperback/types@1.0.0-alpha.92`.
- Can a tracker/provider extension call it?
  - No; only tracker action queues and current tracker progress methods are exposed.
- Can a source extension call it?
  - No; content sources receive chapter/page calls, not app history access.
- What fields are returned?
  - Not applicable for history. Queued tracker actions include source IDs and chapter numbers, but
    only for actions the app queues to the associated tracker.
- Are timestamps available?
  - Tracker queue actions include `creationDate`; no historical history timestamps are exposed.
- Are stable source IDs/chapter IDs available?
  - Yes for live tracker queue actions. Not available through a public historical history API.
- Is history read-only or mutable?
  - No public history interface exists. Extensions can store their own state, but cannot mutate
    Paperback history directly through the inspected types.

## Manual Device Test Matrix

Fill this in after testing on device.

### Test A: historical-before-association

1. Pick a fresh WeebCentral title.
2. Read chapters 1-3 before associating Mutsuki Progress Bridge.
3. Confirm they are marked complete in Paperback.
4. Associate that title with Mutsuki Progress Bridge.
5. Restart Paperback.
6. Leave Paperback foregrounded for several minutes.
7. Check:
   - `/api/progress-events`
   - `/api/history-probe/events`

Result:

- historical replay works / future-only works / no replay / duplicate risk / inconclusive

### Test B: future-read control

1. Read chapter 4 after association.
2. Confirm chapter 4 arrives as a normal Progress Bridge read event.

Result:

- pending

### Test C: app restart duplicate check

1. Restart Paperback again.
2. Confirm old chapters are not duplicated.

Result:

- pending

### Test D: unassociate/reassociate

1. If Paperback allows it, unassociate and reassociate the Progress Bridge tracker.
2. Confirm whether historical events replay.

Result:

- pending

## Export Or Backup Route

No extension-accessible export or backup API was found in the installed types/toolchain. If the
Paperback app has a user-facing export/backup feature, it must be manually exported and inspected
before any import route is designed.

Required fields for a reliable import:

- reading source id
- source manga id
- source title
- source chapter id
- chapter number
- volume number where available
- completion/read boolean
- pages read and total pages
- read or updated timestamp
- tracker relationship where applicable

If an export lacks chapter-level source IDs and completion state, it is not suitable for automatic
MAL backfill.

## Debug Log Parser Reliability

The bridge contains an offline diagnostic parser for Paperback debug logs. It extracts candidate
records from lines such as:

- `Marked <title> - Vol. X, Ch. Y as COMPLETE`
- `Updated chapter progress for <chapterId> to <pagesRead>/<totalPages>`

It ignores:

- `PREFETCHER` lines
- image/page preloading
- partial progress below the configured threshold
- repeated duplicate progress updates
- tokenized image URLs
- `x-api-key`, `apiKey`, `Authorization`, cookies, bearer tokens, and session data

Log-derived records are weak unless they contain stable source and manga IDs. Title/chapter strings
alone are not safe for automatic MAL updates.

## Reliable backfill criteria

Reliable historical records should contain most of:

- `readingSourceId`
- `sourceMangaId`
- `sourceTitle`
- `sourceChapterId`
- `sourceChapterNumber`
- `sourceChapterVolume` when available
- `readAt` or `updatedAt`
- completed/read boolean
- pages read and total pages

Weak or unreliable records include:

- title string only
- chapter title only
- no source ID
- no manga/chapter ID
- no completion state
- no timestamp/order
- ambiguous duplicate titles

## Accidental-Click Filter Design

Backfill filters are preview-only for now.

Defaults:

- ignore `pagesRead <= 1`
- ignore completion below 80%
- ignore one-off one-chapter starts unless one-shot handling is explicitly enabled
- require at least two distinct completed chapters per title by default
- classify 1-2 early chapters with no later activity as below threshold, not dropped
- never infer MAL dropped status automatically
- never reduce MAL progress from backfill

Classifications:

- `accepted`
- `filtered-single-page`
- `filtered-below-completion-threshold`
- `filtered-too-few-chapters`
- `possible-one-shot-needs-confirmation`
- `weak-identity`
- `duplicate`
- `needs-review`

Filtered records remain visible. They are not silently deleted.

## Security Notes

History and backfill diagnostics must redact:

- `x-api-key`
- `apiKey` query params
- `Authorization`
- bearer tokens
- cookies
- session IDs
- passwords
- signed image URLs
- Kavita API keys
- raw authenticated URLs

## Final Recommendation Placeholder

Current recommendation: do not build automatic historical MAL backfill until either:

1. Paperback exposes a structured history/progress API to extensions, or
2. a user export is confirmed to contain stable source and chapter IDs plus completion timestamps.

Possible future outcomes:

- build automatic backfill
- build import-based backfill
- build log-only emergency import
- do not build backfill

Do not build live MAL backfill writes in this diagnostic phase.
