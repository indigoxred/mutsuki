# Mutsuki

Mutsuki is a Paperback 0.9 extension repository for self-hosted Kavita libraries and MyAnimeList progress tracking.

It contains two separately installable extensions:

- **Mutsuki Kavita**: browse/search Kavita, read image-based manga/PDF pages, and render EPUB light novels as Paperback HTML chapters.
- **Mutsuki MyAnimeList**: authenticate with MAL, link titles through Paperback's tracker workflow, and update chapter/volume progress without regressions.

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

**Physical Books** is the default and recommended mode. It mirrors Kavita's Books list, returns one Paperback entry per physical EPUB, preserves decimal volumes such as `5.5` and `8.5`, and is the best fit for volume-only MAL tracking. Paperback may use reading progress as a tie-breaker when every book has the same chapter number, so this mode uses a stable physical-book sequence as the Paperback chapter number while keeping the real Kavita volume in the `Vol.` field.

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

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test
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
