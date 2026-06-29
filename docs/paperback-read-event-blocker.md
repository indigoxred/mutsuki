# Paperback Read Event Blocker

## Summary

Mutsuki Kavita cannot currently be treated as having proven automatic
Paperback-to-Kavita read sync.

Historical test builds of the source extension exported `MangaProgressProviding`,
advertised `SourceIntents.PROGRESS_PROVIDING`, and had a downstream queue processor
covered by unit tests. Live Paperback 0.9 device logs still showed local chapter
completion without any call to `processChapterReadActionQueue()`.

Current builds intentionally advertise Mutsuki Kavita as a content source only.
`Mutsuki Progress Bridge` is the tracker/provider surface for queued read actions.

The failure boundary is therefore before Kavita endpoints, before the bridge,
and before Mutsuki's read-action mapping code.

## Inspected Contract

Installed packages:

- `@paperback/types@1.0.0-alpha.92`
- `@paperback/toolchain@1.0.0-alpha.92`

`MangaProgressProviding` requires:

- `getMangaProgressManagementForm(sourceManga)`
- `getMangaProgress(sourceManga)`
- `processChapterReadActionQueue(actions)`

`TrackedMangaChapterReadAction` contains:

- `id`
- `sourceManga`
- `readChapter`
- `chapterId`
- `chapterSourceId`
- `chapterMangaId`
- `chapterNum`
- `chapterVolume`
- retry metadata

`SourceIntents.PROGRESS_PROVIDING` is the distinct numeric capability `2`.
`ExtensionImpl` maps capability `2` to `MangaProgressProviding`.

These definitions describe the provider shape, but they do not state that the
content source which served a chapter receives read-completion actions
automatically.

## Mutsuki Export Verification

Automated tests assert that the exported Kavita runtime object still contains the
historical diagnostic methods:

- `getMangaProgressManagementForm`
- `getMangaProgress`
- `processChapterReadActionQueue`

Automated tests also assert that generated `bundles/versioning.json` does not
advertise capability `2` for Mutsuki Kavita, that Mutsuki Progress Bridge does
advertise capability `2` as a separate array element, and that neither extension
emits the old combined `103` capability.

The generated Kavita manifest no longer asks Paperback to present Mutsuki Kavita
as a tracker choice.

## Live Runtime Evidence

Observed across four Paperback 0.9 debug sessions:

- Mutsuki Kavita v0.1.11 loads successfully.
- Generated capabilities are `[4, 64, 1, 2, 32]`.
- Mutsuki Kavita v0.1.13 logs `[MutsukiProgressRuntime]` with all three progress-provider methods
  present on the exported runtime object.
- The settings action sends a diagnostic bridge event successfully, proving
  iOS/Paperback-to-bridge HTTP transport.
- Paperback logs ordinary image-based manga chapters as complete.
- Paperback updates local chapter progress and continues to the next chapter.
- Paperback startup logs include `Found 0 items` and `Empty results returned;
exiting loop`.
- Mutsuki never logs an invocation from `processChapterReadActionQueue()`.
- Kavita never receives `/api/Reader/mark-chapter-read`.
- The bridge never receives `POST /api/progress-events` from source self-notifications.
- The behavior is not EPUB-specific; it also occurs for ordinary image manga.

This indicates that reading a chapter from a source extension is not sufficient
to enqueue a progress-provider action for that same source.

A later device test associated a MangaDex title with the separate `Mutsuki
Progress Bridge` tracker. Paperback invoked that tracker and the bridge received
a queued read action with `chapterSourceId: "MangaDex"`, the MangaDex series id,
the original Paperback chapter id, `sourceTitle`, and `chapterNum`. In the same
test window, reading Mutsuki Kavita content still produced no
`[MutsukiProgressQueue] ENTER` marker. This proves the tracker/provider queue
surface can work for an explicitly associated tracker, while the original
content source still does not receive automatic self-notifications.

