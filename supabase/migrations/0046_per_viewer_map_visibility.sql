-- Per-viewer map transitions: a player whose own character's token has
-- moved (via a solo map_transitions crossing — see mapTransitions.ts's
-- transitionMapToken) to a map that ISN'T campaigns.live_map must still be
-- able to read that map: its own terrain, objects, tokens, and light
-- sources, so their own client can render it. Before this, can_read_map's
-- member branch only ever allowed the campaign's single current live_map —
-- exactly right for "the party never split up" (the common case, left
-- unchanged), but a hard read-block for anyone who has split off.
--
-- Extended, not replaced: the live_map branch stays exactly as it was, so a
-- token-less member (nobody has placed their character yet, or a spectator)
-- keeps seeing exactly the shared default map, unchanged. The new branch
-- ADDITIONALLY allows a map with one of the caller's own character's
-- tokens on it — "wherever my character actually is" — regardless of
-- whether that map happens to be the campaign-wide live_map.
--
-- This is deliberately map-level, not row-level: once a member can read a
-- map at all (because it's the shared live_map OR their own token is on
-- it), they read EVERYTHING on it (every other token, every object, every
-- cell) — the same "presentation masking, not an RLS security boundary"
-- posture this app already takes for vision (see GameRoom.tsx's own
-- extensive comment on visionMasking): a player alone on a map with a
-- DM-placed monster needs to actually see that monster to play, and this
-- trusted-friend-group app was never trying to hide it at the database
-- layer regardless.
--
-- can_read_map is already SECURITY DEFINER (0015) — the map_tokens/
-- characters join below runs with the function owner's bypass-RLS
-- privileges, the same reasoning can_write_map_token (0019) already
-- established for joining characters directly inside a security-definer
-- predicate. No circularity: map_tokens' own SELECT policy calls
-- can_read_map, but a SECURITY DEFINER invocation never re-enters its
-- caller's own RLS evaluation for the queries it runs internally.
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
        or (
          public.is_campaign_member(m.campaign_id)
          and (
            c.live_map = m.id
            or exists (
              select 1
              from public.map_tokens mt
              join public.characters ch on ch.id = mt.character_id
              where mt.map_id = m.id
                and ch.owner_id = auth.uid()
            )
          )
        )
      )
  );
$$;

-- campaign_maps' own SELECT policy (0015) duplicated this exact predicate
-- inline instead of calling the helper above (map_cells/map_objects/
-- map_tokens/light_sources all already do). Replaced with a call to
-- can_read_map(id) — functionally identical to the old inline condition,
-- plus the new "my own token is here" branch for free, and one fewer place
-- for the "who can read a map" rule to ever drift out of sync.
drop policy if exists "DM reads every map in their campaign, others only the live map" on public.campaign_maps;

create policy "a map is readable per can_read_map"
  on public.campaign_maps for select
  to authenticated
  using (public.can_read_map(id));
