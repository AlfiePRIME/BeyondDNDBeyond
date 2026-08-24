-- Prompt 23: RLS for maps and assets. A campaign's DM can read/write every
-- map in it; other members can only read whichever map is currently
-- referenced by campaigns.live_map; non-members see nothing (is_campaign_dm
-- and is_campaign_member from 0008/0004 already fail closed for them).

-- map_cells and map_objects reference a map, not a campaign, directly —
-- these two SECURITY DEFINER helpers (same reasoning as is_campaign_dm
-- etc.: they run inside other tables' policies, so they can't themselves be
-- subject to campaign_maps' own RLS) centralize the "DM, or member viewing
-- the live map" check once instead of repeating the join in every policy.
create or replace function public.can_read_map(p_map_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.campaign_maps m
    join public.campaigns c on c.id = m.campaign_id
    where m.id = p_map_id
      and (
        public.is_campaign_dm(m.campaign_id)
        or (public.is_campaign_member(m.campaign_id) and c.live_map = m.id)
      )
  );
$$;

create or replace function public.can_write_map(p_map_id uuid)
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
      and public.is_campaign_dm(m.campaign_id)
  );
$$;

-- campaign_maps policies

create policy "DM reads every map in their campaign, others only the live map"
  on public.campaign_maps for select
  to authenticated
  using (
    public.is_campaign_dm(campaign_id)
    or (
      public.is_campaign_member(campaign_id)
      and exists (
        select 1 from public.campaigns c
        where c.id = campaign_maps.campaign_id and c.live_map = campaign_maps.id
      )
    )
  );

create policy "DM creates maps in their campaign"
  on public.campaign_maps for insert
  to authenticated
  with check (public.is_campaign_dm(campaign_id));

create policy "DM updates maps in their campaign"
  on public.campaign_maps for update
  to authenticated
  using (public.is_campaign_dm(campaign_id))
  with check (public.is_campaign_dm(campaign_id));

create policy "DM deletes maps in their campaign"
  on public.campaign_maps for delete
  to authenticated
  using (public.is_campaign_dm(campaign_id));

-- map_cells policies

create policy "read a cell iff its map is readable"
  on public.map_cells for select
  to authenticated
  using (public.can_read_map(map_id));

create policy "write a cell iff its map is writable"
  on public.map_cells for insert
  to authenticated
  with check (public.can_write_map(map_id));

create policy "update a cell iff its map is writable"
  on public.map_cells for update
  to authenticated
  using (public.can_write_map(map_id))
  with check (public.can_write_map(map_id));

create policy "delete a cell iff its map is writable"
  on public.map_cells for delete
  to authenticated
  using (public.can_write_map(map_id));

-- map_objects policies (same shape as map_cells)

create policy "read an object iff its map is readable"
  on public.map_objects for select
  to authenticated
  using (public.can_read_map(map_id));

create policy "write an object iff its map is writable"
  on public.map_objects for insert
  to authenticated
  with check (public.can_write_map(map_id));

create policy "update an object iff its map is writable"
  on public.map_objects for update
  to authenticated
  using (public.can_write_map(map_id))
  with check (public.can_write_map(map_id));

create policy "delete an object iff its map is writable"
  on public.map_objects for delete
  to authenticated
  using (public.can_write_map(map_id));

-- asset_library policies: presets are global-readable; custom assets are
-- readable by members of their owning campaign. Writes are DM-only, and the
-- insert check requires campaign_id to be set — so a regular user cannot
-- create a preset (campaign_id null) through RLS at all; presets are
-- seeded data, not something the app lets any DM create.

create policy "presets are readable by any authenticated user"
  on public.asset_library for select
  to authenticated
  using (source_type = 'preset');

create policy "custom assets are readable by their campaign's members"
  on public.asset_library for select
  to authenticated
  using (source_type = 'custom' and public.is_campaign_member(campaign_id));

create policy "a DM can add a custom asset to their campaign"
  on public.asset_library for insert
  to authenticated
  with check (
    source_type = 'custom'
    and campaign_id is not null
    and public.is_campaign_dm(campaign_id)
  );

create policy "a DM can update their campaign's custom assets"
  on public.asset_library for update
  to authenticated
  using (source_type = 'custom' and public.is_campaign_dm(campaign_id))
  with check (source_type = 'custom' and public.is_campaign_dm(campaign_id));

create policy "a DM can delete their campaign's custom assets"
  on public.asset_library for delete
  to authenticated
  using (source_type = 'custom' and public.is_campaign_dm(campaign_id));
