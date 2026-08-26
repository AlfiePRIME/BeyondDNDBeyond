-- Prompt 10 (Map Editor Extensions plan) — mid-session map grid growth. A DM
-- can widen a live map by choosing WHICH edge grows (north/south/east/west),
-- not just always extending outward from wherever the grid currently maxes
-- out — a spell that creates new ground, or a DM extending the map live
-- during a session, can need new cells on any side.
--
-- East/south growth is a pure grid_width/grid_height bump: every already-
-- placed cell/object/token keeps its stored x/y exactly as-is, since the new
-- cells simply extend past the existing max index. West/north growth is the
-- hard case — the grid's (0,0) origin itself moves, so every existing
-- cell/object/token's x (west) or y (north) has to shift by the same amount
-- for its real position relative to the rest of the map to stay put, even
-- though every one of its stored coordinates just changed. All of it happens
-- in one plpgsql function so a mid-operation failure (a bad edge, a
-- concurrent conflicting write) can never leave some rows shifted and others
-- not — Postgres runs a single function invocation as part of the caller's
-- one statement/transaction, so either the whole body commits or none of it
-- does.
--
-- No SECURITY DEFINER: campaign_maps/map_cells/map_objects/map_tokens' own
-- RLS (0015/0019) already restricts every statement below to this map's
-- DM — apply_hp_delta's (0028) plain-RLS-through precedent, not
-- trigger_map_object's bypass-and-recheck one, since nothing here needs
-- authorization narrower or different from what those policies already
-- express: growing the grid is exactly a campaign_maps UPDATE plus writes to
-- map_cells/map_objects/map_tokens for that same map, and can_write_map is
-- already DM-only for all four.
create or replace function public.grow_map_grid(
  p_map_id uuid,
  p_edge text,
  p_amount integer
)
returns public.campaign_maps
language plpgsql
set search_path = public
as $$
declare
  v_map public.campaign_maps;
  v_dx integer := 0;
  v_dy integer := 0;
begin
  if p_edge not in ('north', 'south', 'east', 'west') then
    raise exception 'Edge must be north, south, east, or west';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Growth amount must be a positive integer';
  end if;

  -- Locks the row for the rest of this transaction, so two near-simultaneous
  -- grows of the same map (start_session's row-lock precedent, 0013)
  -- serialize instead of the second racing the first with a stale
  -- grid_width/grid_height read. This SELECT only proves the map exists and
  -- is READABLE by the caller (campaign_maps' SELECT policy also lets a
  -- member read the campaign's current live map) — it does NOT by itself
  -- prove the caller may WRITE it; see the `not found` check after the
  -- final UPDATE below for that.
  select * into v_map
  from public.campaign_maps
  where id = p_map_id
  for update;

  if not found then
    -- RLS makes "doesn't exist" and "not yours to even see" indistinguishable
    -- here, same opacity as getMap's null.
    raise exception 'Map not found, or you may not resize it';
  end if;

  if p_edge = 'west' then
    v_dx := p_amount;
  elsif p_edge = 'north' then
    v_dy := p_amount;
  end if;

  if v_dx <> 0 or v_dy <> 0 then
    -- Re-indexes every existing cell so the new (0,0) origin lands
    -- correctly. A plain `update map_cells set x = x + v_dx` cannot be used
    -- here: map_cells' primary key is (map_id, x, y), and Postgres checks
    -- that constraint as each row is rewritten — a positive shift smaller
    -- than the grid's own width/height would transiently collide a
    -- just-shifted row with an as-yet-unshifted row still sitting on the
    -- key it's about to move onto (e.g. growing west by 1 on a 5-wide grid
    -- moves x=0 to x=1, which the still-unprocessed original x=1 row still
    -- occupies at that instant). Deleting every row for this map first
    -- (freeing every key at once) and only then inserting the shifted rows
    -- sidesteps that entirely: the INSERT never runs until the DELETE has
    -- fully cleared the table for this map, so there is no instant where
    -- two rows share a key. For a caller who can't write this map, RLS
    -- filters the DELETE to zero rows, so `removed` is empty and the INSERT
    -- that follows is a harmless no-op.
    with removed as (
      delete from public.map_cells
      where map_id = p_map_id
      returning x, y, elevation, terrain_type, light_level
    )
    insert into public.map_cells (map_id, x, y, elevation, terrain_type, light_level)
    select p_map_id, x + v_dx, y + v_dy, elevation, terrain_type, light_level
    from removed;

    -- map_objects and map_tokens are keyed by their own uuid `id` — x/y
    -- carry no uniqueness constraint on either table, so a plain shift
    -- (unlike map_cells above) can never collide mid-update. Same harmless
    -- zero-rows-affected outcome for a caller who can't write this map.
    update public.map_objects
    set x = x + v_dx, y = y + v_dy
    where map_id = p_map_id;

    update public.map_tokens
    set x = x + v_dx, y = y + v_dy
    where map_id = p_map_id;
  end if;

  update public.campaign_maps
  set grid_width = grid_width + case when p_edge in ('east', 'west') then p_amount else 0 end,
      grid_height = grid_height + case when p_edge in ('north', 'south') then p_amount else 0 end
  where id = p_map_id
  returning * into v_map;

  if not found then
    -- The initial SELECT above only proves the caller can READ this map —
    -- campaign_maps' SELECT policy is broader than its UPDATE one (a member
    -- can read the campaign's live map; only the DM can write it). A non-DM
    -- caller reaches this exact point having had every statement above
    -- silently affect zero rows (map_cells/map_objects/map_tokens' RLS is
    -- exactly as DM-only as campaign_maps' own UPDATE policy, so nothing
    -- was actually shifted either) — this turns that silent no-op into the
    -- same raised exception a nonexistent map gets, rather than deceptively
    -- returning the unchanged row as if the grow had succeeded.
    raise exception 'Map not found, or you may not resize it';
  end if;

  return v_map;
end;
$$;

grant execute on function public.grow_map_grid(uuid, text, integer) to authenticated;
