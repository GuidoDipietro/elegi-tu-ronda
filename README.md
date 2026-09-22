# Elegí Tu Ronda · Buenos Aires 2026

A one-off Spanish slot planner: React + TypeScript + Vite, one Vercel function, and PostgreSQL (Supabase). WCA OAuth for competitor identity; no Supabase browser client, local competitor passwords, results, rankings, or solve tracking.

## Product choices

- Competitors sign in with WCA. Only accounts with an accepted, competing registration for this competition can create a session. Others see an alert and a link to the WCA registration page. Newcomers without a WCA ID are supported through their numeric WCA account ID.
- The server resolves booking ownership from an HttpOnly session cookie. Public name entry and client-selected competitor IDs cannot authorize edits. Organization retains password-protected access to every schedule.
- There is no restriction to registered events. Public occupancy does not list competitors; the protected admin matrix does.
- Competitors select only an event for each Slot, including unofficial FTO. The round is determined on competition day; the same event can occupy multiple Slots.
- Each competitor starts with a maximum of **2 guaranteed Slots**. Organization changes the total in `/admin` (for example 2 → 4 → 6). The limit also applies to admin bookings. Lowering it preserves existing bookings and allows edits/cancellations, but blocks new bookings until the person is below the limit. Cancellations restore allowance.
- Lowering capacity keeps existing reservations and flags overbooking. Existing bookings can still be edited or removed; new people cannot book a full or overbooked Slot.
- One organizer password, stored only on the server. Signed HttpOnly cookies expire after eight hours. Changing the password invalidates existing sessions.
- Reservations can be closed. Organizers can still edit while closed; competitors can only view.

