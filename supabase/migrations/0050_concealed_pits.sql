-- Pits and falling (docs/design/pits-and-falling.md §5) — concealed pits.
--
-- A concealed pit's public map_cells row must look like ordinary floor
-- (whatever terrain the DM painted it as) for as long as it stays hidden,
-- because map_cells is member-readable (0015) — unlike map_transitions,
-- which is DM-only precisely so players can never read a DM's secret link.
-- So the trap's real nature (its true bottom elevation, in the same step
-- units every other elevation column uses) lives here instead, in a table
-- shaped and secured exactly like map_transitions (0025): DM-only in both
-- directions, so a player's client never learns this table exists.
--
-- On a failed save the DM's own move-handling code reveals the trap by
-- writing map_cells.terrain_type = 'pit' / elevation = bottom_elevation_steps
-- and deleting this row — after which it's indistinguishable from an
-- ordinarily-painted visible pit. A successful save never touches this row
-- at all: the trap stays concealed and can catch the next unlucky mover too.
create table if not exists public.concealed_pits (
  map_id uuid not null references public.campaign_maps (id) on delete cascade,
  x integer not null,
  y integer not null,
  bottom_elevation_steps integer not null,
  -- A per-trap override column, left available at the data layer now so a
  -- later prompt can expose DM configuration without a redesign — v1 always
  -- writes (and the app only ever reads) the SRD default of 15.
  save_dc integer not null default 15,
  primary key (map_id, x, y)
);

alter table public.concealed_pits enable row level security;

-- DM-only for BOTH read and write — map_transitions' exact policy shape,
-- checked against can_write_map(map_id) alone (there is only ever one map
-- involved here, unlike map_transitions' from/to pair). drop-if-exists first
-- so this migration is safe to re-apply under a renumbered filename after
-- already landing once against the shared dev database under its original
-- number (see 0048's identical fix).

drop policy if exists "the DM can read their campaign's concealed pits" on public.concealed_pits;
drop policy if exists "the DM can hide a pit on their campaign's map" on public.concealed_pits;
drop policy if exists "the DM can update a concealed pit on their campaign's map" on public.concealed_pits;
drop policy if exists "the DM can remove a concealed pit from their campaign's map" on public.concealed_pits;

create policy "the DM can read their campaign's concealed pits"
  on public.concealed_pits for select
  to authenticated
  using (public.can_write_map(map_id));

create policy "the DM can hide a pit on their campaign's map"
  on public.concealed_pits for insert
  to authenticated
  with check (public.can_write_map(map_id));

create policy "the DM can update a concealed pit on their campaign's map"
  on public.concealed_pits for update
  to authenticated
  using (public.can_write_map(map_id))
  with check (public.can_write_map(map_id));

create policy "the DM can remove a concealed pit from their campaign's map"
  on public.concealed_pits for delete
  to authenticated
  using (public.can_write_map(map_id));
