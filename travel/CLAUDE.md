# Wander — Travel Planning App

Browser-based trip planner for two: prioritized destinations, per-trip itinerary
(transport/stays/POIs) with booking status, conflict detection, a Leaflet route
map, budgeting, booking agents, resources, and a Claude-backed AI assistant
(chat, cost estimates, itinerary proposals, itinerary import/parsing).

Stack: React/Vite/TS/Tailwind client, Express/TS/Prisma server, Postgres, all
in Docker via `docker-compose.yml`. See `README.md` for the full feature map
and data model.

Postgres is **not** run locally in this stack — the server connects to a
shared external Postgres server (`DATABASE_URL` in `.env`), using the
`locations` database alongside unrelated tables from other apps (owned by
`homedash`, see `/home/ilan/Dev2/homelab/homedash/config/config.json` →
`db_connections` for host/credentials). Travel's own tables are all
PascalCase (`User`, `Trip`, `TripItem`, etc., matching the Prisma model
names) so they don't collide with the other apps' snake_case tables.

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
migration against the external Postgres before rebuilding the server image:

```bash
cd server
DATABASE_URL="$(grep DATABASE_URL ../.env | cut -d= -f2-)" npx prisma migrate dev --name <description> --skip-generate
npx prisma generate
```

(Credentials come from `DATABASE_URL` in `.env` at the repo root.) The server's `CMD` also runs
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
- For anything touching layout/styling, verify visually with Playwright
  (already installed; Chromium is cached under `~/.cache/ms-playwright`, so
  `npm install playwright --no-save` in a scratch dir + a small script using
  `chromium.launch()` is enough — no browser download needed) before
  reporting a visual fix as done. Register a throwaway user the same way as
  the curl case, screenshot the relevant page/state, and delete that test
  user afterward.

## Repo location note

This working copy lives at `/home/ilan/Dev2/travel`. It is *not* its own git
repo — commits are synced (via `rsync`, excluding `node_modules`/`dist`/`.env`)
into `/home/ilan/Dev2/music/travel/` and committed there, since that's where
the user keeps this project's git history (`github.com/ilanreiter/music-apps`,
a personal multi-app monorepo). When asked to commit/push, sync into that
copy rather than trying to `git init` this directory.
