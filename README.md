# BeyondDNDBeyond

A remote-play 3D virtual tabletop for Dungeons & Dragons 5e — built for a small group of friends who play together online, with some players in Scotland. The goal is to get as close as possible to sitting around a real table together: a 3D room with a table, everyone seated with their own avatar, a live map on the tabletop surface, and full D&D 5e mechanics running underneath so the DM doesn't have to referee every roll by hand.

## What it does

- **3D table** — a shared room rendered in the browser (React Three Fiber / Three.js), with each player seated around the table from their own camera angle (or free orbit), seeing everyone else's chosen avatar in their seat.
- **Character sheets** — full 5e SRD rules automation: ability modifiers, saves, skills, spell slots, attack bonuses, passive scores, all calculated live. Characters can be built from scratch or imported from a D&D Beyond PDF export, and everything on the sheet — race, class, and level included — stays editable afterwards, so a mis-set or mis-OCR'd field is fixable in place (a race change re-derives speed and darkvision automatically).
- **Map builder** — the DM sculpts terrain with discrete elevation steps, paints difficult terrain, and populates rooms with built-in or custom-uploaded 3D props and interactive points of interest (levers, chests, doors) that reveal information or trigger effects live at the table.
- **Combat mode** — initiative, HP, conditions, death saves, concentration, opportunity attacks, and a contextual quick-actions panel that surfaces in-range attacks/spells without forcing a player into them.
- **Per-player vision** — darkness, darkvision, and blindness actually change what each player can see on the table, independently, with players retaining memory of areas they've previously seen. Hiding/Stealth works for both monsters and player characters.
- **DM tools** — a rule-override control for bending a limit on the fly, an action-economy strictness toggle for looser house-rule play, quick NPC/monster stat blocks, and a narrative layer (NPC roster, world/lore pages, session log, handouts, private notes) with optional AI-assisted drafting.
- **Lobby & DM rotation** — an open lobby after login shows who's around; once enough people are online, anyone can start a session and becomes that campaign's DM for the night. The DM role isn't fixed to one person — it can be handed off at any time.

## Status

