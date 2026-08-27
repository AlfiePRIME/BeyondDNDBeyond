-- Weather & Enemies C4: firestorm/acid_storm's optional periodic damage.
--
-- Follows the exact "DM-client-resolves-authoritatively" model already
-- established by handleTokenLanded's fall-damage/step-on-trigger resolution
-- (GameRoom.tsx) -- confirmed there is no server-side scheduler/cron/
-- background-job system of any kind anywhere in this app (the only
-- setInterval in room/scene code is whiteboard stroke-flush batching,
-- unrelated to gameplay), so the DM's own connected client is the only
-- thing that ever calls this RPC, on a plain client-side setInterval
-- (GameRoom.tsx's WEATHER_TICK_INTERVAL_MS).
--
-- The interval/dedup problem this RPC exists to solve: nothing here trusts
-- client wall-clock timing to decide WHETHER a tick is actually due --
-- weather_last_tick_at (added below) is the one authoritative "last
-- applied" timestamp, and apply_weather_tick is the only path that ever
-- advances it. Two nearly-simultaneous callers (the same DM open in two
-- tabs, a page-reload starting a fresh setInterval while the old tab's
-- timer is still in flight, or -- however unlikely -- two campaign members
-- both holding the 'dm' role) race for the SAME row lock (`for update`
-- below); whichever wins sees the elapsed time since the last tick and, if
-- it's genuinely due, both marks it ticked AND applies the damage in the
-- SAME transaction. The loser, once it acquires the lock, re-reads the
-- now-just-updated weather_last_tick_at, finds the interval hasn't elapsed,
-- and returns an empty set -- a clean no-op, never a second application.
-- This same gate is also what makes a stray call arriving just after the DM
-- toggles mechanical off harmless: it re-checks weather_kind/
-- weather_mechanical from the DB under the same lock, never from whatever
-- the calling client's React state happened to be when it queued the call
-- -- so damage can never leak past the moment the weather actually changed
-- in the database.
--
-- No catch-up on reconnect, by construction: however much wall-clock time
-- has passed since weather_last_tick_at (seconds, or the entire time the DM
-- was disconnected -- ticking simply pauses while no DM client is
-- connected, the project owner's explicitly accepted v1 limitation), a
-- single call only ever applies ONE tick's worth of damage, never one per
-- missed interval.
alter table public.campaigns
  add column if not exists weather_last_tick_at timestamptz null;

-- SECURITY INVOKER (the default, same as apply_hp_delta) -- every table
-- this touches (campaigns, map_tokens, characters) already has RLS that
-- permits exactly the access a real DM caller needs here, so there is no
-- cross-row invariant that requires bypassing RLS the way advance_turn's
-- SECURITY DEFINER does. The explicit is_campaign_dm check below isn't
-- strictly load-bearing for the characters loop (apply_hp_delta already
-- refuses any character outside the caller's own or a campaign they DM),
-- but it protects THIS function's own bookkeeping write
-- (weather_last_tick_at) with a clear, fast error instead of a silent
-- zero-rows-affected UPDATE if a non-DM member ever called this directly.
create or replace function public.apply_weather_tick(p_campaign_id uuid)
returns setof public.characters
language plpgsql
set search_path = public
as $$
declare
  v_campaign public.campaigns;
  v_damage integer;
  v_char_id uuid;
  v_updated public.characters;
begin
  if not public.is_campaign_dm(p_campaign_id) then
    raise exception 'Only the campaign''s DM can resolve weather damage';
  end if;

  select * into v_campaign
  from public.campaigns
  where id = p_campaign_id
  for update;

  if not found then
    raise exception 'Campaign not found';
  end if;

  -- The database is the authority on "is mechanical weather even active
  -- right now" -- not whatever the calling client's React state was when it
  -- scheduled this call. A tick queued a moment before the DM turns
  -- mechanical off (or changes weather entirely) lands here and does
  -- nothing.
  if v_campaign.weather_kind not in ('firestorm', 'acid_storm') or not v_campaign.weather_mechanical then
    return;
  end if;

  -- 27s tolerance under the real 30s interval (GameRoom.tsx's
  -- WEATHER_TICK_INTERVAL_MS -- see its own doc comment for the full
  -- reasoning on why 30s): absorbs ordinary client-side setInterval
  -- jitter/early-fire without opening a window wide enough for a genuine
  -- second tick to sneak in before the next one is really due.
  if v_campaign.weather_last_tick_at is not null
     and now() - v_campaign.weather_last_tick_at < interval '27 seconds' then
    return;
  end if;

  -- A small, deliberately non-swingy FLAT amount -- no randomness, so every
  -- tick's outcome is deterministic and easy to reason about mid-session
  -- (including in this feature's own automated verification). Same for
  -- both firestorm and acid_storm: neither is called out anywhere in this
  -- feature's own spec as more dangerous than the other.
  v_damage := 2;

  update public.campaigns
  set weather_last_tick_at = now()
  where id = p_campaign_id;

  if v_campaign.live_map is not null then
    for v_char_id in
      select distinct character_id
      from public.map_tokens
      where map_id = v_campaign.live_map
        and character_id is not null
    loop
      select * into v_updated from public.apply_hp_delta(v_char_id, -v_damage);
      return next v_updated;
    end loop;
  end if;

  return;
end;
$$;

grant execute on function public.apply_weather_tick(uuid) to authenticated;
