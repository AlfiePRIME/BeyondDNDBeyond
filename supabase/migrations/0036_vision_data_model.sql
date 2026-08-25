-- Prompt 55: vision — character vision capability and the map lighting data
-- model. Schema and authoring storage ONLY: nothing in this migration (or
-- this prompt) computes what anyone can see — the perception/vision engine
-- that reads all of this is Prompt 56's job, and the two deliberately-inert
-- pieces below (blocks_line_of_sight, map_seen_cells) wait for even later
-- prompts, laid down now so those upgrades are additive rather than reworks.

-- Character vision capability: null means normal vision only; a number is
-- the darkvision range in feet. Initialized at character creation from the
-- chosen race/subrace's darkvisionFeet (the static SRD catalog in
-- src/rules-engine/srd/races.ts) by the creation UI — caller-supplied like
-- speed and the ability scores, not re-derived by the DB — and thereafter a
-- plain stored, adjustable stat (0008's owner-or-DM UPDATE policy), since a
-- character can gain darkvision from sources the catalog doesn't model.
alter table public.characters
  add column if not exists darkvision_feet integer;

-- Ambient light per cell — the exact terrain_type convention (same table,
-- same default-means-no-row sparse storage, same authoring brush in the map
-- editor, same CHECK-constrained text vocabulary).
alter table public.map_cells
  add column if not exists light_level text not null default 'bright'
    check (light_level in ('bright', 'dim', 'dark'));

-- INERT: no code reads this column yet, by design. It marks whether the
-- placed object blocks line of sight, authorable by the DM now so existing
-- maps accumulate the data, but nothing branches on its value until a
-- future full-line-of-sight prompt (post-56) reads it — the project owner's
-- explicitly planned additive upgrade.
alter table public.map_objects
  add column if not exists blocks_line_of_sight boolean not null default false;

-- A light source on a map: a radius and brightness anchored to exactly one
-- of a fixed grid position, a placed object, or a token — so a torch can
-- sit in a wall sconce (fixed), on a brazier prop (object, moves with it),
-- or in a character's hand (token, moves with them).
create table if not exists public.light_sources (
  id uuid primary key default gen_random_uuid(),
  map_id uuid not null references public.campaign_maps (id) on delete cascade,
  radius_feet integer not null check (radius_feet > 0),
  brightness text not null check (brightness in ('bright', 'dim')),
  x integer,
  y integer,
  object_id uuid references public.map_objects (id) on delete cascade,
  token_id uuid references public.map_tokens (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- The map_tokens character_id/npc_name XOR pattern (0019), three-way: a
  -- light is anchored to a fixed cell, OR an object, OR a token — never
  -- more than one, never none.
  constraint light_sources_exactly_one_anchor check (
    (x is not null and y is not null and object_id is null and token_id is null)
    or (x is null and y is null and object_id is not null and token_id is null)
    or (x is null and y is null and object_id is null and token_id is not null)
  )
);

alter table public.light_sources enable row level security;

-- light_sources policies: the exact map_cells/map_objects shape from 0015 —
-- members read whatever the live map shows (can_read_map), only the DM
-- authors (can_write_map). Lighting is table-visible authored map state,
-- same as terrain.

create policy "read a light source iff its map is readable"
  on public.light_sources for select
  to authenticated
  using (public.can_read_map(map_id));

create policy "write a light source iff its map is writable"
  on public.light_sources for insert
  to authenticated
  with check (public.can_write_map(map_id));

create policy "update a light source iff its map is writable"
  on public.light_sources for update
  to authenticated
  using (public.can_write_map(map_id))
  with check (public.can_write_map(map_id));

create policy "delete a light source iff its map is writable"
  on public.light_sources for delete
  to authenticated
  using (public.can_write_map(map_id));

-- Per-player seen-cells memory: what THIS player's last perception of a
-- cell looked like, captured so a future fog-of-war prompt can redraw
-- previously-explored terrain from memory once it's no longer currently
-- visible. Currently UNREAD by any rendering — schema plus thin CRUD only.
-- The snapshot is cell-level state (terrain/elevation/light) deliberately
-- WITHOUT object-level memory: what placed objects a player remembers is
-- part of the rendering behavior a later prompt designs, not this schema's
-- job to anticipate. Snapshot columns carry no CHECKs or FKs to the live
-- vocabulary on purpose — they are a captured copy, not live state.
create table if not exists public.map_seen_cells (
  id uuid primary key default gen_random_uuid(),
  map_id uuid not null references public.campaign_maps (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  x integer not null,
  y integer not null,
  terrain_type text not null,
  elevation integer not null,
  light_level text not null,
  seen_at timestamptz not null default now(),
  -- Re-seeing a cell updates the one existing memory row (upsert target),
  -- never duplicates it. Its backing index's leading columns are also
  -- exactly the (map_id, user_id) lookup a future prompt's "load my memory
  -- of this map" read needs — no separate index required.
  unique (map_id, user_id, x, y)
);

alter table public.map_seen_cells enable row level security;

-- map_seen_cells policies reference the map's campaign membership, which a
-- plain policy subquery can't read for a non-live map (campaign_maps' own
-- SELECT policy would hide it) — the 0015 SECURITY DEFINER reasoning.
create or replace function public.is_map_campaign_member(p_map_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.campaign_maps m
    where m.id = p_map_id
      and public.is_campaign_member(m.campaign_id)
  );
$$;

-- map_seen_cells policies: a DELIBERATE exception to this build's usual
-- "every member sees the table's state" transparency posture (roll_log,
-- conditions, opportunity_attacks). A seen-cells row is a private record of
-- what one player has personally explored — letting another player read it
-- would leak exactly the information the future fog-of-war exists to hide.
-- So: own rows only (user_id = auth.uid()), for maps in campaigns the
-- caller belongs to. Membership, not can_read_map's live-map gate, on
-- purpose: memory of a previously-live map must survive (and be writable
-- against) the DM switching the live map away. No DELETE policy — a player
-- doesn't un-remember; clearing exploration state is a future DM concern.

create policy "a member reads only their own seen cells"
  on public.map_seen_cells for select
  to authenticated
  using (user_id = auth.uid() and public.is_map_campaign_member(map_id));

create policy "a member records only their own seen cells"
  on public.map_seen_cells for insert
  to authenticated
  with check (user_id = auth.uid() and public.is_map_campaign_member(map_id));

create policy "a member updates only their own seen cells"
  on public.map_seen_cells for update
  to authenticated
  using (user_id = auth.uid() and public.is_map_campaign_member(map_id))
  with check (user_id = auth.uid() and public.is_map_campaign_member(map_id));
