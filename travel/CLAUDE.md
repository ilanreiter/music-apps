# Wander — Travel Planning App

Browser-based trip planner for two: prioritized destinations, per-trip itinerary
(transport/stays/POIs) with booking status, conflict detection, a Leaflet route
map, budgeting, booking agents, resources, and a Claude-backed AI assistant
(chat, cost estimates, itinerary proposals, itinerary import/parsing).

Stack: React/Vite/TS/Tailwind client, Express/TS/Prisma server, Postgres, all
in Docker via `docker-compose.yml`. See `README.md` for the full feature map
and data model.

## Running changes — rebuild the containers

This stack runs as **built** Docker images, not dev servers with hot reload.
A code edit is not live until you rebuild and restart the affected service:

```bash
docker compose build client      # after client/ changes
docker compose build server      # after server/ changes
docker compose up -d client server   # restart whichever changed
```

Forgetting this step is the most common way a fix "doesn't seem to work" —
the running container is still serving the old build. Always rebuild before
telling the user a change is live at http://localhost:8080.

If the change touches `server/prisma/schema.prisma`, generate and apply a
migration against the running Postgres (port 5432 is published to
`127.0.0.1` for exactly this) before rebuilding the server image:

```bash
cd server
DATABASE_URL="postgresql://<user>:<password>@localhost:5432/<db>" npx prisma migrate dev --name <description> --skip-generate
npx prisma generate
```

(Credentials come from `.env` at the repo root.) The server's `CMD` also runs
`prisma migrate deploy` on container start, so a committed migration applies
itself in fresh environments — but during local iteration, generate it first
the way above so it's applied immediately and the migration file exists to
commit.

## Before calling a change done

- `npx tsc -b --force` in `client/`, `npx tsc -p tsconfig.json --noEmit` in
  `server/` — both should be clean.
- Rebuild + restart the container(s) as above.
- For anything touching the API, verify with a real `curl` request (register
  a throwaway user, hit the endpoint, then delete that test user/data from
  the DB afterward — don't leave test data in the shared dataset).

## Repo location note

This working copy lives at `/home/ilan/Dev2/travel`. It is *not* its own git
repo — commits are synced (via `rsync`, excluding `node_modules`/`dist`/`.env`)
into `/home/ilan/Dev2/music/travel/` and committed there, since that's where
the user keeps this project's git history (`github.com/ilanreiter/music-apps`,
a personal multi-app monorepo). When asked to commit/push, sync into that
copy rather than trying to `git init` this directory.
