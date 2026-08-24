-- Prompt 23: map and asset data model. RLS policies land in 0015, after
-- every table referenced here exists (same reason as 0002/0003 -> 0004 and
-- 0007 -> 0008).

create table if not exists public.campaign_maps (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  name text not null,
  grid_width integer not null check (grid_width > 0),
  grid_height integer not null check (grid_height > 0),
  created_at timestamptz not null default now()
);

alter table public.campaign_maps enable row level security;

-- Keyed by (map, x, y) directly rather than a surrogate id — a cell's
-- identity IS its coordinate, and this makes "exactly one row per cell"
-- structural instead of an app-level invariant to maintain.
create table if not exists public.map_cells (
  map_id uuid not null references public.campaign_maps (id) on delete cascade,
  x integer not null,
  y integer not null,
  -- A count of discrete steps, not feet — matches the "discrete stepped
  -- elevation levels" grid movement design; feet-per-level is a rendering/
  -- rules concern for a later prompt, not stored here.
  elevation integer not null default 0,
  -- Matches rules-engine's TerrainType (src/rules-engine/movement.ts)
  -- exactly, so map data and movement-cost calculation share one
  -- vocabulary instead of needing a translation layer between them.
  terrain_type text not null default 'normal' check (terrain_type in ('normal', 'difficult')),
  primary key (map_id, x, y)
);

alter table public.map_cells enable row level security;

-- source_type/campaign_id mirrors profiles.avatar_source/avatar_ref's
-- preset-vs-custom split (0010) — same two-value vocabulary, same paired
-- CHECK approach to keep them from drifting apart: a preset is global
-- (no campaign_id), a custom asset belongs to exactly one campaign.
create table if not exists public.asset_library (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source_type text not null check (source_type in ('preset', 'custom')),
  model_ref text not null,
  campaign_id uuid references public.campaigns (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint asset_library_scope_matches_source check (
    (source_type = 'preset' and campaign_id is null)
    or (source_type = 'custom' and campaign_id is not null)
  )
);

alter table public.asset_library enable row level security;

create table if not exists public.map_objects (
  id uuid primary key default gen_random_uuid(),
  map_id uuid not null references public.campaign_maps (id) on delete cascade,
  -- restrict, not cascade: deleting an asset that's currently placed on a
  -- map should be an explicit, deliberate action (not built by this
  -- prompt), not a silent side effect of removing the asset elsewhere.
  asset_id uuid not null references public.asset_library (id) on delete restrict,
  x integer not null,
  y integer not null,
  elevation integer not null default 0,
  rotation real not null default 0,
  -- Interactive-behavior config (POIs, triggers) is a later prompt's
  -- concern — this column exists now so that prompt doesn't need a schema
  -- migration of its own just to add a place to store it.
  behavior_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.map_objects enable row level security;

-- Nullable, set once a DM selects a live map (Prompt 29). Persisted here
-- (not just broadcast over Realtime) so a reconnecting or newly-joining
-- client can recover the correct live map from the database instead of
-- guessing or waiting for another broadcast that already happened.
-- set null (not cascade) on the referenced map's deletion: removing a map
-- should not delete the campaign it belongs to, just clear the reference.
alter table public.campaigns
  add column if not exists live_map uuid references public.campaign_maps (id) on delete set null;
