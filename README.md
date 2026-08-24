# BeyondDNDBeyond

A remote-play 3D virtual tabletop for Dungeons & Dragons 5e — built for a small group of friends who play together online, with some players in Scotland. The goal is to get as close as possible to sitting around a real table together: a 3D room with a table, everyone seated with their own avatar, a live map on the tabletop surface, and full D&D 5e mechanics running underneath so the DM doesn't have to referee every roll by hand.

## What it does

- **3D table** — a shared room rendered in the browser (React Three Fiber / Three.js), with each player seated around the table from their own camera angle (or free orbit), seeing everyone else's chosen avatar in their seat.
- **Character sheets** — full 5e SRD rules automation: ability modifiers, saves, skills, spell slots, attack bonuses, passive scores, all calculated live. Characters can be built from scratch or imported from a D&D Beyond PDF export.
- **Map builder** — the DM sculpts terrain with discrete elevation steps, paints difficult terrain, and populates rooms with built-in or custom-uploaded 3D props and interactive points of interest (levers, chests, doors) that reveal information or trigger effects live at the table.
- **Combat mode** — initiative, HP, conditions, death saves, concentration, opportunity attacks, and a contextual quick-actions panel that surfaces in-range attacks/spells without forcing a player into them.
- **Per-player vision** — darkness, darkvision, and blindness actually change what each player can see on the table, independently, with players retaining memory of areas they've previously seen. Hiding/Stealth works for both monsters and player characters.
- **DM tools** — a rule-override control for bending a limit on the fly, an action-economy strictness toggle for looser house-rule play, quick NPC/monster stat blocks, and a narrative layer (NPC roster, world/lore pages, session log, handouts, private notes) with optional AI-assisted drafting.
- **Lobby & DM rotation** — an open lobby after login shows who's around; once enough people are online, anyone can start a session and becomes that campaign's DM for the night. The DM role isn't fixed to one person — it can be handed off at any time.

## Status

Implementation is underway, prompt by prompt, so the app can be reviewed and adjusted as it forms rather than built all at once. Prompts 1-13 (scaffolding, module boundaries, design system, database schema, email/password auth, campaign creation/join, DM role handoff, the character data model, the 5e rules engine, the character creation flow, the full character sheet, the rest mechanic, and the avatar library/upload) are complete and verified end to end against a running local Supabase stack.

See [`Claude_Code_Prompts_BeyondDNDBeyond_2026-08-24.md`](./Claude_Code_Prompts_BeyondDNDBeyond_2026-08-24.md) for the full 62-prompt roadmap — sequential, self-contained build instructions covering everything from project scaffolding through combat mechanics, the vision system, and self-hosted deployment.

## Stack

- **Frontend:** Next.js (App Router) + TypeScript, React Three Fiber for the 3D scene, CanvasUI for WebGL UI effects
- **Backend:** Self-hosted Supabase (Postgres, Auth, Realtime, Storage) via Docker Compose
- **Deployment:** Self-hosted behind an existing Nginx Proxy Manager reverse proxy

## Local development

**1. Start the self-hosted Supabase stack** (Postgres, Auth, Realtime, Storage, Studio — via Docker Compose):

```sh
cd supabase
docker compose up -d
```

The first run needs secrets generated once (already done in this repo's history, but if you're
setting up fresh or rotating keys):

```sh
cd supabase
cp .env.example .env
sh utils/generate-keys.sh --update-env
```

