# Mutsuki

Mutsuki is a Paperback 0.9 extension repository for self-hosted Kavita libraries and MyAnimeList progress tracking.

It contains three separately installable extensions:

- **Mutsuki Kavita**: browse/search Kavita, read image-based manga/PDF pages, and render EPUB light novels as Paperback HTML chapters.
- **Mutsuki MyAnimeList**: authenticate with MAL, link titles through Paperback's tracker workflow, and update chapter/volume progress without regressions.
- **Mutsuki Progress Bridge**: diagnostic tracker/provider that forwards Paperback queued read actions to the local mock bridge.

It also includes two bridge apps:

- `apps/mock-progress-bridge`: a diagnostic Phase 1 receiver which proves Paperback-to-bridge
  networking and displays queued read actions forwarded by the Mutsuki Progress Bridge tracker.
- `apps/kavita-mal-bridge`: the Phase 2 production bridge foundation which polls Kavita as the
  progress source of truth, stores mappings/outbox/audit/OAuth state in SQLite, and prepares
  monotonic MAL updates.

Automatic read-completion delivery from Paperback to the original Kavita source is not available in
the observed runtime, so the production bridge currently depends on Kavita progress being updated by
Kavita itself or a future proven Paperback callback path.

## Supported Formats

- Manga archives/images through Kavita reader image endpoints.
- PDF files through Kavita image extraction.
- EPUB light novels through Kavita book info, table of contents, book page, and book resource endpoints.

DRM-protected EPUBs, EPUB JavaScript execution, PDF text reflow, a standalone backend, and unconfirmed fuzzy MAL linking are out of scope.

## Kavita Setup

1. Install the `Mutsuki Kavita` extension source in Paperback after bundling or serving this repository.
2. Open the extension settings.
3. Enter the Kavita server URL. URLs with or without `/api` are accepted.
4. Enter a Kavita Auth Key from **User Settings -> Manage Auth Keys**. Use the general auth key Kavita accepts for API requests, not the image-only key.
5. Use **Test Connection** for local validation, then browse/search from Paperback.

Mutsuki uses Kavita's REST API with the auth key header for browse and read requests. It does not browse through OPDS feeds. Mutsuki preserves HTTP when a local server is explicitly configured as HTTP. API keys are stored in Paperback secure state and are redacted from logs and errors.

### EPUB Novel Listing

Mutsuki Kavita has two novel listing modes.

**Physical Books** is the default and recommended mode. It mirrors Kavita's Books list, normally returns one Paperback entry per physical EPUB, preserves decimal volumes such as `5.5` and `8.5`, and is the best fit for volume-only MAL tracking. Oversized EPUBs are automatically split into bounded reading parts so Mutsuki can preserve formatting and avoid fetching an entire omnibus at once. Paperback may use reading progress as a tie-breaker when every book has the same chapter number, so this mode uses a stable physical-book sequence as the Paperback chapter number while keeping the real Kavita volume in the `Vol.` field.

Large EPUB handling defaults to **Auto split oversized books**. Each returned part still belongs to the same physical Kavita EPUB, and only the final part completes the Kavita book and MAL volume. Auto split uses the EPUB TOC and page counts to avoid huge loading times and the formatting-destructive fallback that would otherwise turn large semantic XHTML into plain text. **Single entry** remains available as a legacy compatibility option, but very large books can be slow or exceed the completed XHTML budget.

Plain Text rendering mode is diagnostic. It intentionally discards EPUB formatting so text decoding can be isolated from the Full EPUB renderer.

**Internal EPUB Chapters** exposes the EPUB table of contents as individual Paperback chapters. It keeps local chapter numbers, filters publisher newsletters and advertisements by default, and returns source order with contiguous sorting indexes. Paperback's Chapter Number sort may interleave equal local chapter numbers from different volumes, so this mode is experimental when the app cannot honor source order.

The `Include publisher extras` setting can expose publisher backmatter as special entries. It is disabled by default so rows such as newsletters, publisher advertisements, and club/about pages do not appear as normal story chapters.

## MyAnimeList Setup

1. Install the `Mutsuki MyAnimeList` tracker extension.
2. Open settings and sign in with MAL OAuth PKCE.
3. Link Kavita titles to MAL titles using Paperback's tracker workflow.
4. Use the tracking form for each title to adjust policy.

