# Decisions

- 2026-06-20: Use one repository with two visible extension entry points: `mutsuki-kavita` and `mutsuki-myanimelist`.
- 2026-06-20: Pin Paperback packages to `1.0.0-alpha.92`, matching the current Sinon 0.9 stable reference. This can be updated after device testing against a specific Paperback app build.
- 2026-06-20: Use pnpm because the Codex runtime provides `pnpm@11.5.3` and this workspace has no existing lockfile.
- 2026-06-20: Reimplement Kavya and nyzzik behavior instead of copying code. Kavya is BSD-2-Clause but uses obsolete 0.8 APIs; nyzzik does not advertise a licence in the fetched metadata.
- 2026-06-20: Prefer inlining authenticated EPUB resources as data URLs. This avoids leaking credentials into generated HTML and avoids assuming Paperback HTML reader subrequests inherit extension headers.
- 2026-06-20: Encode EPUB logical chapter completion in stable IDs using `last:{0|1}` because current tracker action payloads expose chapter IDs and chapter/volume numbers.
- 2026-06-20: Default light novels to `volume-only` tracking. A volume advances only when the completed EPUB logical chapter has `last:1`.
- 2026-06-20: Where Paperback cannot expose Kavita read-completion events to the content extension, implement the safe client method and document the device-level limitation instead of inventing a backend.
