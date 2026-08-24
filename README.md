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

Implementation is underway, prompt by prompt, so the app can be reviewed and adjusted as it forms rather than built all at once. Prompt 1 (project scaffolding) is in progress — Next.js, module folders, and the self-hosted Supabase Docker Compose config are in place; bringing the stack up is currently blocked locally on Docker permissions (see below).

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
(`docker compose ps` to check container status).

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

The app is served at [http://localhost:3000](http://localhost:3000). A health check confirming
the app can reach Supabase is available at
[http://localhost:3000/api/health](http://localhost:3000/api/health).

**Requires:** the user running Docker commands must be able to access the Docker daemon (in
the `docker` group, or run via `sudo`) — `sudo usermod -aG docker $USER` and re-login if you
hit a permission-denied error against `/var/run/docker.sock`.
