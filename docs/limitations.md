# Limitations

- Live Paperback device verification is still required for OAuth callback handling, HTML reader asset rendering, and bundle installation.
- Live Kavita verification is required for server-version compatibility across older Kavita releases. Unit tests use current endpoint names from the upstream `develop` branch and synthetic fixtures.
- The first implementation uses a conservative resource inliner. Oversized resources are replaced with reader-safe placeholders.
- PDF text reflow is out of scope. PDF chapters are treated as image-based chapters through Kavita reader endpoints.
- Automatic MAL matching is implemented only in the Docker bridge. It auto-links deterministic
  Kavita MAL metadata and high-confidence title matches; ambiguous or low-confidence matches remain
  in the review queue and are not written to MAL until approved.
- Kavita sync reliability depends on Kavita's SQLite database and appdata storage being healthy.
  Live testing on 2026-06-26 found intermittent Kavita `SQLite Error 10: disk I/O error` responses
  while the Unraid cache device was logging repeated BTRFS checksum corruption. The bridge reduces
  unnecessary readiness load, but it cannot repair server-side storage corruption.
