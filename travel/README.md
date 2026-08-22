# Wander — Travel Planning App

A browser-based app for planning travel as a couple: a prioritized destination
wishlist, detailed per-trip planning (transport, stays, points of interest,
booking status, conflict detection, route optimization), financial planning
(rough AI estimates + detailed budgets), booking agent contacts, a resource
library, and an AI travel assistant powered by Claude.

## Stack

- **Frontend**: React + TypeScript + Vite + Tailwind CSS, served by Nginx
- **Backend**: Node.js + Express + TypeScript + Prisma
- **Database**: PostgreSQL
- **AI**: Anthropic Claude API (`@anthropic-ai/sdk`)
- **Auth**: Simple email/password with JWT session cookie (meant for a small
  household, not a public multi-tenant app)
- Everything runs in Docker via `docker-compose.yml`

## Quick start

```bash
cp .env.example .env
# edit .env: set JWT_SECRET, POSTGRES_PASSWORD, and (optionally) ANTHROPIC_API_KEY
docker compose up -d --build
```

Then open http://localhost:8080 and create an account (the "New here? Create
an account" link on the login screen) — no separate signup flow is needed for
the two of you, just register twice with your own emails.

The server automatically runs `prisma migrate deploy` on startup, so the
database schema is created for you on first boot.

### Enabling the AI assistant

The AI Assistant page and the "rough cost estimator" on the Finances page
both call the Claude API. Set `ANTHROPIC_API_KEY` in `.env` (get one at
https://console.anthropic.com/) and restart the `server` container:

```bash
docker compose up -d server
```

Without a key, those two features degrade gracefully — the UI explains AI
isn't configured, but the rest of the app works normally.

### Optional: seed sample data

```bash
docker compose exec server npm run seed
```

Seeds one user (`SEED_USER1_*` env vars, defaulting to a demo login) and a
few sample destinations, so you're not staring at an empty app.

## Feature map

| Area | Where |
|---|---|
| Prioritized destination list | **Destinations** page — reorder with ▲/▼, track status (idea → researching → planned → booked → visited) |
| Trip planning | **Trips → a trip** starts with high-level basics (dates or duration+season, planning type, goal/style), then the **Itinerary tab** for transport/stay/POI/activity items with dates, cost, provider, booking status |
| Building an itinerary | Shown automatically for an empty trip: **start from scratch**, **paste/upload an existing itinerary** (including pasted email text — parsed into structured items by Claude), or **propose with AI** (Claude drafts a day-by-day plan from the trip's goal + your saved preferences). Proposals are reviewed/checked before anything is added |
| Travel preferences | **Preferences** page — shared household interests/pace/budget style/notes, fed into every AI itinerary proposal and estimate |
| Conflict detection | Automatic — shown as a banner at the top of a trip when two time-bound items (esp. transport/stays) overlap |
| Route optimization | **Trips → a trip → Route tab** — nearest-neighbor ordering of POIs with lat/lng, to minimize backtracking |
| Financial planning | **Finances** page for AI rough estimates + a per-trip totals view; **Trip → Budget tab** for category-by-category estimated vs. actual |
| Booking agents | **Booking Agents** page — contacts/agencies, linkable to individual itinerary items |
| Resource discovery | **Resources** page (global) and the **Resources tab** on a trip (scoped) — guides, visa info, packing lists, links |
| AI integration | **AI Assistant** page (chat, trip-aware) and the estimator on **Finances** |

## Development (without Docker)

Backend:
```bash
cd server
npm install
# requires a local Postgres; set DATABASE_URL accordingly, e.g. via a throwaway container:
#   docker run -d -p 5432:5432 -e POSTGRES_USER=travel -e POSTGRES_PASSWORD=travel -e POSTGRES_DB=travel postgres:16-alpine
npx prisma migrate dev
npm run dev
```

Frontend:
```bash
cd client
npm install
npm run dev
```

The Vite dev server proxies `/api` to `http://localhost:4000` by default (see
`client/vite.config.ts`).

## Data model

See `server/prisma/schema.prisma` for the full model. At a glance:

- `Destination` — the wishlist, with `priority` for ordering
- `Trip` — optionally linked to a `Destination`; carries high-level planning fields (`durationNights`/`travelSeason` for pre-date planning, `planningType`, `goal`)
- `TripItem` — a polymorphic itinerary entry (`TRANSPORT`/`STAY`/`POI`/`ACTIVITY`/`OTHER`) carrying timing, cost, and booking status/confirmation/agent
- `BudgetLine` — category-based estimated vs. actual spend per trip
- `BookingAgent` — a contact/agency, linkable to `TripItem`s
- `Resource` — links/notes scoped to a destination and/or trip
- `AiMessage` — chat history for the assistant, scoped per trip (or general)
- `Preferences` — a single shared-household row (interests, pace, budget style, free-text notes) used to steer AI itinerary proposals

## Notes on the "basic-but-working" pieces

- **Conflict detection** is date-overlap logic (`server/src/lib/conflicts.ts`), not a full scheduling solver — it flags overlapping transport/stay windows, which is the case that actually matters (you can't be on two flights at once).
- **Route optimization** is nearest-neighbor over straight-line (haversine) distance (`server/src/lib/routeOptimize.ts`) — good enough for ordering a day's POIs, not a real routing-API integration with roads/transit times.
- **"Import from email"** is paste-in, not a live inbox connection — there's no email account wired into this app. Copy the itinerary/confirmation text out of the email and paste it (or save it as a `.txt`/`.eml` file and upload it) into the "Import existing itinerary" flow; Claude parses it the same way either way.
- The Postgres port (5432) is published to `127.0.0.1` only in `docker-compose.yml`, so you can point a local GUI client or run `prisma migrate dev` against it directly without exposing it beyond your machine.
