# Mutsuki Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the initial Mutsuki Paperback 0.9 repository with Kavita content and MAL tracker extensions.

**Architecture:** Keep Paperback entry points thin and move risky behavior into tested TypeScript modules. Use an injected transport for Kavita and MAL clients so automated tests run without credentials. Inline authenticated EPUB resources instead of relying on reader subrequest headers.

**Tech Stack:** TypeScript, ESM, pinned Paperback `1.0.0-alpha.92`, pnpm, Node test runner, oxlint, oxfmt.

---

### Task 1: Project Shell

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.test.json`
- Create: `.gitignore`
- Create: `.oxlintrc.json`
- Create: `docs/architecture.md`
- Create: `docs/decisions.md`
- Create: `docs/testing.md`
- Create: `docs/limitations.md`

- [ ] Write project metadata and scripts.
- [ ] Pin dependencies exactly.
- [ ] Document architecture and decisions.

### Task 2: Test-First Core Utilities

**Files:**

- Test: `tests/shared/*.test.ts`
- Create: `src/shared/url.ts`
- Create: `src/shared/logging.ts`
- Create: `src/shared/numbers.ts`
- Create: `src/shared/cache.ts`
- Create: `src/shared/errors.ts`

- [ ] Write failing tests for URL normalization, redaction, number parsing, cache bounds, and retry classification.
- [ ] Run tests and confirm missing-module failures.
- [ ] Implement the minimal utility code.
- [ ] Run tests and confirm pass.

### Task 3: Test-First EPUB Pipeline

**Files:**

- Test: `tests/epub/*.test.ts`
- Create: `src/Kavita/toc.ts`
- Create: `src/Kavita/html-assembler.ts`
- Create: `src/Kavita/resource-rewriter.ts`
- Create: `src/Kavita/models.ts`

- [ ] Write failing tests for TOC flattening, range calculation, fallback, stable IDs, sanitization, CSS/image inlining, missing resources, and limits.
- [ ] Run tests and confirm missing-module failures.
- [ ] Implement the EPUB pipeline.
- [ ] Run tests and confirm pass.

### Task 4: Test-First Kavita Client

**Files:**

- Test: `tests/kavita/client.test.ts`
- Create: `src/Kavita/client.ts`
- Create: `src/Kavita/errors.ts`
- Create: `src/Kavita/settings.ts`
- Create: `src/Kavita/manga-reader.ts`
- Create: `src/Kavita/novel-reader.ts`

- [ ] Write failing tests for authenticated request construction, endpoint paths, image URLs, book resources, and mark-read calls.
- [ ] Run tests and confirm missing-module failures.
- [ ] Implement the typed client and reader mapping.
- [ ] Run tests and confirm pass.

### Task 5: Test-First MAL Policy and Queue

**Files:**

- Test: `tests/mal/*.test.ts`
- Create: `src/MyAnimeList/policy.ts`
- Create: `src/MyAnimeList/queue.ts`
- Create: `src/MyAnimeList/client.ts`
- Create: `src/MyAnimeList/models.ts`

- [ ] Write failing tests for tracking modes, offsets, special/decimal handling, no-regression, volume finality, automatic completion, and queue result IDs.
- [ ] Run tests and confirm missing-module failures.
- [ ] Implement MAL policy, queue processing, and client request helpers.
- [ ] Run tests and confirm pass.

### Task 6: Paperback Entry Points and Docs

**Files:**

- Create: `src/Kavita/main.ts`
- Create: `src/Kavita/discovery.ts`
- Create: `src/Kavita/search.ts`
- Create: `src/Kavita/metadata.ts`
- Create: `src/Kavita/progress.ts`
- Create: `src/MyAnimeList/main.ts`
- Create: `src/MyAnimeList/auth.ts`
- Create: `src/MyAnimeList/forms/settings.ts`
- Create: `src/MyAnimeList/forms/tracking.ts`
- Create: `README.md`
- Create: `LICENSE`
- Create: `.github/workflows/verify.yml`

- [ ] Create thin Paperback extension adapters.
- [ ] Document setup, installation, commands, tracking policies, limitations, and attribution.
- [ ] Run typecheck, tests, and bundle.