Studio is reachable at [http://localhost:8000](http://localhost:8000) once the stack is healthy
(`docker compose ps` to check container status). This self-hosted version protects the
dashboard behind HTTP Basic Auth — log in with `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`
from `supabase/.env`.

**2. Configure the app's environment:**

```sh
cp .env.example .env
```

Fill in `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` from `supabase/.env`
(the `ANON_KEY` / `SERVICE_ROLE_KEY` values generated in step 1).

**3. Start the Next.js dev server:**

```sh
yarn dev
```

The app is served at [http://localhost:3000](http://localhost:3000) — sign up at `/signup`,
you'll be prompted for a display name on first login, then land on the home page. A health
check confirming the app can reach Supabase is available at
[http://localhost:3000/api/health](http://localhost:3000/api/health).

**Requires:** the user running Docker commands must be able to access the Docker daemon (in
the `docker` group, or run via `sudo`) — `sudo usermod -aG docker $USER` and re-login if you
hit a permission-denied error against `/var/run/docker.sock`.

## Module boundaries

The app is split into five independently-testable modules under `src/`, each with its own
`README.md` and a single public entry point (`index.ts`) — other modules should only ever
import from that entry point, never reach into a module's internal files:

| Module | Responsibility |
|---|---|
| `ui-components` | Shared design-system components (buttons, panels, inputs, modals, badges), built on the design tokens and CanvasUI. |
| `scene-3d` | React Three Fiber scene code — the table, seating, avatars, live map rendering, tokens, vision masking. |
| `rules-engine` | Pure D&D 5e SRD game logic — no UI, no database dependency. Fully unit-testable in isolation. |
| `realtime` | Wraps Supabase Realtime channels/presence behind a typed event-bus. |
| `data-access` | The **only** module allowed to import `@supabase/supabase-js` directly — every other module goes through here for persistence. |

This is enforced by ESLint (`eslint-plugin-boundaries`, configured in `eslint.config.mjs`), not
just convention — e.g. a UI component importing `@supabase/supabase-js` directly, or
`rules-engine` importing anything outside itself, both fail `yarn lint`.

## Testing

```sh
yarn test          # run once
yarn test:watch    # watch mode
```

Vitest is configured (`vitest.config.ts`) to run every `*.test.ts`/`*.test.tsx` file under
`src/`, loading `.env` so tests that touch modules needing real config (like `data-access`)
work without extra setup.

## Performance budgets

Four checks, with generous starting budgets recorded in `perf-budgets.json` (tightened as the
app grows past this early-scaffolding baseline):

```sh
yarn perf:bundle      # client JS bundle size vs. budget
yarn perf:render      # headless 3D frame-time benchmark (Playwright + Three.js)
yarn perf:lighthouse  # Lighthouse performance/accessibility scores
yarn perf:realtime    # concurrent-client Supabase Realtime latency test
yarn perf:all         # run all four in sequence
```

`perf:bundle` and `perf:lighthouse` need a production build first (`yarn build`).
`perf:realtime` needs the Supabase stack running (see above). `perf:render` and
`perf:lighthouse` share Playwright's Chromium install rather than downloading Chrome twice.

## Database migrations

No Supabase CLI is available in this environment, so migrations are plain numbered `.sql`
files under `supabase/migrations/`, applied in order and tracked in a `_migrations` table —
re-running is a no-op for anything already applied, and running against a fresh database
applies everything from scratch.

```sh
node scripts/db/migrate.mjs           # apply any pending migrations
node scripts/db/verify-rls.mjs        # create two throwaway users and verify RLS boundaries
node scripts/db/verify-campaigns.mjs  # verify campaign creation + invite-code join end to end
```

All three connect through Supavisor (the pooler Docker Compose exposes on `localhost:5432`) using
the tenant-qualified username `postgres.$POOLER_TENANT_ID` — plain `postgres` fails with
"no tenant identifier provided" against a pooled connection.

**A real RLS gotcha worth knowing if you add more policies:** `INSERT ... RETURNING` (what
`.insert().select()` does in supabase-js, or the `Prefer: return=representation` header)
applies the table's **SELECT** policy to the returned row, not just the INSERT policy's
`WITH CHECK`. If a row only becomes visible once a *different* table has a row that doesn't
exist yet — e.g. a campaign only becomes readable once a matching `campaign_members` row
exists — inserting-and-immediately-selecting it fails with a misleading "violates row-level
security policy" error even though the insert itself was allowed. Work around it by inserting
without `.select()` (generate the id client-side with `crypto.randomUUID()` if you need it
immediately) and reading the row back afterward, once whatever it depends on exists.
Relatedly, a policy's own `USING`/`WITH CHECK` subquery against a **different** table is
subject to *that* table's RLS too — wrap cross-table bootstrap checks (like "is this user the
creator of this campaign") in a `SECURITY DEFINER` function, or the same chicken-and-egg
problem shows up one level deeper (see `is_campaign_creator` in
`supabase/migrations/0004_campaign_rls_policies.sql`).

One more, unrelated to RLS but easy to hit in the same kind of function: a PL/pgSQL function
declared with `RETURNS TABLE (campaign_id uuid, ...)` implicitly declares `campaign_id` as an
in-scope variable for the *entire function body* — if the body also does DML against a real
table with a `campaign_id` column (e.g. inserting into `campaign_members`), Postgres reports
`column reference "campaign_id" is ambiguous`. Give `RETURNS TABLE` columns names that can't
collide with real column names (see `join_campaign_by_invite_code`'s `result_campaign_id` in
`supabase/migrations/0005_campaign_invite_codes.sql`).
