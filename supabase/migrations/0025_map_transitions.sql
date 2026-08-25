-- Prompt 42: map transitions — a DM-authored link from a cell on one map to
-- an entry cell on another (stairs, ladders, portals). Directional by
-- design: a two-way staircase is two rows, authored separately, because the
-- reverse trip's entry point is its own placement decision.

create table if not exists public.map_transitions (
  id uuid primary key default gen_random_uuid(),
  from_map_id uuid not null references public.campaign_maps (id) on delete cascade,
  from_x integer not null,
  from_y integer not null,
  to_map_id uuid not null references public.campaign_maps (id) on delete cascade,
  to_x integer not null,
  to_y integer not null,
  created_at timestamptz not null default now(),
  -- One outgoing transition per origin cell — a cell can never be ambiguous
  -- about where it leads.
  constraint map_transitions_one_per_origin_cell unique (from_map_id, from_x, from_y)
);

alter table public.map_transitions enable row level security;

-- DM-only for BOTH read and write, mirroring map_folders (0023) rather than
-- the member-sees-live-map carve-out: the transition prompt is DM-facing
-- only (the DM decides whether the party goes through), so a player never
-- needs to read transition metadata at all.
--
-- Every policy checks can_write_map on BOTH sides, same reasoning as
-- lore_page_links (0020): checking only from_map_id would let a DM point a
-- transition at a map in a campaign they don't control, since nothing else
-- re-validates to_map_id's ownership.

create policy "the DM can read transitions between their campaign's maps"
  on public.map_transitions for select
  to authenticated
  using (public.can_write_map(from_map_id) and public.can_write_map(to_map_id));

create policy "the DM can link two of their campaign's maps"
  on public.map_transitions for insert
  to authenticated
  with check (public.can_write_map(from_map_id) and public.can_write_map(to_map_id));

create policy "the DM can retarget a transition between their campaign's maps"
  on public.map_transitions for update
  to authenticated
  using (public.can_write_map(from_map_id) and public.can_write_map(to_map_id))
  with check (public.can_write_map(from_map_id) and public.can_write_map(to_map_id));

create policy "the DM can remove a transition between their campaign's maps"
  on public.map_transitions for delete
  to authenticated
  using (public.can_write_map(from_map_id) and public.can_write_map(to_map_id));
