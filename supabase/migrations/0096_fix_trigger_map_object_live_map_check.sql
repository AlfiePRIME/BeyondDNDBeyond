-- Fixes a real regression in trigger_map_object (0018, last redefined by
-- 0063): its own hand-rolled "can this non-DM caller read this map" check
-- inlined a literal v_live_map = v_map_id equality instead of calling
-- can_read_map. That was correct when 0018 was written, but 0048 (per-viewer
-- map visibility) later extended can_read_map to ALSO allow a member to
-- read a map their own character's token is currently on, even when that
-- map isn't campaigns.live_map — and trigger_map_object was never updated
-- to match, both here in 0063's own rewrite and originally in 0018.
--
-- Net effect: any player whose token has moved to a map other than the
-- DM's own current live_map could never trigger ANY object on their own
-- current map, playerTriggerable/revealed_to_players or not — a move onto
-- (or click of) a reveal_text/reveal_image/etc. object just silently did
-- nothing, exactly the real report this fixes ("players can't reveal
-- text/images... it just blocks the move and does nothing").
--
-- Everything else below is unchanged from 0063 — only the stale live-map
-- equality is replaced with can_read_map(v_map_id), which already
-- subsumes it (can_read_map's own live-map branch is untouched, this just
-- ALSO recognizes "my own token is on this map").
create or replace function public.trigger_map_object(p_object_id uuid, p_triggered boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_map_id uuid;
  v_campaign_id uuid;
  v_config jsonb;
  v_revealed boolean;
begin
  select o.map_id, m.campaign_id, o.behavior_config, o.revealed_to_players
    into v_map_id, v_campaign_id, v_config, v_revealed
  from public.map_objects o
  join public.campaign_maps m on m.id = o.map_id
  where o.id = p_object_id;

  if v_map_id is null then
    raise exception 'Object not found';
  end if;

  if v_config->>'action' is null then
    raise exception 'This object has no configured action';
  end if;

  if not public.is_campaign_dm(v_campaign_id) then
    -- A non-DM may trigger only what they can legitimately see: can_read_map
    -- already encodes "DM, or member on the live map, or member whose own
    -- token is on this exact map" (0048) — the same rule that decides
    -- whether this viewer can even SEE the object at all — plus the object
    -- having actually been revealed, plus its own playerTriggerable opt-in.
    if not (
      public.can_read_map(v_map_id)
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
