# Mutsuki Kavita MAL Bridge

This is the Phase 2 production bridge foundation. It runs outside Paperback, polls Kavita as the
progress source of truth, automatically maps Kavita series to MyAnimeList when confidence is high,
and queues monotonic MAL progress updates through a SQLite-backed outbox.

It is separate from `apps/mock-progress-bridge`, which remains a diagnostic receiver for Paperback
read-action feasibility tests.

## Current Capabilities

- SQLite persistence for mappings, review queue, outbox, and audit logs.
- Deterministic MAL matching from existing Kavita MAL URLs/IDs.
- Strict high-confidence title matching.
- Review queue for ambiguous or low-confidence matches.
- Manga defaults to chapter-and-volume tracking.
- Light novels default to volume-only tracking.
- Monotonic high-water MAL update planning with offsets.
- Dry-run mode enabled by default.
- Local Web/API status and unresolved-match views.

## Docker

```bash
cd apps/kavita-mal-bridge
docker compose -f docker-compose.example.yml up
```

Open:

```text
http://<docker-host-ip>:6768
```

Minimum environment:

```text
KAVITA_BASE_URL=https://read.example.test
KAVITA_API_KEY=your-kavita-auth-key
MUTSUKI_BRIDGE_DRY_RUN=true
```

Set `MAL_ACCESS_TOKEN` to an OAuth bearer token when you are ready to test live MAL API calls.
Keep dry-run enabled until the UI shows the expected mappings and queued updates.

## API

- `GET /api/status`
- `GET /api/unresolved-matches`
- `GET /api/audit-log`
- `POST /api/sync/run`

## Unraid Notes

Use container port `6768` and map it to host port `6768` or another free host port. Store
`/data` on persistent appdata storage so the SQLite database survives container upgrades.
