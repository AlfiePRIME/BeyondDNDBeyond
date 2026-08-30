-- Enemy tokens show a hover-name/level via map_tokens.npc_name (no
-- restriction). A PARTY token belonging to someone else never did: GameRoom.
-- tsx's token-building code (the `name: character?.name ?? token.npc_name ??
-- undefined` line) reads from the SAME per-viewer, characters-RLS-filtered
-- `characters` array the HP bar already reads from — 0008's "owner or
-- campaign DM can read a character" policy is deliberately narrower than
-- campaign membership, so another player's row simply never comes back at
-- all for a non-owner, non-DM viewer. That's correct and unchanged here:
-- ability scores, inventory, spells, HP, everything else on `characters`
-- stays exactly as private as it is today.
--
-- This is the map_transition_anchors (0095) pattern applied to `characters`
-- instead of `map_transitions`: a narrow view exposing ONLY the couple of
-- columns that legitimately need campaign-wide visibility (here: id/name/
-- level, for a hover label), scoped to "any member of this campaign"
-- (is_campaign_member, 0004) rather than the underlying table's
-- owner-or-DM-only policy.
--
-- Same reasoning as 0095's own doc comment on why this does NOT rely on
-- characters' own RLS at all: a view runs as its OWNER for permission
-- purposes, not the querying role, so `characters`' RLS is bypassed
-- entirely once selecting through this view — and in any case Postgres RLS
-- policies can only be attached to TABLES, never views. The `where` clause
-- below (backed by the security-definer is_campaign_member, so it isn't
-- itself blocked by campaign_members' own RLS) is therefore the ENTIRE
-- access check for this view, evaluated fresh per row against the real
-- caller's auth.uid() — not a widening of characters' own policy, a
-- completely separate and deliberately narrower one.
create or replace view public.character_roster_names as
  select id, campaign_id, name, level
  from public.characters
  where public.is_campaign_member(campaign_id);

grant select on public.character_roster_names to authenticated;
