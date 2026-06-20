# Mutsuki Design

## Goal

Build a modern Paperback 0.9 repository named Mutsuki with a Kavita content extension and a MyAnimeList tracker extension. The implementation supports image manga, EPUB light novels rendered as HTML, stable EPUB logical chapters, safe resource rewriting, and non-regressing MAL progress updates.

## Architecture

The repo has two visible Paperback entry points and shared testable modules. The Kavita extension owns server settings, discovery, search, metadata, manga pages, EPUB TOC splitting, HTML assembly, and optional Kavita progress calls. The MAL extension owns OAuth settings, MAL search/details, progress management forms, queue processing, tracking policies, and update calls.

The entry points are adapters. They should not hide core behavior inside Paperback callbacks. Core modules are plain TypeScript and tested with mocked transports and fixtures.

## Kavita

`KavitaClient` normalizes the configured URL, validates host boundaries, attaches credentials only to the configured Kavita host, decodes JSON/binary responses, sanitizes errors, and classifies transient failures. Endpoint coverage follows current Kavita controllers for libraries, series, volumes/chapters, reader images, book info, book chapters, book pages, book resources, and mark-read calls.

Image chapters use stable IDs like `kavita-chapter:{chapterId}`. EPUB logical chapters use `kavita-book:{physicalChapterId}:page:{startPage}:end:{endPage}:last:{0|1}`.

## EPUB

The EPUB pipeline flattens nested TOCs, removes unusable page entries, calculates non-overlapping page ranges, falls back to one full-volume chapter when no usable TOC exists, and marks the final logical chapter in a physical EPUB. HTML output removes executable content, preserves ordinary reading markup, rewrites anchors, inlines CSS/images through authenticated resource fetches, and enforces size limits.

## MyAnimeList

MAL progress uses per-title policies: `chapter-and-volume`, `chapter-only`, `volume-only`, and `disabled`. Queue processing groups actions by MAL manga ID, applies offsets, ignores specials/decimals by default, fetches current MAL progress, never reduces chapters or volumes, caps values against known MAL totals, and advances volume progress only for final-in-volume actions.

## Verification

The first testable proof is an illustrated EPUB fixture whose HTML contains Unicode text, relative CSS, nested images, filenames with spaces, missing resources, and multiple pages combined into one logical chapter. Full verification must include format checks, typechecking, linting, bundling, and tests.