## Known Tracker Pattern

Public tracker extensions such as MangaUpdates implement progress handling as a
tracker relationship. Older Paperback tracker code consumes an explicit tracker
queue (`TrackerActionQueue`) and updates the tracker title identified by the
tracked manga id. This supports the interpretation that the progress provider
queue is for tracked manga relationships, not unconditional source
self-notification.

The 0.9 `MangaProgressProviding` interface changed the method signature, but the
available type definitions still do not prove source self-callback behavior.

## Why Page Fetches Are Not Read Evidence

Image, page, and HTML requests cannot be used to infer completion because
Paperback may:

- prefetch unread pages;
- fetch future chapters;
- retry failed images;
- refresh cached reader state;
- fetch thumbnails or page data outside an intentional completion event.

Only an explicit read-completion callback or a tracker queue action is reliable
enough to mark Kavita read.

## Downstream Components Are Not The Failure

Mutsuki's internal queue processor is covered by tests for:

- manga/archive chapter mapping;
- EPUB final-segment-only completion;
- duplicate action idempotency;
- failed Kavita acknowledgement;
- sanitized bridge event emission.

Those tests only prove behavior after Paperback supplies actions. The live
device evidence shows execution never reaches that code.

The bridge test event is therefore diagnostic only. It can prove iOS/Paperback network
reachability with the settings button, but it cannot solve missing read actions.

## Controlled Test Matrix

Current live evidence covers ordinary image manga completion with no source
self-notification. Historical diagnostic builds added unmistakable runtime markers
for the remaining checks.

Recommended matrix:

| Scenario                                                                                        | Expected evidence                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title not saved in Paperback library                                                            | No queue callback expected unless Paperback documents otherwise.                                                                                    |
| Title saved in Paperback library, no tracker link                                               | If no `[MutsukiProgressQueue] ENTER` appears, library membership is insufficient.                                                                   |
| Title linked to a known working tracker                                                         | Known tracker should receive progress actions if tracker setup is valid.                                                                            |
| Historical builds: title linked to Mutsuki Kavita as a progress provider, if the app permits it | If `[MutsukiProgressQueue] ENTER` appears only here, explicit tracker/provider linking is required. Current builds no longer advertise this option. |
| Foreground, restart, and queue-processing wait after completion                                 | Distinguishes delayed queue processing from no queue creation.                                                                                      |

## Decision

Until an on-device test shows otherwise, the automatic architecture is blocked:
Paperback does not appear to deliver read-completion actions to the original
content source solely because that source advertises `PROGRESS_PROVIDING`.

If explicit per-title tracker linking is required, it does not satisfy
Mutsuki's automatic workflow requirement.

Mutsuki now ships a separate `Mutsuki Progress Bridge` progress provider. That
extension is intentionally a tracker/provider event surface rather than a content
source. It can forward queued read actions from any source to the production
bridge when Paperback associates the title with that tracker. It is useful for
cross-source event delivery and event shape, but it does not prove source
self-notification.

## Viable Alternatives

1. Upstream Paperback feature or app fork that emits a source-level
   chapter-completed callback with the original source chapter id.
2. A companion progress provider only if Paperback can automatically associate
   it with Mutsuki Kavita titles without per-title linking.
3. Mutsuki Progress Bridge as a diagnostic tracker for linked titles and
   cross-source queue testing.
4. Explicit tracker linking. This is technically possible but rejected as the
   primary workflow because it recreates the manual linking problem.

## Diagnostic Build Markers

Historical Mutsuki Kavita diagnostic builds logged:

- `[MutsukiProgressRuntime]` during extension initialization, including build id
  and method-presence booleans.
- `[MutsukiProgressQueue] ENTER` as the first line of
  `processChapterReadActionQueue()`, before settings reads or network calls.

If the first marker appears but the second never appears after completed reads,
the exported object exists and Paperback is not invoking the queue method.
