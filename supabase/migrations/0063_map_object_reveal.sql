-- Map Editor Batch A10: live object placement + staged reveal from the Game
-- Room. Until now every map_objects row was visible to any campaign member
-- who could already read its map at all (0015's "read an object iff its map
-- is readable" policy) — there was no way for a DM to add something to the
-- live map without every connected player seeing it appear immediately.
--
-- revealed_to_players defaults to TRUE so every object placed before this
-- migration, and every object placed through the pre-existing Map Editor
-- route (createMapObject's other callers there never pass
-- revealedToPlayers), keeps rendering exactly as it always has — only the
-- NEW Game Room live-placement path (GameRoom.tsx's handlePlaceLiveObject)
-- explicitly inserts FALSE.
alter table public.map_objects
  add column if not exists revealed_to_players boolean not null default true;

-- Replaces 0015's "read an object iff its map is readable" policy: the DM
-- (can_write_map — is_campaign_dm for the map's own owning campaign) always
-- sees every object regardless of the flag, for prep; a member only once
-- BOTH the map itself is readable to them (can_read_map's pre-existing "DM,
-- or member viewing the live map" check) AND the object has actually been
-- revealed.
drop policy if exists "read an object iff its map is readable" on public.map_objects;

create policy "read an object iff its map is readable and (DM or revealed)"
  on public.map_objects for select
  to authenticated
  using (
    public.can_write_map(map_id)
    or (public.can_read_map(map_id) and revealed_to_players)
  );

-- trigger_map_object (0018) is a SECURITY DEFINER RPC that does not go
-- through the SELECT policy above at all — without this, a non-DM member
-- could trigger a still-unrevealed, playerTriggerable object by calling the
-- RPC directly with a guessed/leaked id, bypassing the read-side fix
-- entirely. Adds the same revealed_to_players requirement to the existing
-- non-DM branch rather than leaving this as an unfixed corner of the same
-- gap.
create or replace function public.trigger_map_object(p_object_id uuid, p_triggered boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_map_id uuid;
  v_campaign_id uuid;
  v_live_map uuid;
  v_config jsonb;
  v_revealed boolean;
begin
  select o.map_id, m.campaign_id, c.live_map, o.behavior_config, o.revealed_to_players
    into v_map_id, v_campaign_id, v_live_map, v_config, v_revealed
  from public.map_objects o
  join public.campaign_maps m on m.id = o.map_id
  join public.campaigns c on c.id = m.campaign_id
  where o.id = p_object_id;

  if v_map_id is null then
    raise exception 'Object not found';
  end if;

  if v_config->>'action' is null then
    raise exception 'This object has no configured action';
  end if;

  if not public.is_campaign_dm(v_campaign_id) then
    -- A non-DM may trigger only what they can legitimately see: member of
    -- the campaign, the object's map is the live one (matching
    -- can_read_map's member branch), the object has actually been revealed,
    -- and it itself opts in via playerTriggerable.
    if not (
      public.is_campaign_member(v_campaign_id)
      and v_live_map = v_map_id
      and v_revealed
      and coalesce(v_config->>'playerTriggerable', 'false') = 'true'
    ) then
      raise exception 'Only the DM can trigger this object';
    end if;
  end if;

  -- Merging just the 'triggered' key (and requiring a configured action to
  -- still be there) means this function can never touch the authoring
  -- fields, even if a reconfigure raced the trigger.
  update public.map_objects
  set behavior_config = behavior_config || jsonb_build_object('triggered', p_triggered)
  where id = p_object_id
    and behavior_config ? 'action';
end;
$$;

grant execute on function public.trigger_map_object(uuid, boolean) to authenticated;

-- map_object_items (0060): a chest's own item list must stay hidden for
-- exactly as long as the chest itself is unrevealed — otherwise a player
-- could learn (and see the exact contents of) a still-pending chest by
-- querying this table directly, even though map_objects' own row is
-- correctly hidden by the policy above.
drop policy if exists "a member can read a chest's items on the live map" on public.map_object_items;

create policy "a member can read a revealed chest's items on the live map"
  on public.map_object_items for select
  to authenticated
  using (
    map_object_id is not null
    and exists (
      select 1 from public.map_objects o
      where o.id = map_object_items.map_object_id
        and public.can_read_map(o.map_id)
        and o.revealed_to_players
    )
  );

-- claim_map_object_item (0060): same reasoning as trigger_map_object above —
-- a non-DM caller invoking this SECURITY DEFINER RPC directly must not be
-- able to take an item out of a still-unrevealed chest, even with a
-- guessed/leaked item id. A concealed pit's own visibility is a separate,
-- pre-existing DM-only-until-sprung mechanic (0050) entirely untouched by
-- this prompt, so the pit branch is unconditionally treated as "revealed"
-- here — its own gating already happened before a player could ever learn
-- the item's id in the first place (GameRoom.tsx's handleTokenLanded reveal
-- broadcast).
create or replace function public.claim_map_object_item(p_item_id uuid)
returns public.map_object_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.map_object_items;
  v_map_id uuid;
  v_campaign_id uuid;
  v_live_map uuid;
  v_revealed boolean;
begin
  select * into v_item from public.map_object_items where id = p_item_id for update;

  if v_item.id is null then
    raise exception 'Item not found, or already taken';
  end if;

  if v_item.map_object_id is not null then
    select o.map_id, o.revealed_to_players into v_map_id, v_revealed
    from public.map_objects o where o.id = v_item.map_object_id;
  else
    select p.map_id into v_map_id from public.concealed_pits p where p.id = v_item.concealed_pit_id;
    v_revealed := true;
  end if;

  if v_map_id is null then
    raise exception 'Container not found';
  end if;

  select m.campaign_id, c.live_map into v_campaign_id, v_live_map
  from public.campaign_maps m
  join public.campaigns c on c.id = m.campaign_id
  where m.id = v_map_id;

  -- The DM always may; a member only for a REVEALED container on the
  -- currently live map — can_read_map's own member branch, plus the same
  -- revealed_to_players requirement the read-side policy above enforces.
  if not (
    public.is_campaign_dm(v_campaign_id)
    or (public.is_campaign_member(v_campaign_id) and v_live_map = v_map_id and v_revealed)
  ) then
    raise exception 'Not allowed to take this item';
  end if;

  delete from public.map_object_items where id = p_item_id;

  insert into public.interaction_events
    (campaign_id, map_object_id, concealed_pit_id, action_type, tag, actor_user_id)
  values
    (v_campaign_id, v_item.map_object_id, v_item.concealed_pit_id, 'item_taken', v_item.tag, auth.uid());

  return v_item;
end;
$$;

grant execute on function public.claim_map_object_item(uuid) to authenticated;
