-- Prompt 8a: per-member dice-tray-model preference — data/plumbing only,
-- no multi-instance rendering or upload UI yet (that's Prompt 8b). Stores
-- which model a member's own personal dice tray should use once Prompt 8b
-- mounts one DiceTumble instance per connected member: the built-in
-- procedural tray ('default', DiceTumble.tsx's own DiceTray mesh, exactly
-- today's only tray), or a custom uploaded model ('custom', a reference
-- into asset_library — see below for why that table specifically).
--
-- A plain pair of columns on campaign_members, not a new table: the exact
-- same reasoning 0044_seat_offsets.sql's own comment already laid out for
-- seat_offset — this is a per-(campaign_id, user_id) attribute, and
-- campaign_members is already that grain's one and only owner (its own
-- `unique (campaign_id, user_id)` constraint, 0003). A member's tray choice
-- is scoped to one campaign, not global across every campaign they belong
-- to, for the same reason asset_library's own custom rows are campaign-
-- scoped (0014): a custom tray model a DM uploads for their table lives in
-- THAT campaign's asset library, and a member's preference pointing at it
-- only ever makes sense within that same campaign.
--
-- dice_tray_source/dice_tray_asset_id, not one jsonb blob: unlike
-- seat_offset (a same-shaped dx/dz/dRotationY triple with no cross-table
-- reference), "which asset" here is a real foreign key into asset_library
-- — jsonb can't express or enforce that relationship. This instead mirrors
-- profiles' avatar_source/avatar_ref pairing (0010): a source discriminator
-- plus a matching paired CHECK so the two can never drift apart (a ref
-- without 'custom', or 'custom' without a ref, would be unreadable/
-- ambiguous). NULL dice_tray_source (never touched, or explicitly cleared)
-- means the default procedural tray — the same "row absent means default"
-- shape getForwardOffsetDeg/getSeatOffset already use, and exactly today's
-- only rendering behavior for every existing member.
--
-- on delete restrict (not cascade/set null): the map_objects.asset_id
-- precedent (0014) — deleting an asset that a member's tray preference
-- currently points at should be a deliberate action (clear the preference
-- first), not a silent side effect that would otherwise also have to reset
-- dice_tray_source back to null to keep the paired CHECK below satisfied.
alter table public.campaign_members
  add column if not exists dice_tray_source text
    check (dice_tray_source in ('default', 'custom')),
  add column if not exists dice_tray_asset_id uuid
    references public.asset_library (id) on delete restrict;

alter table public.campaign_members
  add constraint campaign_members_dice_tray_asset_requires_custom
    check (
      (dice_tray_source = 'custom' and dice_tray_asset_id is not null)
      or (dice_tray_source is distinct from 'custom' and dice_tray_asset_id is null)
    );

-- No new RLS, same reasoning as 0044_seat_offsets.sql: campaign_members'
-- existing "a member can update their own membership row" policy (0004) is
-- a blanket USING/WITH CHECK (user_id = auth.uid()) with no column-level
-- restriction, already covering these two brand new columns on the same
-- row. The existing "members can read their campaign's roster" SELECT
-- policy already covers reading every member's tray choice back too — this
-- is shared, visible table state (everyone sees everyone else's dice tray),
-- not private data, matching seat_offset and every other roster field.
