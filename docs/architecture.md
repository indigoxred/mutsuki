# Mutsuki Architecture

Mutsuki is one Paperback 0.9 repository with two separately installable entry points:

- `Mutsuki Kavita` (`mutsuki-kavita`) provides Kavita browsing, search, manga page reading, EPUB TOC splitting, and HTML novel chapters.
- `Mutsuki MyAnimeList` (`mutsuki-myanimelist`) provides MAL search/linking, OAuth settings, and chapter-read queue processing.

The risky logic is kept in small TypeScript modules that can be tested without a live Paperback app, Kavita server, or MAL account. Paperback entry points should remain thin adapters around the typed clients, EPUB pipeline, and MAL policy engine.

## References Inspected

- `ACK72/kavya-paperback`: BSD-2-Clause; useful Kavita concepts, obsolete 0.8 API and not copied.
- `nyzzik/extensions`: current 0.9 MAL tracker shape using `MangaProgressProviding` and `OAuthButtonRow`; behavior reimplemented.
- `Catta1997/Sinon-Paperback-Extensions`: current 0.9 HTML chapter examples and toolchain shape.
- `Kareadita/Kavita`: current `BookController` and `ReaderController` endpoint names for book pages, resources, images, and progress.

## Core Data Flow

Kavita settings produce a sanitized `KavitaConfig`. `KavitaClient` centralizes authenticated requests, endpoint paths, response decoding, retry classification, and secret-safe errors. Reader modules convert Kavita volume/chapter/book DTOs into stable Paperback chapters.

For EPUBs, `toc.ts` flattens Kavita TOC items into logical chapter ranges. `html-assembler.ts` fetches and sanitizes page fragments. `resource-rewriter.ts` resolves relative resources, fetches them through the authenticated client, inlines safe CSS/images as data URLs, and inserts nonfatal placeholders for unavailable or oversized resources.

The MAL tracker receives Paperback read actions, loads a per-title `TrackingPolicy`, collapses redundant actions, fetches current MAL progress, and submits only non-regressing updates. Volume progress is advanced only when a completed action is known to be the final logical chapter in a volume.