Implementation is underway, prompt by prompt, so the app can be reviewed and adjusted as it forms rather than built all at once. Prompts 1-61 (scaffolding, module boundaries, design system, database schema, email/password auth, campaign creation/join, DM role handoff, the character data model, the 5e rules engine, the character creation flow, the full character sheet, the rest mechanic, the avatar library/upload, D&D Beyond PDF character import, the Account page, the real-time campaign channel, reconnection/session resilience, the Lobby screen, the 3D table scene foundation, player seating/camera, rendering seated avatars, the session start/DM assignment flow, the map/asset data model, the built-in preset asset library, the custom asset upload pipeline, the map editor's terrain/elevation tool, object/POI placement, interactive POI behavior, live map rendering/switching on the tabletop, the grid overlay/token placement system, elevation/terrain-aware drag-to-move for tokens, the campaign narrative data model, the NPC roster, the world/lore page wiki, the session log/live handout reveal system, the private DM notes/house rules editors, AI-assisted NPC/lore drafting, AI-assisted procedural map area generation, map folders/thumbnails, map duplication/starter templates, map editor undo/redo, multi-floor map transitions, the measuring/ruler tool, the editor-only reference image underlay, the combat initiative tracker, in-combat HP/damage tracking, status condition tracking, the integrated server-side dice roller, death saving throws with instant death, concentration tracking, the contextual quick-actions panel, the DM rule-override control, action economy tracking with the DM strictness toggle, opportunity attacks with the Disengage action, the character-vision/map-lighting data model, the perception/vision rules engine, the map editor's lighting authoring mode, per-player vision rendering with seen-cell fog-of-war memory, vision-driven automatic advantage/disadvantage on attack rolls, Hide/Stealth with per-observer hidden state for players and NPCs alike, and the DM's NPC/monster stat-block tools with mid-combat quick-add) are complete and verified end to end against a running local Supabase stack.

Prompt 58's vision masking is deliberately client-side presentation, not a security boundary: the server already sends every campaign member the full live map (the Prompt 55 RLS posture, unchanged), and each player's own browser masks what their active character can't currently perceive. A technically-savvy player could inspect network traffic or app state and see everything — the project owner's explicit preference for a trusted friend group, chosen over server-side filtering on purpose.

Prompt 57 (map editor lighting authoring) needed no new implementation: its acceptance criteria — painting varied ambient light and saving/reloading it correctly, and marking a placed object as a light source or as line-of-sight-blocking — are exactly what Prompt 55 already built and verified (the roadmap's Prompt 55 acceptance criteria already required "ambient light... authored per cell" and a light source "attached to a fixed point or to a movable object/token", overlapping fully with Prompt 57's ask). Re-confirmed directly: `verify-vision-data-model.mjs`'s persistence checks plus a live-browser pass over the editor's light-paint tool, light-source placement (anchored to a placed object), and LOS toggle.

See [`Claude_Code_Prompts_BeyondDNDBeyond_2026-08-24.md`](./Claude_Code_Prompts_BeyondDNDBeyond_2026-08-24.md) for the full 62-prompt roadmap — sequential, self-contained build instructions covering everything from project scaffolding through combat mechanics, the vision system, and self-hosted deployment.

**Prompt 62 (self-hosted deployment packaging) is complete — the full 62-prompt roadmap is done.**
This last prompt is deployment/infra packaging rather than a new feature: a production `Dockerfile`
(multi-stage, `output: "standalone"`, non-root, `poppler-utils` installed in the runtime stage for
the PDF import feature), a `docker-compose.production.yml` that adds the app alongside the existing
self-hosted Supabase stack, and the "Production deployment" section below covering every environment
variable and Nginx Proxy Manager's WebSocket configuration for Realtime. See that section for exactly
what was verified end to end in a sandboxed environment (the image builds, and a full signup →
profile setup → Lobby flow works against a real, isolated, freshly-migrated Postgres through the
production container) versus what is necessarily left as documented guidance (the real NPM + public
domain reverse-proxy path — there's no live NPM instance or public domain to test against here).

**Void terrain (non-rectangular room shapes)** — the first post-roadmap addition, an organic
feature request rather than a numbered prompt. A third terrain type, `void`, joins
`normal`/`difficult` (migration `0039_void_terrain.sql` widens the `map_cells` CHECK): the DM
paints it with the same terrain brush as the other two, and a void cell has no floor at all —
it renders as genuinely absent (no floor block, no grid outline) for EVERY viewer including the
DM, always. This is deliberately NOT a vision/masking concept: void is unconditional map shape
("there is no floor here"), carved out of the rectangular grid without touching the grid-based
architecture — coordinates, movement, vision, and the renderer all still work on the same
`grid_width x grid_height` cell space; void cells simply exist as holes in it. The rules engine
prices entering a void cell at `Infinity` (so any path through one sums to `Infinity` — cleanly
"impassable" to every cost-based caller, and the drag/ruler readouts show `∞ ft`), and every
put-something-there gesture rejects with a clear no-floor message rather than a cost error:
token placement and drag-to-move/armed-move in the Game Room, plus object placement, transition
origins, and cell-anchored lights in the editor (nothing sits on a cell with no floor). The AI
area generator may also propose void cells (carving cave corridors is its natural use) but never
an object standing on one. Rejections are client-side guards in the same trusted-friend-group
posture as the Prompt 58 vision masking — clear messages, not a security boundary. Verified end
to end by `scripts/db/verify-void-terrain.mjs` (hybrid RLS + real-browser shape, reading the new
hidden `editor-surface-state`/`table-surface-state` render mirrors — the `vision-state`
precedent).

**Ground types (flat-color terrain dressing)** — another post-roadmap addition. A cell now
carries a SEPARATE, purely cosmetic `ground_type` (migration `0046_ground_types.sql`, CHECK-
constrained: `default`, `grass`, `rock`, `forest`, `dense_forest`, `path`, `sand`, `swamp`,
`stone`), painted with its own brush in the map editor alongside terrain/light. This is layered
ON TOP OF — never replacing — the existing mechanical `terrain_type`: a "forest" cell can
independently be normal or difficult terrain, since ground type only changes the flat color
`MapSurface` renders and never touches movement cost or void-ness. `default` (the sparse-
storage default) renders exactly as every cell did before this column existed; any real ground
type replaces the terrain-driven color pair with its own flat base/high pair, still lightened by
elevation the identical way. Deliberately flat colors only, per the confirmed decision — no
textures, materials, or decoration-object scattering. Chosen to leave room for a later "water"
ground type to extend the same CHECK, and to give the upcoming map-template pack real terrain
variety to paint with. Verified end to end by `scripts/db/verify-ground-types.mjs` (the
void-terrain script's hybrid RLS + real-browser shape, reading the same render mirrors, now
carrying a `groundByCell` map alongside `voidCells`).

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

**Optional — AI-assisted drafting (`ANTHROPIC_API_KEY`).** Everything above is self-hosted;
this is the **one deliberate exception**: the "Generate a draft" actions on the NPC roster
and lore-page editors call the external Anthropic API (Claude Haiku), and need an API key
from [platform.claude.com](https://platform.claude.com). Leave it unset and the app works
fully — those actions hide themselves with an explanation instead of erroring. The key is
read only by the server process (the `src/ai` module, called from a Route Handler) and is
never sent to or readable from the browser.

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

**Also requires poppler-utils** (for `pdftoppm`) — the D&D Beyond PDF character import feature
(`/campaigns/[id]/characters/import`) shells out to it to rasterize uploaded PDFs before OCR'ing
them. `pdfjs-dist` + `@napi-rs/canvas` was tried first but garbles this template's embedded
font; `pdftoppm` renders it correctly. Install via your distro's package manager (e.g.
`sudo pacman -S poppler`, `sudo apt install poppler-utils`) — confirm with `which pdftoppm`.
There's no Docker image for the Next.js app itself yet (only Supabase is containerized so
far), so this is a local/deployment host prerequisite rather than something baked into an
image manifest. OCR itself (`tesseract.js`) is pure WASM with no extra system dependency, and
its English trained-data file is vendored in-repo (under the import route's `tessdata/`
folder) so the feature works with no external network calls at runtime.

## Module boundaries

The app is split into six independently-testable modules under `src/`, each with its own
`README.md` and a single public entry point (`index.ts`) — other modules should only ever
import from that entry point, never reach into a module's internal files:

| Module | Responsibility |
|---|---|
| `ui-components` | Shared design-system components (buttons, panels, inputs, modals, badges), built on the design tokens and CanvasUI. |
| `scene-3d` | React Three Fiber scene code — the table, seating, avatars, live map rendering, tokens, vision masking. |
| `rules-engine` | Pure D&D 5e SRD game logic — no UI, no database dependency. Fully unit-testable in isolation. |
| `realtime` | Wraps Supabase Realtime channels/presence behind a typed event-bus. |
| `data-access` | The **only** module allowed to import `@supabase/supabase-js` directly — every other module goes through here for persistence. |
| `ai` | The **only** module allowed to import `@anthropic-ai/sdk` — server-side LLM text generation for AI-assisted drafting (the app's one non-self-hosted integration; optional, see `ANTHROPIC_API_KEY` above). |

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

Six checks, with budgets recorded in `perf-budgets.json` (tightened in Prompt 62 now that the app
is feature-complete, rather than left at Prompt 2's original near-empty-scaffold numbers):

```sh
yarn perf:bundle      # client JS bundle size vs. budget
yarn perf:render      # headless 3D frame-time benchmark (Playwright + Three.js) — Game Room scene
yarn perf:assets      # headless 3D frame-time benchmark — map with placed preset/custom assets
yarn perf:map-editor  # headless 3D frame-time benchmark — the map editor, fully populated
yarn perf:lighthouse  # Lighthouse performance/accessibility scores
yarn perf:realtime    # concurrent-client Supabase Realtime latency test
yarn perf:all         # run all six in sequence
```

`perf:bundle` and `perf:lighthouse` need a production build first (`yarn build`).
`perf:realtime` needs the Supabase stack running (see above). `perf:render`, `perf:assets`,
`perf:map-editor`, and `perf:lighthouse` share Playwright's Chromium install rather than
downloading Chrome twice.

**Prompt 62 results — production build, run on this machine (GPU-backed, confirmed via
`nvidia-smi`), compared against the original Prompt 2/17/19 near-empty-app baselines:**

| Check | Original baseline | Measured now (feature-complete app) | Budget | Verdict |
|---|---|---|---|---|
| Bundle size (shared chunks) | ~550 KB | **539.9 KB** | 1000 KB | Pass, not stale — see note below |
| 3D render — Game Room | 16.7ms (60fps, GPU) | **16.67ms (60fps)** | 33.3ms | Pass |
| 3D render — map assets | *(check added later)* | **16.66ms (60fps)** | 33.3ms | Pass |
| 3D render — map editor | *(check added later)* | **16.66ms (60fps)** | 33.3ms | Pass |
| Lighthouse performance | *(no baseline recorded)* | **94** | ≥80 (was ≥70) | Pass, budget tightened |
| Lighthouse accessibility | *(no baseline recorded)* | **94** | ≥85 (was ≥80) | Pass, budget tightened |
| Realtime load (10 clients) | ≤500ms avg latency | **not measured** | 500ms | Could not run — see note below |

Honest read of these numbers:

- **Bundle size is genuinely not stale**, and this isn't a case of quietly accepting a bad
  number — `perf:bundle` only sums the shared root/polyfill JS chunks every page loads (the
  React + Next.js runtime), not the app's actual page-specific code. Next.js code-splits the 3D
  scene, character sheet, map editor, etc. per route, so none of that shows up in this
  particular number regardless of how much of it exists. The 1000KB budget was left unchanged —
  today's number has ~2x headroom and there's nothing here to correct.
- **3D rendering is still a flat 60fps (16.6-16.7ms) across three different scenes** (the Game
  Room, a map with 24 placed objects, and the fully-populated map editor), all GPU-rendered on
  an RTX 4060 Ti in this environment — confirming the perf harness gets real hardware-backed
  numbers here rather than the ~60ms software-rendering fallback the original baseline note
  warned about on a GPU-less machine.
- **Lighthouse scores were re-baselined upward** (70→80 performance, 80→85 accessibility) —
  the original budget had no real baseline behind it (recorded when there was barely an app to
  score); today's 94/94 comfortably clears even the tightened numbers with 9-14 points of
  margin kept deliberately, not set to today's exact score.
- **`perf:realtime` could not be run in this sandbox** — it fails with
  `ERR_MODULE_NOT_FOUND` because Node v26.4.0's native TypeScript-stripping ESM loader in this
  environment requires an explicit file extension on `src/realtime/campaignChannel.ts`'s
  relative `./channel` import, which it evidently didn't in whatever Node version this script
  was last validated against. This is confirmed pre-existing and unrelated to Prompt 62 — no
  file this script touches was changed here, and it fails identically before and after this
  prompt's changes. The `realtimeLoad` budget in `perf-budgets.json` was deliberately left
  untouched rather than guessed at; re-run this check on a Node version where the script loads
  (or after adding the `.ts` extension to that one import) to get a real number.

## Database migrations

No Supabase CLI is available in this environment, so migrations are plain numbered `.sql`
files under `supabase/migrations/`, applied in order and tracked in a `_migrations` table —
re-running is a no-op for anything already applied, and running against a fresh database
applies everything from scratch.

```sh
node scripts/db/migrate.mjs           # apply any pending migrations
node scripts/db/verify-rls.mjs        # create two throwaway users and verify RLS boundaries
node scripts/db/verify-campaigns.mjs  # verify campaign creation + invite-code join end to end
node scripts/db/verify-conditions.mjs # verify combat condition RLS/RPC boundaries (Prompt 47)
node scripts/db/verify-dice-rolls.mjs # verify the roll route, resolve_attack_damage, initiative (Prompt 48)
node scripts/db/verify-dice-ui.mjs    # verify the dice log panel, sheet rolls, live sync in a real browser (Prompt 48)
node scripts/db/verify-death-saves.mjs # verify death saves, instant death, the at-0-HP damage rules (Prompt 49)
node scripts/db/verify-concentration.mjs # verify concentration: damage-triggered CON saves, drop-to-0/condition breaks (Prompt 50)
node scripts/db/verify-quick-actions.mjs # verify the quick-actions panel: range-with-movement, slot gating, one-click rolls in a real browser (Prompt 51)
node scripts/db/verify-action-overrides.mjs # verify DM rule overrides: flag/approve/deny RLS, single-use consumption, live verdicts in a real browser (Prompt 52)
node scripts/db/verify-action-economy.mjs # verify action economy: per-turn resets, Strict attack/movement gating, the Freeform toggle live in a real browser (Prompt 53)
node scripts/db/verify-opportunity-attacks.mjs # verify opportunity attacks: leaving-reach detection, Disengage, take/decline RLS, live prompts in a real browser (Prompt 54)
node scripts/db/verify-vision-data-model.mjs # verify the vision data model: darkvision from race data, per-cell light levels, three-way light-source anchors, private seen-cells RLS (Prompt 55)
node scripts/db/verify-vision-rendering.mjs # verify per-player vision rendering: DM never masked, most-recent-token resolution, live re-masking on moves/carried lights/blinding, remembered seen-cells (Prompt 58)
node scripts/db/verify-vision-advantage.mjs # verify vision-driven advantage/disadvantage on attack rolls: auto-disadvantage on an unperceived target, condition-flag advantage/disadvantage, SRD cancellation to a flat roll with both reasons stated, graceful no-map/no-token fallback (Prompt 59)
node scripts/db/verify-hide-stealth.mjs # verify Hide/Stealth: per-observer passive-Perception resolution (NPC default 10), perception-eligibility skips, replace-not-accumulate, hidden-token rendering live in a real browser, reveal-on-attack with "attacking from hiding" advantage, manual reveal, hider-side RLS (Prompt 60)
node scripts/db/verify-npc-stat-blocks.mjs # verify DM monster stat blocks: DM-only CRUD, quick-add before/mid-combat via add_combatant into the canonical turn order, stored-bonus/damage attacks through the roll route with the full death-save/instant-death/concentration bookkeeping, Strict economy gating, NPC HP clamps, stat-block AC auto-fill in a real browser, real passive Perception in Hide resolution (Prompt 61)
node scripts/db/verify-character-edit.mjs # verify sheet-side race/class/level/speed editing: owner and DM edits persist through a real browser, a race change re-derives speed/darkvision in one call, imported characters are editable identically, class edits leave resources/spells untouched, non-owner RLS still holds
node scripts/db/verify-void-terrain.mjs # verify void terrain: the editor's Void brush persisting through Save, paint authorization, the widened CHECK (0039), no-floor rendering in both the editor preview and the live table, clear placement/drag-to-move rejections, a normal move unaffected (post-roadmap: non-rectangular room shapes)
node scripts/db/verify-ground-types.mjs # verify ground types: the CHECK constraint (0046), paint authorization, independence from terrain_type, the editor's Ground brush persisting through Save, live rendering on both the editor preview and the live table, an untouched map's rendering unchanged (post-roadmap: flat-color ground types)
```

The first two connect through Supavisor (the pooler Docker Compose exposes on `localhost:5432`)
using the tenant-qualified username `postgres.$POOLER_TENANT_ID` — plain `postgres` fails with
"no tenant identifier provided" against a pooled connection. `verify-conditions.mjs`,
`verify-dice-rolls.mjs`, `verify-death-saves.mjs`, `verify-concentration.mjs`,
`verify-vision-data-model.mjs`, `verify-vision-advantage.mjs`, `verify-hide-stealth.mjs`,
and `verify-npc-stat-blocks.mjs`
instead go
through `@supabase/supabase-js` (service-role client for setup, real signed-in clients for the
actual RLS/RPC checks) — equally valid for exercising policies end to end, and closer to how
the app itself talks to Supabase; the dice-rolls/death-saves/concentration/vision-advantage/
hide-stealth/npc-stat-blocks
scripts also drive the roll Route Handler over real
HTTP with signed-in session cookies (needs `yarn dev` running — `verify-concentration.mjs`,
`verify-vision-advantage.mjs`, `verify-hide-stealth.mjs`, and `verify-npc-stat-blocks.mjs`
start one themselves, polling `/api/health`, if `:3000` isn't already serving).
`verify-dice-ui.mjs`, `verify-quick-actions.mjs`, `verify-action-overrides.mjs`,
`verify-action-economy.mjs`, `verify-opportunity-attacks.mjs`,
`verify-vision-rendering.mjs`, `verify-hide-stealth.mjs`,
`verify-npc-stat-blocks.mjs`, `verify-void-terrain.mjs`, and `verify-ground-types.mjs` go one
step further and drive real Playwright browsers against the dev server, for the parts only a live UI can
exercise (the sheet's advantage toggle, the combat panel's Roll-initiative buttons, live
sync landing in an actually-open Game Room, the quick-actions panel's
surfacing/one-click-fire behavior, the flag → DM-approve → use-anyway override cycle, the
action-economy readout's manual marks and live mode flips, the opportunity-attack
prompt's live landing and take/decline flow, per-player vision masking recomputing
live in an open room, a hidden token vanishing from one specific observer's open room
the moment its hidden-from row lands, and the attack form's stat-block AC auto-fill in
both a DM's and a player's room — the latter seven scripts also start
`yarn dev` themselves if needed, like `verify-concentration.mjs`).
`verify-character-edit.mjs` follows the same hybrid shape — service-role client for setup,
signed-in supabase-js clients for the RLS checks, a Playwright browser for the sheet's
race/class/level/speed editing controls — and likewise starts `yarn dev` itself if `:3000`
isn't already serving.

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

## Production deployment

Everything above is local development (`yarn dev` against the Compose Supabase stack). This
section is for running the app itself as a container, alongside that same self-hosted Supabase
stack, behind an existing Nginx Proxy Manager (NPM) instance — the deployment shape this project
has targeted from the start (see "Stack" above).

**What's verified end to end in this repo's own sandboxed build environment, and what
necessarily isn't:** the `Dockerfile` builds successfully; a container from that image starts,
passes its healthcheck, and correctly serves `/api/health`, `/login`, `/signup`, and the
authenticated Lobby; a full signup → profile setup → Lobby flow was driven through the
production container against a real, freshly-migrated, isolated Postgres/Supabase stack (separate
ports and container names from this sandbox's own local-dev stack, so neither was disturbed),
confirming the container genuinely talks to Postgres, Auth, and Realtime correctly (the Lobby's
live "N adventurers online" presence came back correctly). What is **not** verified — because
there is no live Nginx Proxy Manager instance or public domain in this environment to test
against — is the actual reverse-proxied path: NPM routing a real domain to this container and to
Supabase, TLS termination, and the WebSocket upgrade for Realtime working through that proxy in
practice. The guidance below for that part is exactly that: guidance, written from how NPM and
Supabase Realtime are documented to behave, for you to apply and confirm against your own
infrastructure.

### Building the image

```sh
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://supabase.example.com \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<your production ANON_KEY> \
  -t beyonddndbeyond-app:latest .
```

The `Dockerfile` is a three-stage build (`deps` → `builder` → `runner`) on `node:22-bookworm-slim`,
producing Next.js's `output: "standalone"` server (see `next.config.ts`) rather than shipping the
full repo + `node_modules` into the runtime image. The runtime stage installs `poppler-utils` —
**not** just the builder stage — because the D&D Beyond PDF import route shells out to `pdftoppm`
at request time, on every upload, in whatever container is actually serving traffic (see the
existing "Also requires poppler-utils" note above; this is the containerized version of that same
requirement). The image runs as a non-root user and copies `public/`, `.next/static/`, and (for
the OCR step's vendored `tessdata` language file, resolved at request time relative to
`process.cwd()`, not a static import Next's build tracer would pick up) the whole `src/` tree
alongside the standalone server, matching what `output: "standalone"` does *not* include by
itself.

**The two `NEXT_PUBLIC_*` build args above are build-time, not run-time, and this matters a lot in
practice.** Next.js inlines every `NEXT_PUBLIC_`-prefixed environment variable into the compiled
JavaScript at `next build` time — not just in the code the browser downloads, but *everywhere* in
this app, because `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` are also read by
this app's own server-side code (`src/data-access/supabase-server.ts`,
`src/data-access/supabase-middleware.ts`, the `/api/health` route). Setting
`NEXT_PUBLIC_SUPABASE_URL` via `docker run -e` or a Compose `environment:` block **has no effect**
on an already-built image — the browser already has the old value baked into a static `.js` file,
and so does every server-side reference in that same image. Rotating the anon key or moving to a
new domain means rebuilding the image with new `--build-arg` values, not restarting the container.
Every other credential (`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`) is read from
`process.env` at request time as normal and *can* be changed with just a container restart — see
the table below for which is which.

**What value should `NEXT_PUBLIC_SUPABASE_URL` actually be?** The **public** URL the browser
reaches Supabase through — e.g. `https://supabase.example.com`, proxied by NPM — not an internal
Docker Compose service name like `http://api-gw:8000`. That's the address a browser on the
internet can resolve; `api-gw` only resolves inside the Compose network. The direct consequence,
worth knowing rather than being surprised by: because this app currently uses that *same* single
env var for its own server-side Supabase calls too (there's no separate internal-only URL for
server-to-server traffic), this container's outbound requests to Supabase will also go out
through the public domain and back in through your reverse proxy, rather than staying inside the
Compose network — a real round trip over the internet for what's otherwise local traffic. That's
a known characteristic of this app's current design, not something this prompt's Docker
packaging papers over or fixes (the source change here is deliberately scoped to
`next.config.ts` only) — if the extra latency/reliability cost ever matters, the fix would be
adding a second, server-only URL env var and a second code path, which is a real but separate
follow-up, not part of this deployment packaging.

### Running it — `docker-compose.production.yml`

This adds an `app` service to the *existing* Supabase stack rather than replacing or
restructuring it — see the usage comment block at the top of `docker-compose.production.yml`
for the exact command, reproduced here:

```sh
docker compose \
  --env-file supabase/.env --env-file .env \
  -f supabase/docker-compose.yml -f docker-compose.production.yml \
  --project-directory supabase \
  up -d
```

`--project-directory supabase` matters: `supabase/docker-compose.yml` has many `./volumes/...`
relative paths that need to resolve against the `supabase/` directory exactly as they already do
today, and pinning the project directory there (rather than the repo root, which is where this
second compose file lives) keeps that true when the two files are layered together. Build the
image first (above) — `docker-compose.production.yml` references it by tag rather than building
in place, specifically to avoid `build.context` paths becoming confusing once the project
directory is pinned to `supabase/` for the other file's sake.

The `app` service depends on `api-gw` being healthy (mirroring the existing `functions` service's
own dependency), has its own healthcheck (`/api/health`, via Node's built-in `fetch` — the same
pattern `supabase-studio`'s healthcheck already uses, since this slim runtime image has no
curl/wget installed), and by default publishes port 3000 bound to `127.0.0.1` only — it's meant to
sit behind NPM, not be reachable directly from the internet. If NPM runs on a different host,
either bind a specific private/VPN interface instead of `127.0.0.1` (`APP_HOST_PORT_BINDING` env
var), or put both on a shared external Docker network instead of publishing a host port at all.

**Postgres data persistence** is already handled by the existing `supabase/docker-compose.yml` —
its `db` service bind-mounts `./volumes/db/data` to `/var/lib/postgresql/data`, so data survives
`docker compose down` (without `-v`) and container recreation exactly as it does for local
development today. This production Compose file doesn't add, change, or duplicate any of that —
see `supabase/docker-compose.yml`'s own volumes for the authoritative list (`db-config`,
`deno-cache`, plus the bind-mounted `./volumes/...` paths).

### Environment variables

Copy `.env.example` to `.env` as for local development, but **generate real production secrets —
never reuse the values from local development.** The same applies to everything in
`supabase/.env`: run `sh supabase/utils/generate-keys.sh --update-env` against a fresh
`supabase/.env.example` copy for a production deployment rather than copying across the
dev secrets this repo's own local setup uses.

| Variable | Where it's read | When it takes effect | Required? |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Browser bundle **and** this app's server-side code | **Build time only** — `docker build --build-arg` | Yes — the public URL Supabase is reachable at through NPM |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser bundle **and** this app's server-side code | **Build time only** — `docker build --build-arg` | Yes — from `supabase/.env`'s `ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEY` if you've migrated to the newer opaque keys) |
| `SUPABASE_SERVICE_ROLE_KEY` | Reserved for server-side use; not currently called by any app code path, but documented since the app's own `.env.example` asks for it | Run time — container restart is enough | From `supabase/.env`'s `SERVICE_ROLE_KEY` |
| `ANTHROPIC_API_KEY` | `src/ai` (server-only, never sent to the browser) | Run time — container restart is enough | **No** — the app's one deliberate non-self-hosted dependency. Leave unset and the "Generate a draft" AI-assisted actions hide themselves with an explanation instead of erroring |
| `APP_IMAGE` / `APP_IMAGE_TAG` | `docker-compose.production.yml` only | Compose `up` time | No — defaults to `beyonddndbeyond-app:latest` |
| `APP_HOST_PORT_BINDING` | `docker-compose.production.yml` only | Compose `up` time | No — defaults to `127.0.0.1:3000`, see above |

Everything Supabase-side (`POSTGRES_PASSWORD`, `JWT_SECRET`, `DASHBOARD_PASSWORD`, etc.) is exactly
what's already documented for local development — see "Local development" above and
`supabase/.env.example` — just with freshly generated production values instead of the checked-in
development ones.

### Nginx Proxy Manager configuration

This is configuration guidance for your own existing NPM instance — as noted above, there's no
live NPM instance or public domain in this sandboxed environment to verify the reverse-proxied
path against end to end. What follows is accurate to how NPM and self-hosted Supabase Realtime
are documented to behave; treat it as a checklist to apply and confirm against your own setup,
not as something already proven to work here.

**Two separate proxy hosts, two separate internal ports** — this app and Supabase's gateway are
different services on different ports, and (per the two-URL point above) the browser needs to
reach both directly:

1. **The app itself** — proxy host `beyonddndbeyond.example.com` (or whatever domain you choose)
   → `<docker-host>:3000` (the port `docker-compose.production.yml` publishes, or the app
   container's address directly if NPM shares its Docker network). Plain HTTP forwarding, no
   WebSocket traffic originates from this app's own routes.
2. **Supabase's API gateway** — proxy host `supabase.example.com` → `<docker-host>:8000` (or
   whatever `API_GW_HTTP_PORT` you've set in `supabase/.env`). This is the domain
   `NEXT_PUBLIC_SUPABASE_URL` must be built with (see above) — the browser talks to Auth, REST,
   Storage, **and Realtime** all through this one gateway, matching exactly how the app already
   reaches Supabase locally via `NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000` today, just with
   a real domain instead of `localhost`.

**The Realtime WebSocket upgrade — the specific gotcha the acceptance criteria for this prompt
calls out.** Supabase Realtime (used by the campaign channel, presence, live map/token sync — see
the "Module boundaries" table's `realtime` entry) is a long-lived WebSocket connection proxied
through the same gateway as the REST API. If NPM doesn't forward the WebSocket upgrade correctly,
Realtime connections will fail or silently fall back to a broken/reconnect-looping state even
though plain HTTP requests to the same domain work fine — this is a well-known self-hosted
Supabase failure mode, not something specific to this app. Concretely, on the `supabase.example.com`
proxy host in NPM:

- Under the **Details** tab, enable the **"Websockets Support"** toggle. This is NPM's UI switch
  for adding the `Upgrade`/`Connection` header forwarding a WebSocket handshake needs — without
  it, NPM's underlying nginx config won't proxy the `Connection: Upgrade` handshake through at
  all.
- If you ever hand-edit NPM's generated nginx config (its "Custom Nginx Configuration" box) rather
  than relying on the toggle, the underlying directives it needs are:
  ```nginx
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  ```
  (NPM sets `proxy_set_header Upgrade $http_upgrade;` and a conditional `Connection` header
  itself when the toggle is on — hand-adding these on top of an already-toggled-on host is
  redundant, not harmful, but don't add them *instead of* the toggle on a host managed through
  NPM's UI, since NPM will regenerate its config from the UI state and may not merge custom
  additions the way you expect.)
- Make sure whatever sits in front of NPM itself (a router port-forward, another proxy, a CDN) also
  passes the `Upgrade`/`Connection` headers through unmodified — any hop in the chain that strips
  them breaks the same way NPM without the toggle does.
- Confirm it worked by opening the Lobby (or any campaign room) through the real domain and
  checking your browser's Network tab for a `101 Switching Protocols` response on the
  `realtime/v1/websocket` request, rather than it hanging, erroring, or falling back to
  repeated failed reconnect attempts.

TLS termination, redirecting `http://` to `https://`, and certificate management are standard NPM
proxy-host configuration unrelated to anything specific to this app — the one thing worth calling
out is that `NEXT_PUBLIC_SUPABASE_URL` and `SITE_URL`/`API_EXTERNAL_URL` (in `supabase/.env`)
should all use `https://` once TLS is in place, matching whatever your NPM proxy hosts actually
serve.
