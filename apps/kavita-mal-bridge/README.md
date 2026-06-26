# Mutsuki Kavita MAL Bridge

This is the Phase 2 production bridge foundation. It runs outside Paperback, polls Kavita as the
progress source of truth, automatically maps Kavita series to MyAnimeList when confidence is high,
and queues monotonic MAL progress updates through a SQLite-backed outbox.

It is separate from `apps/mock-progress-bridge`, which remains a diagnostic receiver for Paperback
read-action feasibility tests.

## Current Capabilities

- SQLite persistence for mappings, review queue, outbox, and audit logs.
- Local setup UI for Kavita, MAL OAuth client settings, dry-run mode, and poll interval.
- MAL OAuth callback handling with persisted access/refresh tokens.
- Token refresh before scheduled/manual sync runs.
- Deterministic MAL matching from existing Kavita MAL URLs/IDs.
- Strict high-confidence title matching.
- Review queue and manual approval controls for ambiguous or low-confidence matches.
- Manga defaults to chapter-and-volume tracking.
- Light novels default to volume-only tracking.
- Monotonic high-water MAL update planning with offsets.
- Dry-run mode enabled by default.
- Scheduled polling with overlap prevention.
- Local Web/API status, setup, audit, and unresolved-match views.

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
MUTSUKI_BRIDGE_DRY_RUN=true
```

The container can start without Kavita or MAL secrets so the setup UI is reachable. Save these in
the Web UI:

- Kavita URL and Kavita Auth/API key
- MAL OAuth client ID, optional client secret, and redirect URI
- poll interval
- dry-run mode

For MAL OAuth, create a MAL API client and use a redirect URI that points back to the bridge, for
example:

```text
http://192.168.50.138:6768/api/mal/oauth/callback
```

After saving the MAL client settings, use **Authorize MAL** on the bridge page. Keep dry-run enabled
until the UI shows the expected mappings and queued updates.

## API

- `GET /api/status`
- `GET /api/unresolved-matches`
- `GET /api/audit-log`
- `POST /api/sync/run`
- `POST /api/settings`
- `GET /api/mal/oauth/start`
- `GET /api/mal/oauth/callback`
- `POST /api/unresolved-matches/:kavitaSeriesId/approve`

## Unraid Notes

Use container port `6768` and map it to host port `6768` or another free host port. Store
`/data` on persistent appdata storage so the SQLite database survives container upgrades.