Tracking modes:

- `chapter-and-volume`: update chapters and completed volumes.
- `chapter-only`: update chapters only.
- `volume-only`: update only completed volumes; recommended for many light novels.
- `disabled`: ignore read actions.

Offsets are supported in the policy model for mismatched Kavita/MAL numbering. Specials and decimal chapters are ignored by default. Volume progress advances only when Mutsuki knows the completed chapter is the final logical chapter in a volume.

## Automatic Progress Sync Feasibility

Mutsuki Kavita implements Paperback's progress-provider method shape, and the generated manifest
advertises `PROGRESS_PROVIDING`. Live Paperback testing currently shows completed reads updating
Paperback's local progress without invoking Mutsuki Kavita's progress queue method. Automatic
Paperback-to-Kavita read sync is therefore blocked until Paperback can deliver a read-completion
callback to the original source or to an automatically associated provider.

The settings action **Send mock bridge test event** posts one synthetic diagnostic event to the mock
bridge. It only proves iOS/Paperback networking to the bridge; it is not a read-sync solution.

The **Mutsuki Progress Bridge** tracker is the supported diagnostic path for actual queued read
actions. It can receive `TrackedMangaChapterReadAction` items from Paperback for titles associated
with that tracker and forward sanitized events to the mock bridge. This is useful for proving tracker
queue behavior and for future cross-source bridge work, including MangaDex or other installed
sources. It still depends on Paperback associating the title with the tracker; it does not solve the
rejected per-title manual-linking problem by itself.

Run the mock bridge:

```bash
pnpm run bridge:mock:build
pnpm run bridge:mock:start
```

Or with Docker:

```bash
cd apps/mock-progress-bridge
docker compose -f docker-compose.example.yml up
```

Open `http://<docker-host-ip>:6767` to view received events when using the compose example. The full architecture and next bridge phase are
documented in `docs/progress-sync-architecture.md`; the current read-event boundary is documented in
`docs/paperback-read-event-blocker.md`.

Run the Phase 2 Kavita-to-MAL bridge foundation:

```bash
cd apps/kavita-mal-bridge
docker compose -f docker-compose.example.yml up
```

Open `http://<docker-host-ip>:6768`. Keep `MUTSUKI_BRIDGE_DRY_RUN=true` until the UI shows expected
Kavita-to-MAL mappings and desired progress updates. The bridge can start with only a persistent
database path configured; use the local setup page to save the Kavita URL/API key, MAL OAuth client
details, poll interval, and dry-run mode. MAL access and refresh tokens are stored in SQLite after
OAuth authorization and refreshed before scheduled sync runs.

For Unraid or persistent Docker deployment, see `docs/unraid-docker.md`.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run bridge:mock:build
pnpm run bridge:mal:build
pnpm run bundle
pnpm run dev
pnpm run verify
```

`pnpm run verify` runs formatting checks, typechecking, lint checks, bundling, and tests.

## Paperback Repository URL

When GitHub Pages is enabled for this repository, install Mutsuki in Paperback from:

```text
https://indigoxred.github.io/mutsuki/
```

## Tested Baseline

- Paperback packages: `@paperback/types` and `@paperback/toolchain` `1.0.0-alpha.92`.
- Kavita endpoint references: upstream `Kareadita/Kavita` `AccountController`, `SeriesController`, `SearchController`, `BookController`, and `ReaderController` on `develop` as inspected on 2026-06-21.
- Automated tests use synthetic fixtures and mocked transports. Live Paperback device verification is still required for OAuth callbacks, installed bundle behavior, and HTML reader rendering.

## Attribution

Mutsuki implementation is original code by Mutsuki Contributors.

References inspected:

- `ACK72/kavya-paperback` for Kavita endpoint concepts; BSD-2-Clause, not copied due 0.8 API shape.
- `nyzzik/extensions` for current MAL tracker API concepts; behavior reimplemented.
- `Catta1997/Sinon-Paperback-Extensions` for current Paperback 0.9 HTML reader and toolchain patterns.
- `Kareadita/Kavita` for current API controller endpoint names.