The schedule was read from [WCA's public WCIF](https://www.worldcubeassociation.org/api/v0/competitions/ElegiTuRondaBA2026/wcif/public) on September 21, 2026: October 24, Slots A–H start at 15:30, 16:00, 16:30, 17:00, 17:30, 18:00, 18:30 and 19:00 Buenos Aires time. Each has 20 minutes of solving and an initial capacity of 10. Six solving stations are informational, not an additional per-event constraint.

## Run locally

Use Node **22.12+** (Node 24 tested) and a PostgreSQL database. Supabase works for local development too.

```sh
npm ci
cp .env.example .env
# Edit DATABASE_URL and ADMIN_PASSWORD in .env.
npm run db:setup
npm run dev
```

Open `http://localhost:5173`. The admin page is `/admin`.

For local PostgreSQL without Supabase:

```sh
docker run --name ronda-local --rm -d -p 127.0.0.1:5432:5432 \
  -e POSTGRES_PASSWORD=local-password -e POSTGRES_DB=ronda postgres:17-alpine
```

Set `DATABASE_URL=postgresql://postgres:local-password@127.0.0.1:5432/ronda` and remove `PGSSLMODE` from `.env` for this local connection. Choose an `ADMIN_PASSWORD` of at least 12 characters. For real deployment use a long random password, not the example values. `npm run dev` serves the real API and frontend together; a plain static Vite preview cannot run the backend.

## Supabase + Vercel deployment

1. Create a Supabase project. In **Connect**, copy the **Transaction pooler** PostgreSQL URI (usually port 6543). URL-encode any special characters in the database password. For production setup, put it in `DATABASE_URL` in a separate, git-ignored `.env.production`, and set `PGSSLMODE=verify-full`. The server bundles the public Supabase root CA in `src/server/supabase-ca.ts` and enforces verified TLS for Supabase hosts, both locally and on Vercel. No certificate path or extra Vercel environment variable is needed. Keep `.env` pointing at your local database.
2. Run `npx tsx --env-file=.env.production scripts/setup.ts` against that database. Import the roster with `npx tsx --env-file=.env.production scripts/import-roster.ts`. This creates the `planner` schema and seeds the events and Slots. Running it again updates event labels/rounds but **preserves existing Slot capacities and all bookings**.
3. Import this project into Vercel using the Vite preset. `vercel.json` specifies the build, output directory and `/admin` rewrite. Use Node 24.
4. Add `DATABASE_URL`, `PGSSLMODE=verify-full`, and `ADMIN_PASSWORD` to the appropriate Vercel environments. These are server secrets: **never prefix them with `VITE_`**. The database URL is the only Supabase credential needed; no anonymous or service-role API key is needed.
5. Deploy, open `/admin`, and sign in. Import the roster if useful, check the eight capacities, and share the public URL.

The `api/planner.ts` function uses Vercel's Node Web Request/Response handler. All database access stays in that function. The `planner` schema is separate from Supabase's default exposed `public` schema and revokes PUBLIC access; do not add it to exposed Data API schemas or grant browser roles access. Use a dedicated database/project for this one-off app. The server pool uses at most three connections per function instance and no named prepared statements, so it works with transaction pooling.

References: [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js), [Supabase PostgreSQL connections](https://supabase.com/docs/guides/database/connecting-to-postgres).

## Roster import

An imported roster is optional: WCA sign-in checks the live accepted registration list and creates the competitor automatically. Organization can click **Importar desde WCA** to add accepted registrants, or import JSON. CLI equivalents:

```sh
npm run roster:import
npm run roster:import -- ./my-roster.json
```

JSON format (see `roster.example.json`):

```json
[{ "name": "Nombre Apellido", "wcaId": null }]
```

Imports preserve identities and existing bookings. Duplicate normalized names in an import are rejected so organizers can disambiguate them first. WCA matching uses the stable account ID or WCA ID, never a name alone. JSON may include `wcaUserId`; WCIF imports include it automatically. Imports add metadata/people; they intentionally do not delete people, remove bookings, or automatically rename identities when WCA names change. The app does not send messages or distribute links.

## Configuration and data model

- `src/config.ts`: competition metadata, event labels, allowed rounds, initial Slot timestamps and capacities.
- `db/schema.sql`: tables, constraints and capacity trigger.
- `src/server/service.ts`: transactions and booking operations.
- `src/main.tsx`: competitor timeline and organizer UI.

`competitors` holds a stable ID, display name, name key, optional WCA ID, and unique numeric WCA account ID. `oauth_states` stores hashed browser-bound login challenges that expire after 10 minutes and are consumed once. `competitor_sessions` stores hashed opaque session tokens with a 30-day expiry; logout revokes the current session. WCA access tokens are used only for the `/me` request and are not stored. `events` defines allowed rounds. `slots` defines start time and capacity. `bookings` has `(competitor_id, slot_id)` as its primary key. `settings` stores the reservation lock and `max_slots` limit. Legacy round columns remain for deployment compatibility and historical bookings; event-only requests default to the internal round value 1, which is not displayed or used to decide the competition-day round.

For this competition, change live capacities in `/admin`. Other live schedule changes can be made in Supabase's SQL editor; timestamps are `timestamptz`. Seed reruns insert new Slot IDs but do not rewrite existing Slot timestamps or remove old Slots. Do not change Slot IDs with live bookings. To reuse the app for another competition, update `src/config.ts` and start with a fresh database/schema; this is intentionally a single-competition app.

## Capacity and concurrency

The booking transaction takes a shared lock on the reservation setting, then a `FOR UPDATE` lock on the competitor and then the Slot. It reads occupancy, validates the requested event/round, and upserts the booking before committing. Capacity changes lock the same Slot row, so they serialize with bookings. Closing reservations waits for in-flight booking transactions.

The SQL trigger independently locks settings, competitor, and Slot in that order and rejects new bookings exceeding either the per-person limit or Slot capacity, including concurrent direct SQL inserts. PostgreSQL's primary key prevents two bookings by one person in one Slot. Foreign keys and round checks prevent dangling or invalid bookings. Updates keep the original place even if capacity has since been reduced. Cancellations use the same lock and are idempotent.

The UI refreshes every 15 seconds and on window focus; the database is authoritative when someone saves. A stale full Slot returns a clear error and refreshes occupancy. Simultaneous edits of the same person's booking use last successful save wins.

## Tests

```sh
npm test          # unit tests: booking rules, identity, admin signatures, formatting/CSV
npm run build    # TypeScript checks + production frontend build
```

Database tests use **real PostgreSQL**, including competing independent connections. They reset only the `planner` schema in the explicitly supplied disposable database and require its name to end in `_test`. Never use production credentials here.

```sh
docker run --name ronda-tests --rm -d -p 127.0.0.1:55439:5432 \
  -e POSTGRES_PASSWORD=test-password -e POSTGRES_DB=ronda_test postgres:17-alpine
TEST_DATABASE_URL=postgresql://postgres:test-password@127.0.0.1:55439/ronda_test?sslmode=disable npm run test:db
```

The integration suite seeds the test database. Then run the browser test against that same test database:

```sh
npx playwright install chromium
TEST_DATABASE_URL=postgresql://postgres:test-password@127.0.0.1:55439/ronda_test?sslmode=disable npm run test:e2e
```

Alternatively set `CHROME_PATH` to an installed Chrome binary. Browser tests start their own local server and use a test-only admin password. They cover mobile event-only booking/editing, repeated events, FTO, returning sessions, logout, rejected-registration messaging, full Slots, per-person limits and wave increases, organizer capacity changes, reservation closure and cancellation. Screenshots are saved under `test-results/`. Stop the disposable database with `docker stop ronda-tests`.

## UX checks included

Full Slots prevent new reservations but remain editable for their owners. Save buttons disable during requests. Round controls and labels are absent from both screens and CSV exports. Empty event choices cannot save. Repeated events display a continuation hint. Competitors see their remaining guaranteed Slot allowance, and new-booking buttons disable at the limit. Canceling an edit leaves the original booking intact. Releasing a place asks for inline confirmation. The current competitor's name stays visible and a separate control signs out. Occupancy is shown with text as well as color, inputs have labels, and the matrix scrolls horizontally on phones. CSV exports neutralize spreadsheet formula prefixes in entered names.

## Deploying the booking-limit update

Apply the additive schema upgrade **before** deploying the new app:

```sh
npx tsx --env-file=.env.production scripts/setup.ts
```

This defaults the total allowance to 2, preserves all existing reservations (including people already above 2), and preserves an already configured limit on repeat runs. Existing clients also receive database enforcement immediately. No roster re-import is needed.

Then push `main` to the connected GitHub repository and verify the Vercel production deployment succeeds. If automatic Git deployments are disabled, deploy the latest commit from the Vercel dashboard. Open `/admin` → **Slots garantizados por competidor** to set each wave's total (2, 4, 6…). Competitors receive the updated allowance on their next refresh, within 15 seconds while the page is visible.

## WCA OAuth setup and release

1. Create a confidential application at [WCA OAuth applications](https://www.worldcubeassociation.org/oauth/applications). Use scope **public** and this exact redirect URI:
   `https://elegi-tu-ronda.vercel.app/api/planner?action=wcaCallback`
2. Add server-only Vercel **Production** environment variables:
   - `WCA_CLIENT_ID`: the application's ID.
   - `WCA_CLIENT_SECRET`: its secret. Never put this in source, chat, or a `VITE_` variable.
   - `WCA_REDIRECT_URI`: the exact redirect URI above.
3. Apply the additive migration before deploying: `npx tsx --env-file=.env.production scripts/setup.ts`. This command preserves all data. Dummy-data removal is a separate, explicitly authorized operation, not part of setup.
4. Push and deploy the commit. Environment changes require a new Vercel deployment. Verify `/api/planner` returns `wcaLoginAvailable: true`, then test **Ingresar con WCA** with an accepted registrant. Test a nonregistrant separately: the alert must link to `https://www.worldcubeassociation.org/competitions/ElegiTuRondaBA2026/register`.

For local OAuth, register the exact local callback (for example `http://localhost:5173/api/planner?action=wcaCallback`) in a separate development OAuth application and configure the three variables in `.env`. No sign-in bypass exists when credentials are missing: occupancy remains public and booking requires OAuth. Preview deployments need their own registered callback and environment settings.

Acceptance is checked against live public WCIF on each sign-in; WCA outages fail closed. Existing sessions remain valid until logout or their 30-day expiry. Organizer edits remain available independently of WCA OAuth. Existing identifier-matched bookings are preserved. Name-only records are deliberately not automatically claimed; for this rollout, the owner authorized clearing the dummy competitors and reservations before launch.

The database integration tests mock WCA's external responses and exercise the real callback, state validation/replay prevention, accepted-registration check, identity linking, session expiry/revocation, and booking authorization. Browser tests create sessions directly in their disposable `_test` database; this adds no HTTP test-auth endpoint. A real WCA consent round-trip still requires the deployed application credentials and a human WCA login.

Reference: [WCA's OAuth authorization-code flow](https://docs.worldcubeassociation.org/knowledge_base/v0_api.html).
