# Mutsuki Mock Progress Bridge

This is a deliberately small feasibility bridge for testing the Paperback extension progress hook.
It receives sanitized read-progress events from Mutsuki Kavita and displays them locally.

It does not talk to MyAnimeList yet. The production bridge will build on the same event shape with
Kavita polling, SQLite storage, MAL OAuth, title matching, and retry/outbox logic.

## Run Locally

```bash
pnpm --filter @mutsuki/mock-progress-bridge build
pnpm --filter @mutsuki/mock-progress-bridge start
```

Open `http://localhost:8080`.

## Docker

```bash
cd apps/mock-progress-bridge
docker compose -f docker-compose.example.yml up
```

The compose example pulls:

```text
ghcr.io/indigoxred/mutsuki/mock-progress-bridge:latest
```

For a local build, uncomment the `build` block in `docker-compose.example.yml`.

Configure Mutsuki Kavita in Paperback:

- Progress bridge URL: `http://<docker-host-ip>:8080`
- Progress bridge token: leave blank unless `MUTSUKI_BRIDGE_TOKEN` is set
